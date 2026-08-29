'use strict';
/**
 * ai-bridge-smoke.js — functional smoke test for the Genie AI relay WITHOUT
 * Postgres/Redis and WITHOUT hitting the real DeepSeek API. It runs a local
 * fake "DeepSeek" HTTP server so the real provider + fallback chain, the
 * durable task queue, mesh emitTo, and the REST gateway are all exercised.
 */
const crypto = require('crypto');
const http = require('http');
const aiBridge = require('../src/aiBridge');
const genieMesh = require('../src/genieMesh');

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra ? '→ ' + extra : ''}`); }
}

// Emulate Postgres JSONB round-trip: params bound to jsonb columns come back
// from pg as parsed JS values, not the JSON text we sent.
function jsonb(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}

// ---- stub pg Pool ----
function makeStubPool() {
  const peers = [];
  const aiTasks = [];
  const outbox = [];
  let nextAiId = 1;
  const pool = {
    async query(sql, params) {
      if (sql.includes('SELECT * FROM genie_peers WHERE name')) return { rows: [] };
      if (sql.includes('INSERT INTO genie_peers')) {
        const peer = {
          id: crypto.randomUUID(), name: params[0], role: params[1], endpoint_url: params[2],
          api_key_hash: params[3], scope: params[4], enabled: true, satlink: params[5],
          status: 'offline', last_seen_at: null, last_error: null,
        };
        peers.push(peer);
        return { rows: [peer] };
      }
      if (sql.includes('SELECT * FROM genie_peers WHERE enabled = TRUE')) return { rows: peers };
      if (sql.includes('UPDATE genie_peers SET status')) return { rows: [] };
      if (sql.includes('INSERT INTO genie_ai_logs') && sql.includes('RETURNING *')) {
        // Two INSERT shapes exist: aiBridge.createTask binds 5 params
        // (peer, taskType, model, prompt, options); the mesh 'ai.task'
        // executor binds 4 (peer, model, prompt, options) with 'chat' inline.
        const five = params.length >= 5;
        const task = {
          id: nextAiId++,
          peer_id: params[0],
          task_type: five ? params[1] : 'chat',
          model: five ? params[2] : params[1],
          state: 'pending',
          prompt: jsonb(five ? params[3] : params[2]),
          options: jsonb(five ? params[4] : params[3]),
        };
        aiTasks.push(task);
        return { rows: [task] };
      }
      if (sql.includes('SELECT * FROM genie_ai_logs WHERE id = $1')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        return { rows: t ? [t] : [] };
      }
      if (sql.includes("SET state = 'processing'")) {
        const claimed = aiTasks.filter((t) => t.state === 'pending').slice(0, Number(params[0]) || 5);
        claimed.forEach((t) => { t.state = 'processing'; });
        return { rows: claimed.map((t) => ({ id: t.id, peer_id: t.peer_id, task_type: t.task_type, model: t.model, prompt: t.prompt, options: t.options })) };
      }
      if (sql.includes("SET state = 'completed'")) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'completed'; t.reply = jsonb(params[1]); t.usage = jsonb(params[2]); t.latency_ms = params[3]; }
        return { rows: [] };
      }
      if (sql.includes("SET state = 'failed'")) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'failed'; t.error = params[1]; t.latency_ms = params[2]; }
        return { rows: [] };
      }
      if (sql.includes('GROUP BY state') && sql.includes('genie_ai_logs')) {
        const counts = {};
        aiTasks.forEach((t) => { counts[t.state] = (counts[t.state] || 0) + 1; });
        return { rows: Object.entries(counts).map(([s, c]) => ({ state: s, count: c })) };
      }
      if (sql.includes('INSERT INTO genie_outbox')) {
        outbox.push({ peer_id: params[0], event_type: params[1], payload: params[2], status: 'pending' });
        return { rows: [] };
      }
      if (sql.includes('SELECT id, transport, status FROM comms_sessions')) return { rows: [] };
      if (sql.includes('SELECT id, name, role, scope')) return { rows: peers.map((p) => ({ id: p.id, name: p.name, scope: p.scope, status: p.status })) };
      return { rows: [], rowCount: 0 };
    },
  };
  pool.__peers = peers;
  pool.__aiTasks = aiTasks;
  pool.__outbox = outbox;
  return pool;
}

// ---- fake DeepSeek HTTP server ----
const FAKE_PORT = 18902;
let fakeCalls = [];
const fakeDeepSeek = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    const auth = req.headers.authorization || '';
    fakeCalls.push({ model: parsed.model, auth });
    res.setHeader('Content-Type', 'application/json');
    if (!auth.startsWith('Bearer ')) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
    }
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
  await new Promise((r) => fakeDeepSeek.listen(FAKE_PORT, r));
  console.log(`[1] Fake DeepSeek server on :${FAKE_PORT}`);

  console.log('[2] Building aiBridge + mesh (stubbed DB, real provider code)');
  const stub = makeStubPool();
  const ai = aiBridge.makeAiBridge({
    pool: stub, log: () => {},
    config: {
      enabled: true, apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, model: 'deepseek-v4',
      fallbackModels: 'deepseek-v4,deepseek-chat,deepseek-reasoner',
      free: true, auto: false,
    },
    getMesh: () => mesh,
  });
  const mesh = genieMesh.makeMesh({
    pool: stub, log: () => {}, ai,
    config: { enabled: true, socket: false, httpFlush: false, inboundKey: 'peer-secret', outboundUrl: '' },
  });
  await mesh.start();

  // Sync completion → model-not-exist should auto-fallback to deepseek-chat.
  const r1 = await ai.complete({ prompt: 'ping' });
  check('sync completion succeeds', r1.ok === true);
  check('model fallback engaged (deepseek-v4 → deepseek-chat)', r1.model === 'deepseek-chat', `got ${r1.model}`);
  check('reply correct', r1.reply === 'pong from deepseek-chat');
  check('usage reported', r1.usage && r1.usage.completion_tokens === 11);

  // Durability: ai.task via mesh executor → process batch → emitted to outbox.
  const peer = stub.__peers[0];
  const t = await mesh.executor('ai.task', { prompt: 'plan my week' }, { peerId: peer.id });
  check('durable task queued with pending state', t.taskId >= 1 && t.state === 'pending');
  await ai.processPendingBatch();
  const done = await mesh.executor('ai.result.get', { id: t.taskId }, { peerId: peer.id });
  check('async task processed to completed', done.task.state === 'completed');
  check('async task got model reply', done.task.reply === 'pong from deepseek-chat',
    `reply=${JSON.stringify(done.task.reply)} type=${typeof done.task.reply}`);
  check('result emitted to peer outbox (ai.result)', stub.__outbox.some((o) => o.event_type === 'ai.result' && o.peer_id === peer.id));

  // Status includes pending/completed.
  const st = await ai.getStatus();
  check('ai status shows completed task + model', st.tasks.completed === 1 && st.model === 'deepseek-v4' && st.free === true,
    `tasks=${JSON.stringify(st.tasks)} model=${st.model} free=${st.free}`);
  check('ai status tier=free', st.tier === 'free');

  console.log('[3] REST gateway (X-Genie-Key + real mesh.executor + real aiBridge)');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/genie', genieMesh.createGenieApi({ pool: stub, mesh, rateLimit: () => ({ blocked: false }) }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/genie`;

  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genie-Key': 'peer-secret' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { 'X-Genie-Key': 'peer-secret' } });
    return { status: res.status, body: await res.json() };
  };

  const sync = await post('/ai/complete', { prompt: 'hello' });
  check('REST /ai/complete returns 200', sync.status === 200);
  check('REST sync reply ok', sync.body.ok === true && typeof sync.body.reply === 'string');

  const taskResp = await post('/ai/task', { prompt: 'summarise' });
  check('REST /ai/task returns taskId', taskResp.status === 200 && typeof taskResp.body.taskId === 'number');
  await ai.processPendingBatch();
  const taskGet = await get(`/ai/task/${taskResp.body.taskId}`);
  check('REST /ai/task/:id shows completed', taskGet.status === 200 && taskGet.body.task.state === 'completed');

  const ast = await get('/ai/status');
  check('REST /ai/status shows enabled free deepseek', ast.status === 200 && ast.body.enabled === true && ast.body.tier === 'free');

  const comms = await mesh.getStatus();
  check('mesh /api/comms/status embeds ai payload', comms.ai && comms.ai.enabled === true && comms.ai.model === 'deepseek-v4');

  await mesh.stop();
  ai.stop();
  server.close();
  fakeDeepSeek.close();
}

main().then(() => {
  console.log('\n==============================');
  console.log(failed === 0 ? 'ALL AI SMOKE TESTS PASSED' : `${failed} TEST(S) FAILED`);
  console.log('==============================\n');
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error('AI SMOKE TEST CRASHED:', e);
  process.exit(1);
});