'use strict';
/**
 * telegramTunnel.js — Telegram Bot API long-poll tunnel for JARV-Genie.
 *
 * Purpose (continuity of use): Telegram's getUpdates long-poll is
 * OUTBOUND-only — no inbound ports, no TLS certs, no public endpoint. It
 * keeps a command channel to the hub open from behind CGNAT, mobile hotspots
 * and satellite links where neither the socket nor the HTTPS inbox can listen.
 *
 * Design:
 *   - Registers itself as a first-class mesh peer ("telegram-relay") via
 *     genieMesh.ensurePeerRow, so every command is audited in genie_commands
 *     and the poll session is tracked in comms_sessions like other peers.
 *   - Authorization is a chat-ID allowlist (TELEGRAM_ALLOWED_CHATS). With no
 *     allowlist, /start replies with the caller's chat ID (bootstrap) and
 *     everything else is ignored.
 *   - Free text goes straight to the AI relay; /task queues a durable task
 *     whose result is pushed back to the chat once processed.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      (required to enable; create via @BotFather)
 *   TELEGRAM_ALLOWED_CHATS  comma-separated chat IDs; empty = bootstrap mode
 *   TELEGRAM_POLL_SECONDS   long-poll window (default 25)
 *   TELEGRAM_IDLE_MS        sleep when no updates (default 1000)
 *   TELEGRAM_TASK_WATCH_MS  task-poll interval for result push (default 10000)
 *   TELEGRAM_API_BASE       override for tests (default https://api.telegram.org)
 *   TELEGRAM_PEER_NAME      mesh peer name (default telegram-relay)
 */
const crypto = require('crypto');
const genieMesh = require('./genieMesh');

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function nowIso() { return new Date().toISOString(); }

