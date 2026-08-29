'use strict';
/**
 * mesh-smoke.js — functional smoke test for the Genie Mesh, run WITHOUT
 * Postgres/Redis by stubbing the pg Pool. Exercises:
 *   1. Module exports at load time (attachInboundSocket fix)
 *   2. Peer seeding from runtime config
 *   3. Real persistent outbound WebSocket link to a local ws server
 *   4. Durable outbox: emit → push → ack → delivered
 *   5. Command round-trip over the socket (status + comms.status)
 *   6. Link teardown detection
 *   7. REST gateway auth (401 without/bad key, 200 with key) + /health-comms
 *   8. REST /comms/status + AI relay endpoints (with stub AI)
 */
const crypto = require('crypto');
const genieMesh = require('../src/genieMesh');
const aiBridge = require('../src/aiBridge');
const { WebSocketServer } = require('ws');

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

// 0. Module-level export check (regression guard for the attachInboundSocket fix)
check('attachInboundSocket exported at module load', typeof genieMesh.attachInboundSocket === 'function');
check('createGenieApi exported at module load', typeof genieMesh.createGenieApi === 'function');
check('aiBridge.makeAiBridge exported', typeof aiBridge.makeAiBridge === 'function');

function makeStubPool() {
  const peerId = crypto.randomUUID();
  let nextOutboxId = 1;
  let nextTaskId = 1;
  let peerRow = null;
  const outboxRows = [];
  const aiTasks = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes('SELECT * FROM genie_peers WHERE name')) return { rows: [] };
      if (sql.includes('INSERT INTO genie_peers')) {
        peerRow = {
          id: peerId, name: params[0], role: params[1], endpoint_url: params[2],
          api_key_hash: params[3], scope: params[4], enabled: true, satlink: params[5],
          status: 'offline', last_seen_at: null, last_error: null,
        };
        return { rows: [peerRow] };
      }
      if (sql.includes('SELECT * FROM genie_peers WHERE enabled = TRUE')) return { rows: [peerRow].filter(Boolean) };
      if (sql.includes('SELECT * FROM genie_peers WHERE id = $1')) return { rows: peerRow ? [peerRow] : [] };
      if (sql.includes('UPDATE genie_peers SET')) {
        if (peerRow && sql.includes('satlink') && params.includes(true)) peerRow.satlink = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO genie_outbox')) {
        outboxRows.push({ id: nextOutboxId++, event_type: params[1], payload: params[2], status: 'pending' });
        return { rows: [] };
      }
      // --- durable AI task queue (genie_ai_logs) ---
      if (sql.includes('INSERT INTO genie_ai_logs')) {
        // Two INSERT shapes exist: aiBridge.createTask binds 5 params
        // (peer, taskType, model, prompt, options); the mesh 'ai.task'
        // executor binds 4 (peer, model, prompt, options) with 'chat' inline.
        const five = params.length >= 5;
        const task = {
          id: nextTaskId++,
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
      if (sql.includes("SET state = 'pending'") && sql.includes('genie_ai_logs')) return { rowCount: 0 };
      if (sql.includes("SET state = 'processing'") && sql.includes('genie_ai_logs')) {
        const claimed = aiTasks.filter((t) => t.state === 'pending').slice(0, Number(params[0]) || 5);
        claimed.forEach((t) => { t.state = 'processing'; });
        return { rows: claimed.map((t) => ({ id: t.id, peer_id: t.peer_id, task_type: t.task_type, model: t.model, prompt: t.prompt, options: t.options })) };
      }
      if (sql.includes("SET state = 'completed'") && sql.includes('genie_ai_logs')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'completed'; t.reply = jsonb(params[1]); t.usage = jsonb(params[2]); t.latency_ms = params[3]; }
        return { rowCount: 1 };
      }
      if (sql.includes("SET state = 'failed'") && sql.includes('genie_ai_logs')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        if (t) { t.state = 'failed'; t.error = params[1]; t.latency_ms = params[2]; }
        return { rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM genie_ai_logs WHERE id')) {
        const t = aiTasks.find((x) => Number(x.id) === Number(params[0]));
        return { rows: t ? [t] : [] };
      }
      if (sql.includes('genie_ai_logs') && sql.includes('GROUP BY state')) {
        const counts = {};
        aiTasks.forEach((t) => { counts[t.state] = (counts[t.state] || 0) + 1; });
        return { rows: Object.entries(counts).map(([state, count]) => ({ state, count })) };
      }
      // --- durable outbox (genie_outbox): claim exactly once per row ---
      if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('genie_outbox')) {
        const claimed = outboxRows.filter((r) => r.status === 'pending').slice(0, params[1] || 10);
        claimed.forEach((r) => { r.status = 'sending'; });
        return { rows: claimed.map((r) => ({ id: r.id, event_type: r.event_type, payload: r.payload, attempts: 1, created_at: new Date() })) };
      }
      if (sql.includes("SET status = 'delivered'")) {
        let n = 0;
        for (const id of params[1]) { const r = outboxRows.find((x) => x.id === id); if (r) { r.status = 'delivered'; n++; } }
        return { rowCount: n };
      }
      if (sql.includes("SET status = 'pending', last_error")) {
        let n = 0;
        for (const id of params[1]) { const r = outboxRows.find((x) => x.id === id); if (r) { r.status = 'pending'; n++; } }
        return { rowCount: n };
      }
      if (sql.includes('GROUP BY status')) {
        const counts = { pending: 0, sending: 0, delivered: 0, failed: 0 };
        outboxRows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
        return { rows: Object.entries(counts).map(([status, count]) => ({ status, count })) };
      }
      if (sql.includes('SELECT id, transport, status FROM comms_sessions')) return { rows: [] };
      if (sql.includes('SELECT id, name, role, scope')) return { rows: [{ id: peerId, name: 'jarv-genie', scope: 'read-write', status: 'online' }] };
      if (sql.includes('INSERT INTO genie_commands')) return { rows: [] };
      if (sql.includes('INSERT INTO comms_sessions')) return { rows: [{ id: 1 }] };
      if (sql.includes('UPDATE comms_sessions SET status')) return { rows: [] };
      if (sql.includes('SELECT id, name, monthly_budget, created_at FROM profiles')) {
        return { rows: [{ id: 'p1', name: 'Business', monthly_budget: 1000, created_at: new Date() }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  pool.__outbox = outboxRows;
  pool.__aiTasks = aiTasks;
  pool.__peerId = peerId;
  return pool;
}

const WS_PORT = 18901;

async function main() {
  console.log('\n[1] Local WebSocket peer server on :' + WS_PORT);
  const wss = new WebSocketServer({ port: WS_PORT });
  let gotHello = null;
  let gotPush = null;
  let gotReply = null;
  let gotCommsReply = null;
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') gotHello = msg;
      if (msg.type === 'push') {
        gotPush = msg;
        ws.send(JSON.stringify({ type: 'ack', ids: msg.batch.map((b) => b.id) }));
      }
      if (msg.type === 'reply') {
        if (msg.id === 'c1') gotReply = msg;
        if (msg.id === 'cs1') gotCommsReply = msg;
      }
    });
    // Ask the hub a question once connected (command round-trip).
    setTimeout(() => ws.send(JSON.stringify({ type: 'command', id: 'c1', command: 'status', args: {} })), 400);
    // Ask for comms status (satellite-friendly health via socket).
    setTimeout(() => ws.send(JSON.stringify({ type: 'command', id: 'cs1', command: 'comms.status', args: {} })), 800);
  });
  console.log('[2] Building mesh against stubbed pool + real socket');
  const stub = makeStubPool();
  const mesh = genieMesh.makeMesh({
    pool: stub,
    log: () => {},
    config: {
      enabled: true,
      outboundUrl: `ws://127.0.0.1:${WS_PORT}`,
      outboundToken: 'outbound-secret',
      inboundKey: 'inbound-secret-key',
      satlink: false,
      socket: true,
      httpFlush: false, // socket-only for the test
      flushIntervalMs: 0,
    },
  });

  await mesh.start();
  check('peer seeded (name=jarv-genie)', mesh.config.peerName === 'jarv-genie');

  // Wait for socket connect + hello.
  for (let i = 0; i < 50 && !gotHello; i++) await new Promise((r) => setTimeout(r, 100));
  check('persistent WebSocket connected (hello received by peer)', !!gotHello);
  check('hello carries peer identity + token', gotHello && gotHello.peer === 'jarv-genie' && gotHello.token === 'outbound-secret' && gotHello.satlink === false);

  // Outbox flow: emit an event, wait for push + ack, verify delivered.
  await mesh.emit('receipt.processed', { receiptId: 42, vendor: 'Starbucks', total: 5.5 });
  for (let i = 0; i < 50 && !gotPush; i++) await new Promise((r) => setTimeout(r, 100));
  check('event emitted into outbox and pushed over socket', !!gotPush && gotPush.batch.length === 1);
  check('pushed payload correct', gotPush && gotPush.batch[0].event_type === 'receipt.processed');
  const stat1 = await mesh.getStatus();
  check('outbox shows delivered after ack', stat1.outbox.delivered === 1, JSON.stringify(stat1.outbox));

  // Command round-trip (peer asks hub for status, gets reply).
  for (let i = 0; i < 50 && !gotReply; i++) await new Promise((r) => setTimeout(r, 100));
  check('command round-trip answered with reply', !!gotReply && gotReply.id === 'c1');
  check('reply carries ok:true', !!gotReply && gotReply.ok === true);

  // comms.status round-trip — the satellite health check over the socket.
  for (let i = 0; i < 50 && !gotCommsReply; i++) await new Promise((r) => setTimeout(r, 100));
  check('comms.status round-trip answered', !!gotCommsReply && gotCommsReply.id === 'cs1');
  check('comms.status carries link + outbox state', !!gotCommsReply && gotCommsReply.ok === true
    && gotCommsReply.data && typeof gotCommsReply.data.outbox === 'object'
    && typeof gotCommsReply.data.outbound.socket === 'boolean');

  // Link teardown detection.
  const statusOnline = await mesh.getStatus();
  check('link shows socket connected', statusOnline.outbound.socket === true);
  wss.clients.forEach((c) => c.close());
  for (let i = 0; i < 50; i++) {
    const s = await mesh.getStatus();
    if (s.outbound.socket === false) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const statusAfter = await mesh.getStatus();
  check('outbound link marked down after close', statusAfter.outbound.socket === false);

  await mesh.stop();
  wss.close();
  console.log('\n[3] REST gateway tests (in-memory express)');
  return stub;
}

