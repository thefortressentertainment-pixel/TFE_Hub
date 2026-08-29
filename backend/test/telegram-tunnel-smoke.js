'use strict';
/**
 * telegram-tunnel-smoke.js — functional smoke test for the Telegram tunnel.
 * Runs the REAL poll loop, real mesh executor + aiBridge and the real REST
 * gateway against a local fake Telegram Bot API and a fake DeepSeek — no
 * Postgres/Redis, no external network. Verifies bootstrap, authorization,
 * command flows, AI relay round-trips, outbox push and shutdown.
 */
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const genieMesh = require('../src/genieMesh');
const aiBridge = require('../src/aiBridge');
const telegramTunnel = require('../src/telegramTunnel');

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra ? '→ ' + extra : ''}`); }
}
const waitFor = (fn, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (fn() || Date.now() - t0 > ms) { clearInterval(iv); resolve(); }
  }, 50);
});

const BOT_TOKEN = '123:TEST-TOKEN';
const CHAT = 4242;
const FAKE_TG_PORT = 18903;
const FAKE_AI_PORT = 18904;

// ---- stub pg pool (same shape as mesh-smoke, + commands/sessions/outbox) ----
function makeStubPool() {
  const peers = []; const outbox = []; const aiTasks = []; const commands = [];
  const sessionsOpen = []; let sessionsClosed = 0;
  let nextAiId = 1; let nextOutId = 1; let nextCmdId = 1;
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes('SELECT * FROM genie_peers WHERE name')) {
        const existing = peers.find((p) => p.name === params[0]);
        return { rows: existing ? [existing] : [] };
      }
      if (s.includes('INSERT INTO genie_peers')) {
        const peer = {
          id: crypto.randomUUID(), name: params[0], role: params[1], endpoint_url: params[2],
          api_key_hash: params[3], scope: params[4], enabled: true, satlink: params[5],
          status: 'offline', last_seen_at: null, last_error: null,
        };
        peers.push(peer);
        return { rows: [peer] };
      }
      if (s.includes('SELECT * FROM genie_peers WHERE enabled = TRUE')) return { rows: peers };
      if (s.includes('SELECT * FROM genie_peers WHERE id = $1')) return { rows: peers.filter((p) => p.id === params[0]) };
      if (s.includes('UPDATE genie_peers SET')) return { rows: [] };
      if (s.includes('INSERT INTO genie_commands')) {
        commands.push({ id: nextCmdId++, peer_id: params[0], command: params[1], args: params[2], status: params[4] || 'ok', created_at: new Date() });
        return { rows: [{ id: nextCmdId - 1 }] };
      }
      if (s.includes('INSERT INTO comms_sessions')) {
        const session = { id: crypto.randomUUID(), peer_id: params[0], transport: params[1], status: 'connected' };
        sessionsOpen.push(session);
        return { rows: [session] };
      }
      if (s.includes('SET status') && s.includes('comms_sessions')) {
        sessionsClosed += 1;
        return { rowCount: 1 };
      }
      if (s.includes('INSERT INTO genie_ai_logs') && s.includes('RETURNING *')) {
        // Two writers hit this table: the mesh executor (4 params, literal
        // 'chat') and aiBridge createTask (5 params). Columns are JSONB in
        // real Postgres → parse stored strings so SELECTs return objects.
        const execShape = s.includes("($1, 'chat',");
        const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (err) { return v; } };
        const task = {
          id: nextAiId++, peer_id: params[0],
          task_type: execShape ? 'chat' : params[1],
          model: execShape ? params[1] : params[2],
          state: 'pending',
          prompt: parse(execShape ? params[2] : params[3]),
          options: parse(execShape ? params[3] : params[4]),
        };
        aiTasks.push(task);
        return { rows: [task] };
      }
      if (s.includes('SELECT * FROM genie_ai_logs WHERE id = $1')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        return { rows: t ? [t] : [] };
      }
      if (s.includes("SET state = 'pending'") && s.includes('genie_ai_logs')) return { rowCount: 0 };
      if (s.includes("SET state = 'processing'") && s.includes('genie_ai_logs')) {
        const claimed = aiTasks.filter((t) => t.state === 'pending').slice(0, Number(params[0]) || 5);
        claimed.forEach((t) => { t.state = 'processing'; });
        return { rows: claimed.map((t) => ({ id: t.id, peer_id: t.peer_id, task_type: t.task_type, model: t.model, prompt: t.prompt, options: t.options })) };
      }
      if (s.includes("SET state = 'completed'") && s.includes('genie_ai_logs')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'completed'; t.reply = params[1]; t.usage = params[2]; t.latency_ms = params[3]; }
        return { rowCount: 1 };
      }
      if (s.includes("SET state = 'failed'") && s.includes('genie_ai_logs')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'failed'; t.error = params[1]; t.latency_ms = params[2]; }
        return { rowCount: 1 };
      }
      if (s.includes('genie_ai_logs') && s.includes('GROUP BY state')) {
        const counts = {};
        aiTasks.forEach((t) => { counts[t.state] = (counts[t.state] || 0) + 1; });
        return { rows: Object.entries(counts).map(([state, count]) => ({ state, count })) };
      }
      if (s.includes('INSERT INTO genie_outbox')) {
        const row = { id: nextOutId++, peer_id: params[0], event_type: params[1], payload: params[2], status: 'pending', attempts: 0, created_at: new Date() };
        outbox.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (s.includes('SELECT * FROM genie_outbox') && s.includes("'pending'")) {
        const limit = Number(params[params.length - 1]) || 25;
        return { rows: outbox.filter((o) => o.status === 'pending').slice(0, limit) };
      }
      if (s.includes('UPDATE genie_outbox SET status') && s.includes('delivered') && s.includes('WHERE id IN')) {
        // Real SQL: WHERE id IN ($1,$2,...) → ids arrive as individual params
        // (markOutboxDelivered); flat() also covers deliverBatch's ANY($2) array.
        const ids = params.flat().map(Number);
        outbox.forEach((o) => { if (ids.includes(o.id)) o.status = 'delivered'; });
        return { rowCount: ids.length };
      }
      if (s.includes('SELECT id, transport, status FROM comms_sessions')) {
        return { rows: sessionsOpen.map((x) => ({ id: x.id, transport: x.transport, status: x.status })) };
      }
      if (s.includes('SELECT id, name, role, scope')) {
        return { rows: peers.map((p) => ({ id: p.id, name: p.name, role: p.role, scope: p.scope, status: p.status })) };
      }
      if (s.includes('SELECT id, name, monthly_budget, created_at FROM profiles')) {
        return { rows: [{ id: 'p1', name: 'Business', monthly_budget: 1000, created_at: new Date() }] };
      }
      if (s.includes('SELECT status, COUNT(*)::int AS count FROM genie_outbox') && s.includes('GROUP BY status')) {
        const counts = {};
        outbox.filter((o) => o.peer_id === params[0]).forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
        return { rows: Object.entries(counts).map(([status, count]) => ({ status, count })) };
      }
      if (s.includes('SELECT id, event_type, payload, attempts, created_at FROM genie_outbox') && s.includes("'pending'")) {
        const limit = Number(params[0]) || 20;
        return { rows: outbox.filter((o) => o.status === 'pending').slice(0, limit) };
      }
      if (s.includes("SET status = 'sending'") && s.includes('WHERE id IN')) {
        // claimOutbox's claim UPDATE: individual id params, not an array.
        const ids = params.flat().map(Number);
        outbox.forEach((o) => { if (ids.includes(o.id)) o.status = 'sending'; });
        return { rowCount: ids.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  pool.__peers = peers; pool.__outbox = outbox; pool.__aiTasks = aiTasks;
  pool.__commands = commands;
  pool.__sessionsOpen = sessionsOpen;
  pool.__sessionsClosed = () => sessionsClosed;
  return pool;
}

// ---- fake Telegram Bot API ----
const updateQueue = [];
const sent = [];
let webhookDeleted = false;
const fakeTelegram = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = String(req.url).match(/^\/bot[^/]+\/(\w+)/);
    const method = m ? m[1] : '';
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
    const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'JARV Genie Relay', username: 'jarv_genie_relay_bot' } });
    if (method === 'deleteWebhook') { webhookDeleted = true; return reply({ ok: true, result: true }); }
    if (method === 'getUpdates') return reply({ ok: true, result: updateQueue.splice(0, updateQueue.length) });
    if (method === 'sendMessage') {
      sent.push({ chat_id: parsed.chat_id, text: parsed.text });
      return reply({ ok: true, result: { message_id: sent.length + 1, chat: { id: parsed.chat_id } } });
    }
    if (method === 'getChat') return reply({ ok: true, result: { id: parsed.chat_id || CHAT } });
    return reply({ ok: false, error_code: 404, description: `Not Found: ${method}` });
  });
});

// ---- fake DeepSeek (fallback chain: deepseek-v4 → deepseek-chat) ----
const fakeDeepSeek = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
    if (parsed.model === 'deepseek-v4') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { message: 'Model Not Exist' } }));
    }
    res.statusCode = 200;
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: `pong from ${parsed.model}` } }],
      model: parsed.model,
      usage: { prompt_tokens: 8, completion_tokens: 11, prompt_cache_hit_tokens: 0 },
    }));
  });
});

async function main() {
  await new Promise((r) => fakeTelegram.listen(FAKE_TG_PORT, r));
  await new Promise((r) => fakeDeepSeek.listen(FAKE_AI_PORT, r));
  console.log(`[1] Fake Telegram API on :${FAKE_TG_PORT}, fake DeepSeek on :${FAKE_AI_PORT}`);

  console.log('[2] Building mesh + aiBridge (stubbed DB, real poll loop)');
  const stub = makeStubPool();
  const ai = aiBridge.makeAiBridge({
    pool: stub, log: () => {},
    config: {
      enabled: true, apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${FAKE_AI_PORT}/v1`, model: 'deepseek-v4',
      fallbackModels: 'deepseek-chat,deepseek-reasoner', free: true, auto: false,
    },
    getMesh: () => mesh,
  });
  const mesh = genieMesh.makeMesh({
    pool: stub, log: () => {}, ai,
    config: { enabled: true, socket: false, httpFlush: false, inboundKey: 'peer-secret', outboundUrl: '' },
  });
  await mesh.start();

  console.log('[3] REST gateway smoke (/health-comms + AI endpoints)');
  const app = express();
  app.use(express.json());
  app.use('/api/genie', genieMesh.createGenieApi({ pool: stub, mesh, rateLimit: () => ({ blocked: false }) }));
  const gw = app.listen(0);
  await new Promise((r) => gw.on('listening', r));
  const base = `http://127.0.0.1:${gw.address().port}/api/genie`;
  const get = async (p) => { const r = await fetch(base + p, { headers: { 'X-Genie-Key': 'peer-secret' } }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genie-Key': 'peer-secret' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

  const hc = await get('/health-comms');
  check('/health-comms live (satellite keepalive)', hc.status === 200 && hc.body.ok === true
    && typeof hc.body.backlog === 'number' && ['land', 'sat'].includes(hc.body.mode)
    && typeof hc.body.link === 'string');
  const rtask = await post('/ai/task', { prompt: 'gateway smoke' });
  check('REST /ai/task queues durable task', rtask.status === 200 && typeof rtask.body.taskId === 'number');
  await ai.processPendingBatch();
  const rget = await get(`/ai/task/${rtask.body.taskId}`);
  check('REST /ai/task/:id completed via relay', rget.status === 200 && rget.body.task.state === 'completed');

  console.log('[4] Tunnel construction + start (real poll loop, fake API)');
  check('factory returns null without token', telegramTunnel.makeTelegramTunnel({ pool: stub, mesh, log: () => {}, config: {} }) === null);
  const tunnel = telegramTunnel.makeTelegramTunnel({
    pool: stub, mesh, log: () => {},
    config: {
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ALLOWED_CHATS: String(CHAT),
      TELEGRAM_API_BASE: `http://127.0.0.1:${FAKE_TG_PORT}`,
      TELEGRAM_POLL_SECONDS: '0',   // return immediately; the loop self-paces
      TELEGRAM_IDLE_MS: '20',
      TELEGRAM_TASK_WATCH_MS: '250',
    },
  });
  check('tunnel factory builds with token', !!tunnel);
  await tunnel.start();
  await waitFor(() => tunnel.getStatus().running === true, 3000);
  check('poll loop running', tunnel.getStatus().running === true);
  check('deleteWebhook called (long-poll exclusivity)', webhookDeleted === true);
  check('tunnel registered as mesh peer', stub.__peers.some((p) => p.name === 'telegram-relay'));
  check('long-poll comms session opened', stub.__sessionsOpen.some((x) => x.transport === 'telegram-longpoll'));
  console.log('[5] Authorized command flows via the real poll loop');
  let updateId = 10;
  const feed = (text, chatId) => new Promise((resolve) => {
    updateQueue.push({ update_id: updateId++, message: { chat: { id: chatId }, text, from: { username: 'tfe' } } });
    const before = sent.length;
    waitFor(() => sent.length > before, 6000).then(resolve);
  });

  await feed('/start', CHAT);
  check('/start welcome', sent.some((x) => x.chat_id === CHAT && x.text.includes('JARV-Genie tunnel online')));

  await feed('hello genie', CHAT);
  const chatMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  check('free text → AI relay reply', !!chatMsg && chatMsg.text.includes('pong from deepseek-chat'), chatMsg && chatMsg.text);

  await feed('/status', CHAT);
  const stMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  check('/status shows Comms + AI', !!stMsg && stMsg.text.includes('Comms') && stMsg.text.includes('AI'));

  await feed('/peer', CHAT);
  const peerMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  check('/peer lists seeded peers', !!peerMsg && peerMsg.text.includes('jarv-genie') && peerMsg.text.includes('telegram-relay'));

  await feed('/task write me a poem', CHAT);
  const taskMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  const queuedId = taskMsg && (String(taskMsg.text).match(/Task <code>(\d+)<\/code>/) || [])[1];
  check('/task queues durable task', !!queuedId, taskMsg && taskMsg.text);
  await ai.processPendingBatch();
  await tunnel.drainTaskWatchers();
  const doneMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  check('task watcher pushes completed reply', !!doneMsg && doneMsg.text.includes('pong from deepseek-chat'), doneMsg && doneMsg.text);

  await feed('/bogus', CHAT);
  const bogusMsg = sent.filter((x) => x.chat_id === CHAT).pop();
  check('unknown command → error reply', !!bogusMsg && bogusMsg.text.includes('unknown command'));

  console.log('[6] Authorization + outbox push');
  const authBefore = sent.length;
  await feed('/status', 999);
  check('unauthorized chat gets no reply', sent.length === authBefore);
  check('commands audited in genie_commands', stub.__commands.some((c) => c.command === 'bogus') && stub.__commands.length >= 1);

  await mesh.emit('receipt.uploaded', { vendor: 'Test Cafe', total: 12.5 });
  const pushed = await tunnel.pushOutboxToChats();
  check('outbox event pushed to registered chat', pushed >= 1 && sent.some((x) => x.chat_id === CHAT && x.text.includes('receipt.uploaded')));
  check('pushed events marked delivered', stub.__outbox.every((o) => o.status === 'delivered'));

  console.log('[7] Status + shutdown');
  const tg = tunnel.getStatus();
  check('status: running long-poll tunnel', tg.enabled && tg.running && tg.mode === 'longpoll-outbound');
  check('status: traffic counted', tg.updatesReceived >= 7 && tg.messagesSent >= 6, JSON.stringify({ u: tg.updatesReceived, m: tg.messagesSent }));
  check('status: authorized chat registered', tg.authorizedChats === 1);
  check('status: last command tracked', !!tg.lastCommand && typeof tg.lastCommand.command === 'string');

  await tunnel.stop();
  check('stop closes comms session', stub.__sessionsClosed() === 1);
  check('stop halts poll loop', tunnel.getStatus().running === false);

  console.log('[8] Bootstrap mode (no allowlist → /start reveals chat id)');
  const boot = telegramTunnel.makeTelegramTunnel({
    pool: stub, mesh, log: () => {},
    config: {
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_BASE: `http://127.0.0.1:${FAKE_TG_PORT}`,
      TELEGRAM_PEER_NAME: 'telegram-relay-boot',
      TELEGRAM_POLL_SECONDS: '0', TELEGRAM_IDLE_MS: '20', TELEGRAM_TASK_WATCH_MS: '250',
    },
  });
  await boot.start();
  const bBefore = sent.length;
  updateQueue.push({ update_id: 9001, message: { chat: { id: 777 }, text: '/start', from: { username: 'newbie' } } });
  await waitFor(() => sent.length > bBefore, 4000);
  const bootMsg = sent.filter((x) => x.chat_id === 777).pop();
  check('bootstrap /start replies with chat id', !!bootMsg && String(bootMsg.text).includes('777'), bootMsg && bootMsg.text);
  const bootBefore = sent.length;
  updateQueue.push({ update_id: 9002, message: { chat: { id: 777 }, text: '/status', from: { username: 'newbie' } } });
  await waitFor(() => sent.length > bootBefore, 1500);
  check('bootstrap mode ignores non-/start', sent.length === bootBefore);
  await boot.stop();

  mesh.stop();
  ai.stop();
  gw.close();
}

main().then(() => {
  fakeTelegram.close();
  fakeDeepSeek.close();
  console.log('\n==============================');
  console.log(failed === 0 ? 'ALL TELEGRAM TUNNEL SMOKE TESTS PASSED' : `${failed} TEST(S) FAILED`);
  console.log('==============================\n');
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error('TELEGRAM TUNNEL SMOKE CRASHED:', e);
  process.exit(1);
});