function makeTelegramTunnel({ pool, mesh, log, config = {}, jarv = null } = {}) {
  // Accept a plain fn, a console-like logger ({info}), or nothing.
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const token = config.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logFn('[telegram] TELEGRAM_BOT_TOKEN not set — tunnel disabled (socket + HTTPS paths unaffected).');
    return null;
  }
  const cfg = {
    token,
    apiBase: (config.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    allowedChats: String(config.TELEGRAM_ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
    pollSeconds: Math.max(0, Number(config.TELEGRAM_POLL_SECONDS != null ? config.TELEGRAM_POLL_SECONDS : 25)),
    idleMs: Math.max(0, Number(config.TELEGRAM_IDLE_MS != null ? config.TELEGRAM_IDLE_MS : 1000)),
    taskWatchMs: Math.max(250, Number(config.TELEGRAM_TASK_WATCH_MS != null ? config.TELEGRAM_TASK_WATCH_MS : 10000)),
    peerName: config.TELEGRAM_PEER_NAME || 'telegram-relay',
    maxChars: 3800,
  };
  const state = {
    stopped: true, started: false, offset: 0, peer: null, sessionId: null,
    abort: null, watchTimer: null, tasks: new Map(), sent: 0, received: 0,
    lastUpdateAt: null, lastError: null, webhookDeleted: false,
  };

  const isAllowed = (chatId) => cfg.allowedChats.includes(Number(chatId));

  function chunk(text, size) {
    const out = [];
    let s = String(text == null ? '' : text);
    while (s.length) {
      if (s.length <= size) { out.push(s); break; }
      let cut = s.lastIndexOf('\n', size);
      if (cut < Math.floor(size / 2)) cut = size;
      out.push(s.slice(0, cut));
      s = s.slice(cut).replace(/^\n+/, '');
    }
    return out.length ? out : ['(empty)'];
  }
  // --- Bot API HTTP (https only; prefers global fetch, falls back to https) ---
  const agent = new (require('https').Agent)({ keepAlive: true, maxSockets: 2 });
  async function tgApi(method, body) {
    const url = `${cfg.apiBase}/bot${cfg.token}/${method}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      state.abort = new AbortController();
      const signal = state.abort.signal;
      try {
        let res;
        if (typeof fetch === 'function') {
          res = fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}), signal, agent,
          });
        } else {
          res = new Promise((resolve, reject) => {
            const u = new URL(url);
            const req = require('https').request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, agent, timeout: (cfg.pollSeconds + 15) * 1000 }, (r) => {
              let data = '';
              r.on('data', (c) => { data += c; });
              r.on('end', () => { try { resolve({ ok: true, status: r.statusCode, json: () => JSON.parse(data || '{}') }); } catch (e) { reject(e); } });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.end(JSON.stringify(body || {}));
          });
        }
        const r = await res;
        if (!r.ok && (r.status === 429 || r.status >= 500)) throw new Error(`telegram ${r.status}`);
        return r.json();
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        state.lastError = e.message;
        if (attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  // Long replies are split with chunk() — the Bot API rejects >4096 chars.
  const sendMessage = async (chatId, text) => {
    const parts = chunk(text, cfg.maxChars);
    for (const part of parts) {
      try {
        await tgApi('sendMessage', {
          chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true,
        });
        state.sent++;
      } catch (e) { logFn(`[telegram] sendMessage failed: ${e.message}`); }
    }
  };
  const BotCmds = [
    { command: 'start', description: 'Register + show chat id' },
    { command: 'status', description: 'Comms + AI health' },
    { command: 'task', description: 'Queue a durable AI task' },
    { command: 'prompt', description: 'Quick AI prompt (sync)' },
    { command: 'peer', description: 'Peer roster' },
    { command: 'where', description: 'How to reach the hub (tailscale/public)' },
    { command: 'osint', description: 'Satellite OSINT: /osint.handbook or /osint.satvision {"lat":..,"lon":..,"satellites":"starlink","overhead":true}' },
  ];
  function commandList() { return BotCmds; }
  const setMyCommands = () => tgApi('setMyCommands', { commands: BotCmds }).catch(() => {});

  const HELP = [
    '<b>JARV-Genie tunnel</b>',
    '/status — comms + AI health snapshot',
    '/task &lt;prompt&gt; — durable AI task (survives disconnects)',
    '/prompt &lt;text&gt; — quick AI completion',
    '/peer — mesh peer roster',
    '/where — all reachable hub endpoints',
    '/osint.handbook — your satellite-comms OSINT cross-training doc',
    '/osint.satvision {"lat":40.4,"lon":-3.65,"overhead":true,"satellites":"starlink,oneweb,iridium-next"} — live satellite intelligence',
    'Free text — chat with JARV-Genie',
  ].join('\n');

  async function ensurePeerAndSession() {
    if (!state.peer) {
      state.peer = await genieMesh.ensurePeerRow(pool, {
        peerName: cfg.peerName, role: 'peer', scope: 'commands',
        outboundUrl: 'telegram://longpoll', satlink: true,
      });
    }
    if (!state.sessionId) {
      try {
        const { rows } = await pool.query(
          'INSERT INTO comms_sessions (peer_id, transport, status) VALUES ($1, $2, $3) RETURNING id',
          [state.peer.id, 'telegram-longpoll', 'connected'],
        );
        state.sessionId = rows[0].id;
      } catch (e) { logFn(`[telegram] session insert skipped: ${e.message}`); }
    }
    return state.peer;
  }

  /** Command allowlist executed with mesh peer context (audited in genie_commands). */
  const COMMANDS = {
    'comms.status': { args: [], handler: () => mesh.getStatus() },
    'peer.list': { args: [], handler: () => mesh.listPeers() },
    'ai.status': { args: [], handler: () => mesh.getStatus().then((s) => s.ai) },
    'ai.task': { args: ['prompt', 'options?'], handler: (args, peerId) => mesh.executor('ai.task', args, { peerId }) },
    'ai.result.get': { args: ['id'], handler: (args, peerId) => mesh.executor('ai.result.get', args, { peerId }) },
    'osint.handbook': { args: [], handler: (args, peerId) => mesh.executor('osint.handbook', args, { peerId }) },
    'osint.satvision': { args: ['lat', 'lon', 'satellites?', 'overhead?', 'footprint?'], handler: (args, peerId) => mesh.executor('osint.satvision', args, { peerId }) },
  };
  async function execCommand(command, args, chatId) {
    const peer = await ensurePeerAndSession();
    const entry = COMMANDS[command];
    if (!entry) {
      await pool.query('INSERT INTO genie_commands (peer_id, command, args, result, status) VALUES ($1, $2, $3, $4, $5)',
        [peer.id, command, JSON.stringify(args || {}), JSON.stringify({ error: 'unknown command' }), 'error']).catch(() => {});
      return { ok: false, error: `unknown command: ${command}` };
    }
    const result = await entry.handler(args || {}, peer.id);
    await pool.query('INSERT INTO genie_commands (peer_id, command, args, result, status) VALUES ($1, $2, $3, $4, $5)',
      [peer.id, command, JSON.stringify(args || {}), JSON.stringify(result || {}), 'ok']).catch(() => {});
    return { ok: true, result };
  }

  /** Audit a handled interaction into genie_commands (the peers' command trail). */
  async function audit(command, args, result, status) {
    try {
      const peer = await ensurePeerAndSession();
      await pool.query('INSERT INTO genie_commands (peer_id, command, args, result, status) VALUES ($1, $2, $3, $4, $5)',
        [peer.id, command, JSON.stringify(args || {}), JSON.stringify(result || {}), status || 'ok']);
    } catch (e) { logFn(`[telegram] audit skipped: ${e.message}`); }
  }

  function safeStringify(v) {
    try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  // --- Outbox drain: push queued peer events to authorized chats ---
  async function pushOutboxToChats() {
    if (!state.sentChats || !state.sentChats.length) return 0;
    try {
      const events = await mesh.claimOutbox();
      if (!events.length) return 0;
      for (const ev of events) {
        const text = ev.event_type === 'ai.result'
          ? `<b>AI result</b>\n${safeStringify(ev.payload)}`
          : `<b>${ev.event_type}</b>\n${safeStringify(ev.payload)}`;
        for (const chatId of state.sentChats) await sendMessage(chatId, text);
      }
      await mesh.markOutboxDelivered(events.map((e) => e.id));
      return events.length;
    } catch (e) { logFn(`[telegram] outbox drain: ${e.message}`); return 0; }
  }

  async function handleUpdate(update) {
    state.received++;
    state.lastUpdateAt = nowIso();
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();
    if (!text) return;

    // Bootstrap: no allowlist configured → /start reports the chat id.
    if (!cfg.allowedChats.length) {
      if (text === '/start') {
        await sendMessage(chatId, 'This hub has no TELEGRAM_ALLOWED_CHATS configured yet.\n'
          + `Your chat id is <code>${chatId}</code>.\nAdd it to TELEGRAM_ALLOWED_CHATS, then /start again.`);
      }
      return;
    }
    if (!isAllowed(chatId)) {
      logFn(`[telegram] ignored message from unauthorized chat ${chatId}`);
      return;
    }
    if (!state.sentChats) state.sentChats = [];
    if (!state.sentChats.includes(chatId)) state.sentChats.push(chatId);
    state.lastCommand = { command: text, chatId, at: nowIso() };

    // Every authorized interaction is audited in genie_commands; /start,
    // /help and /chatid are session housekeeping, not agentic commands.
    let auditCmd = text === '/start' || text === '/help' || text === '/chatid'
      ? null
      : (text.startsWith('/') ? text.split(/\s+/)[0].slice(1) : 'chat');

    try {
      if (text === '/start') {
        await ensurePeerAndSession();
        await setMyCommands().catch((e) => logFn(`[telegram] setMyCommands skipped: ${e.message}`));
        await sendMessage(chatId, `JARV-Genie tunnel online.\nPeer: <code>${cfg.peerName}</code>\nChat registered for mesh pushes.\n\n${HELP}`);
        await pushOutboxToChats();
      } else if (text === '/chatid') {
        await sendMessage(chatId, `chat id: <code>${chatId}</code>`);
      } else if (text === '/help') {
        await sendMessage(chatId, HELP);
      } else if (text === '/status') {
        const s = await mesh.getStatus();
        await sendMessage(chatId, [
          '<b>Comms</b>',
          `socket: ${s.outbound && s.outbound.socket ? 'connected' : 'down'}`,
          `inbox: ${s.inbound && s.inbound.flushed ? 'flush ok' : 'idle'}`,
          `outbox: ${s.outbox && s.outbox.pending} pending / ${s.outbox && s.outbox.delivered} delivered`,
          `peers online: ${s.peers && s.peers.online}/${s.peers && s.peers.total}`,
          '',
          '<b>AI</b>',
          `enabled: ${s.ai && s.ai.enabled} · tier: ${s.ai && s.ai.tier} · model: ${s.ai && s.ai.model}`,
          `tasks: ${s.ai && s.ai.tasks ? Object.entries(s.ai.tasks).map(([k, v]) => `${k}=${v}`).join(' ') : 'n/a'}`,
        ].join('\n'));
      } else if (text === '/peer') {
        const peers = await mesh.listPeers();
        await sendMessage(chatId, peers.map((p) => `• <code>${p.name}</code> (${p.role}, ${p.scope}) — ${p.status}`).join('\n') || '(no peers)');
      } else if (text === '/where') {
        const endpoints = [];
        if (process.env.TAILSCALE_HOSTNAME) {
          endpoints.push(`mesh socket: ${process.env.TAILSCALE_HOSTNAME}`);
          endpoints.push(`tailscale https: ${process.env.TAILSCALE_HOSTNAME.replace(/^wss:/, 'https:').replace(/\/socket$/, '')}/api/genie/inbox`);
        }
        if (process.env.PUBLIC_WS_URL) endpoints.push(`public socket: ${process.env.PUBLIC_WS_URL}`);
        if (process.env.PUBLIC_BASE_URL) endpoints.push(`public https: ${process.env.PUBLIC_BASE_URL}/api/genie/inbox`);
        endpoints.push('telegram: long-poll (no inbound port needed)');
        await sendMessage(chatId, `<b>Reach the hub via</b>\n${endpoints.map((e) => `• ${e}`).join('\n')}`);
      } else if (/^\/task\b/.test(text)) {
        const prompt = text.replace(/^\/task\b\s*/, '');
        if (!prompt) { await sendMessage(chatId, 'Usage: /task &lt;prompt&gt;'); return; }
        const peer = await ensurePeerAndSession();
        const out = await mesh.executor('ai.task', { prompt }, { peerId: peer.id });
        state.tasks.set(Number(out.taskId), chatId);
        await sendMessage(chatId, `Task <code>${out.taskId}</code> queued (${out.state}). You'll get the reply here when it completes.`);
      } else if (/^\/prompt\b/.test(text)) {
        const prompt = text.replace(/^\/prompt\b\s*/, '');
        if (!prompt) { await sendMessage(chatId, 'Usage: /prompt &lt;text&gt;'); return; }
        const peer = await ensurePeerAndSession();
        const out = await mesh.executor('ai.complete', { prompt }, { peerId: peer.id });
        await sendMessage(chatId, out && out.reply ? out.reply : `AI error: ${safeStringify(out)}`);
      } else if (text.startsWith('/')) {
        auditCmd = null; // execCommand audits this path itself
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        const joined = rest.join(' ').trim();
        let args;
        if (joined.startsWith('{')) { try { args = JSON.parse(joined); } catch (e) { args = { args: rest }; } }
        else if (cmd === 'ai.task') args = { prompt: joined };
        else args = { args: rest };
        const out = await execCommand(cmd, args, chatId);
        await sendMessage(chatId, out.ok ? `<pre>${safeStringify(out.result).slice(0, 3500)}</pre>` : `Error: ${safeStringify(out.error)}`);
      } else {
        // Free text → AI chat.
        const peer = await ensurePeerAndSession();
        const out = await mesh.executor('ai.complete', { prompt: text }, { peerId: peer.id });
        await sendMessage(chatId, out && out.reply ? out.reply : `AI error: ${safeStringify(out)}`);
      }
      if (auditCmd) await audit(auditCmd, { text }, null, 'ok');
    } catch (e) {
      logFn(`[telegram] update error: ${e.message}`);
      if (auditCmd) await audit(auditCmd, { text }, { error: e.message }, 'error');
      await sendMessage(chatId, `Error: ${e.message}`).catch(() => {});
    }
  }

  async function drainTaskWatchers() {
    if (!state.tasks.size) return;
    for (const [id, chatId] of state.tasks) {
      try {
        const { rows } = await pool.query('SELECT * FROM genie_ai_logs WHERE id = $1', [id]);
        const t = rows[0];
        if (!t) { state.tasks.delete(id); continue; }
        if (t.state === 'completed' || t.state === 'failed') {
          state.tasks.delete(id);
          const body = t.state === 'completed'
            ? `<b>Task ${t.id}</b>\n${safeStringify(t.reply)}`
            : `<b>Task ${t.id} failed</b>\n${safeStringify(t.error)}`;
          await sendMessage(chatId, body);
        }
      } catch (e) { logFn(`[telegram] task watch ${id}: ${e.message}`); }
    }
  }

  async function pollOnce() {
    const json = await tgApi('getUpdates', {
      offset: state.offset, timeout: cfg.pollSeconds,
      allowed_updates: ['message', 'edited_message'],
    });
    if (json && json.ok && Array.isArray(json.result)) {
      for (const update of json.result) {
        state.offset = Math.max(state.offset, (update.update_id || 0) + 1);
        await handleUpdate(update);
      }
      return json.result.length;
    }
    if (json && !json.ok) throw new Error(`getUpdates: ${json.error_code || ''} ${json.description || 'rejected'}`);
    return 0;
  }

  async function pollLoop() {
    while (!state.stopped) {
      try {
        await ensurePeerAndSession();
        const n = await pollOnce();
        state.lastError = null;
        await drainTaskWatchers();
        // Backoff between empty polls so a short/zero long-poll window
        // (tests, aggressive configs) can never hot-loop the Bot API.
        if (!n) await sleepMs(cfg.idleMs);
      } catch (e) {
        if (state.stopped) break;
        state.lastError = e.message;
        logFn(`[telegram] poll error: ${e.message} — retrying`);
        await sleepMs(Math.min(30000, cfg.idleMs * 10));
      }
    }
  }

  async function start() {
    if (state.started || !token) return state;
    state.started = true;
    state.stopped = false;
    logFn('[telegram] starting long-poll tunnel (outbound-only; ideal for tailscale/satellite)...');
    try { await tgApi('deleteWebhook', { drop_pending_updates: false }); state.webhookDeleted = true; }
    catch (e) { logFn(`[telegram] deleteWebhook: ${e.message}`); }
    try { await setMyCommands(); } catch (e) { /* non-fatal */ }
    await ensurePeerAndSession().catch((e) => logFn(`[telegram] peer bootstrap deferred: ${e.message}`));
    state.pollPromise = pollLoop();
    state.watchTimer = setInterval(() => { drainTaskWatchers().catch(() => {}); }, cfg.taskWatchMs);
    if (state.watchTimer.unref) state.watchTimer.unref();
    return state;
  }

  async function stop() {
    if (!state.started) return;
    state.stopped = true;
    try { if (state.abort) state.abort.abort(); } catch (e) { /* ignore */ }
    clearInterval(state.watchTimer);
    if (state.sessionId) {
      await pool.query("UPDATE comms_sessions SET status = 'disconnected', ended_at = NOW() WHERE id = $1", [state.sessionId]).catch(() => {});
    }
    try { if (state.pollPromise) await state.pollPromise; } catch (e) { /* ignore */ }
    try { agent.destroy(); } catch (e) { /* ignore */ }
    state.started = false;
    logFn('[telegram] tunnel stopped');
  }

  /** Telegram portion of /api/comms/status. */
  function getStatus() {
    return {
      enabled: Boolean(token),
      mode: 'longpoll-outbound',
      peer: cfg.peerName,
      allowedChats: cfg.allowedChats.length,
      authorizedChats: (state.sentChats || []).length,
      updatesReceived: state.received,
      messagesSent: state.sent,
      lastUpdateAt: state.lastUpdateAt,
      lastCommand: state.lastCommand || null,
      pendingTaskWatches: state.tasks.size,
      webhookDeleted: state.webhookDeleted,
      running: state.started && !state.stopped,
      lastError: state.lastError,
    };
  }

  return {
    start, stop, getStatus, handleUpdate, execCommand, commandList,
    pushOutboxToChats, drainTaskWatchers,
    __test: { cfg, state, tgApi, isAllowed, chunk, safeStringify },
  };
}

module.exports = { makeTelegramTunnel };