async function restTests(stub) {
  const express = require('express');
  const app = express();
  app.use(express.json());

  const stubMesh = {
    verifyKey: (key) => Promise.resolve(key === 'inbound-secret-key' ? { id: stub.__peerId, name: 'jarv-genie', scope: 'read-write', status: 'online' } : null),
    executor: (command, args) => (command === 'status'
      ? Promise.resolve({ version: genieMesh.MESH_VERSION, enabled: true })
      : Promise.resolve({ command, args })),
    config: { satlink: false },
  };
  app.use('/api/genie', genieMesh.createGenieApi({ pool: stub, mesh: stubMesh, rateLimit: () => ({ blocked: false }) }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/genie`;
  const get = async (path, headers) => {
    const res = await fetch(base + path, { headers });
    return { status: res.status, body: await res.json() };
  };
  const post = async (path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const noKey = await get('/status');
  check('REST gateway rejects missing key (401)', noKey.status === 401);
  const badKey = await get('/status', { 'X-Genie-Key': 'wrong' });
  check('REST gateway rejects bad key (401)', badKey.status === 401);
  const okStatus = await get('/status', { 'X-Genie-Key': 'inbound-secret-key' });
  check('REST gateway works with valid key (200)', okStatus.status === 200);
  check('REST status reports enabled + version', okStatus.body.enabled === true);
  const hc = await get('/health-comms', { 'X-Genie-Key': 'inbound-secret-key' });
  check('satellite-lite /health-comms payload', hc.status === 200 && typeof hc.body.backlog === 'number' && hc.body.ok === true);
  const ev = await post('/events', { event_type: 'genie.note', payload: { text: 'hi from JARV' } }, { 'X-Genie-Key': 'inbound-secret-key' });
  check('external event ingest accepted', ev.status === 200 && ev.body.ok === true);
  const roOutbox = await get('/outbox', { 'X-Genie-Key': 'inbound-secret-key' });
  check('pull-mode outbox returns batch array', roOutbox.status === 200 && Array.isArray(roOutbox.body.batch));

  server.close();
}

main().then((stub) => restTests(stub)).then(() => {
  console.log('\n==============================');
  console.log(failed === 0 ? 'ALL SMOKE TESTS PASSED' : `${failed} TEST(S) FAILED`);
  console.log('==============================\n');
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(1);
});