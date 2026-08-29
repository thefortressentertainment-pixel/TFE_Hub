'use strict';
/**
 * genieMesh.js — durable, bidirectional "Genie Mesh" between Fortress Hub and
 * JARV-Genie (or any assistant peer). Designed from the ground up to keep the
 * two sides connected "forever" and to survive the realities of satellite
 * comms (Starlink, Iridium, OneWeb, congested LTE):
 *
 *  1. OUTBOX + ACK      Every Fortress Hub domain event is written to the
 *                       durable `genie_outbox` table FIRST. A peer only
 *                       considers it delivered after an explicit ack, so
 *                       nothing is lost when a link drops mid-flight.
 *  2. PERSISTENT LINK   A native WebSocket client with auto-reconnect backoff
 *                       and heartbeat keeps Fortress Hub connected to
 *                       JARV-Genie outbound. JARV-Genie may also connect
 *                       inbound over the /genie Socket.IO namespace.
 *  3. MULTI-TRANSPORT   When the socket is down (satellite blackout) an HTTPS
 *                       flusher and a REST "pull" endpoint keep delivery
 *                       flowing over whatever path is reachable.
 *  4. LOW BANDWIDTH     Batched sends, compact JSON, optional gzip, and a
 *                       minimal /health-comms endpoint for sat-link clients.
 *
 *   No new npm dependencies beyond the pg Pool the caller already owns: uses
 *   Node built-ins (http/https/zlib/crypto) plus `ws` (a lightweight, battle-tested
 *   WebSocket client) when the native `WebSocket` global is absent — which it is
 *   on Node 20 LTS (node:20-alpine, the Dockerfile / Render / Fly target), so the
 *   outbound socket actually works in production, not just on dev machines running
 *   Node 23+.
 */
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const MESH_VERSION = '1.0.0';
const DEFAULT_PEER_NAME = 'jarv-genie';

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */
function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

/**
 * Constant-time compare of a presented secret against a stored sha256 hex
 * hash (as written by ensurePeerRow). The presented side is hashed exactly
 * once: hashing BOTH sides would compare H(H(key)) against H(key), which can
 * never match — locking every peer out of the API permanently.
 */
function safeEqual(storedHash, presentedSecret) {
  const ah = Buffer.from(String(storedHash || ''), 'hex');
  const bh = Buffer.from(hashSecret(presentedSecret), 'hex');
  return ah.length === bh.length && crypto.timingSafeEqual(ah, bh);
}

function envBool(value, def) {
  if (value == null || value === '') return def;
  return !/^(false|0|off|no)$/i.test(String(value));
}

/** Given a WS/HTTPS endpoint, return a URL for the HTTPS inbox we POST to. */
function makeInboxPath(endpoint) {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    const path = ((u.pathname || '') + (u.search || ''))
      .replace(/^\/socket/, '')
      .replace(/\/$/, '');
    return u.origin + (path || '/api/genie/inbox');
  } catch (e) {
    return null;
  }
}

/**
 * Given the configured endpoint (http(s) or ws(s)), return the ws(s) URL the
 * outbound mesh socket should dial. JARV_GENIE_URL is a single variable shared
 * by the socket AND the HTTPS inbox flusher — over Tailscale/ts.net it is
 * naturally an https URL, which a WebSocket constructor rejects. Normalizing
 * here lets one URL drive both transports (http→ws, https→wss).
 */
function makeSocketUrl(endpoint) {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    if (!u.pathname || u.pathname === '/') u.pathname = '/socket';
    return u.toString().replace(/\/+$/, '');
  } catch (e) {
    return null;
  }
}

function nowIso() { return new Date().toISOString(); }
exports.MESH_VERSION = MESH_VERSION;
exports.DEFAULT_PEER_NAME = DEFAULT_PEER_NAME;
exports.hashSecret = hashSecret;
exports.safeEqual = safeEqual;
exports.makeInboxPath = makeInboxPath;
exports.makeSocketUrl = makeSocketUrl;
// Shared with the transport tunnels (telegramTunnel.js) so they can register
// as first-class peers and audit traffic exactly like socket/HTTPS peers.
exports.ensurePeerRow = ensurePeerRow;
exports.logCommand = logCommand;
exports.openSession = openSession;
exports.closeSession = closeSession;
/* ------------------------------------------------------------------ *
 * Database helpers (caller supplies the pg Pool)
 * ------------------------------------------------------------------ */
async function ensurePeerRow(pool, cfg) {
  const { rows } = await pool.query('SELECT * FROM genie_peers WHERE name = $1', [cfg.peerName]);
  if (rows.length) {
    const row = rows[0];
    // Keep runtime config in sync with the DB where provided.
    const updates = [];
    const params = [];
    let idx = 1;
    if (cfg.outboundUrl) { updates.push(`endpoint_url = $${idx++}`); params.push(cfg.outboundUrl); }
    if (cfg.satlink && !row.satlink) { updates.push(`satlink = $${idx++}`); params.push(true); }
    if (updates.length) {
      params.push(row.id);
      await pool.query(`UPDATE genie_peers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`, params);
      return (await pool.query('SELECT * FROM genie_peers WHERE id = $1', [row.id])).rows[0];
    }
    return row;
  }

  let keyHash = null;
  let generatedKey = null;
  if (cfg.inboundKey) {
    keyHash = hashSecret(cfg.inboundKey);
  } else {
    // No key configured: mint one so inbound API is immediately usable, and
    // log it once so the operator can copy it into the JARV-Genie config.
    generatedKey = crypto.randomBytes(24).toString('base64url');
    keyHash = hashSecret(generatedKey);
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO genie_peers (name, role, endpoint_url, api_key_hash, scope, enabled, satlink, status)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, 'offline')
     RETURNING *`,
    [cfg.peerName, 'assistant', cfg.outboundUrl || null, keyHash, cfg.scope, cfg.satlink]
  );
  const peer = inserted[0];
  if (cfg.log) {
    if (generatedKey) {
      cfg.log(`[genie-mesh] Created peer "${cfg.peerName}".`);
      cfg.log(`[genie-mesh] INBOUND API KEY (save into your JARV-Genie config): ${generatedKey}`);
    } else {
      cfg.log(`[genie-mesh] Created peer "${cfg.peerName}" using configured backend key.`);
    }
  }
  return peer;
}

async function getPeer(pool, nameOrId) {
  const col = /^[0-9a-fA-F-]{36}$/.test(String(nameOrId)) ? 'id' : 'name';
  const { rows } = await pool.query(`SELECT * FROM genie_peers WHERE ${col} = $1`, [String(nameOrId)]);
  return rows[0] || null;
}

async function listPeers(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, role, scope, enabled, satlink, status, last_seen_at, last_error, created_at
       FROM genie_peers ORDER BY name`
  );
  return rows;
}

async function setPeerStatus(pool, peerId, status, opts = {}) {
  const { error, lastSeen = nowIso() } = opts;
  await pool.query(
    `UPDATE genie_peers SET status = $2, last_seen_at = $3, last_error = $4, updated_at = NOW() WHERE id = $1`,
    [peerId, status, lastSeen, error || null]
  );
}

async function pushEvent(pool, peerId, eventType, payload) {
  await pool.query(
    `INSERT INTO genie_outbox (peer_id, event_type, payload) VALUES ($1, $2, $3)`,
    [peerId, eventType, payload == null ? {} : payload]
  );
}
/**
 * Atomically claim up to `limit` pending outbox rows for this peer.
 * `FOR UPDATE SKIP LOCKED` makes concurrent claimers (multiple backend
 * instances, socket + flusher) safe: each row is claimed exactly once.
 */
async function claimBatch(pool, peerId, limit, backoffSeconds) {
  const { rows } = await pool.query(
    `UPDATE genie_outbox g
        SET status = 'sending', attempts = g.attempts + 1,
            next_attempt_at = NOW() + make_interval(secs => $3), sent_at = NOW()
      WHERE g.id IN (
        SELECT id FROM genie_outbox
         WHERE peer_id = $1 AND status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY id LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type, payload, attempts, created_at`,
    [peerId, limit, backoffSeconds || 60]
  );
  return rows;
}

async function deliverBatch(pool, peerId, ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE genie_outbox
        SET status = 'delivered', delivered_at = NOW(), last_error = NULL
      WHERE peer_id = $1 AND id = ANY($2::bigint[]) AND status = 'sending'`,
    [peerId, ids]
  );
  return rowCount;
}

async function failBatch(pool, peerId, ids, error, backoffSeconds) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE genie_outbox
        SET status = 'pending', last_error = $3,
            next_attempt_at = NOW() + make_interval(secs => $4)
      WHERE peer_id = $1 AND id = ANY($2::bigint[]) AND status = 'sending'`,
    [peerId, ids, String(error || 'delivery failed').slice(0, 500), backoffSeconds || 60]
  );
  return rowCount;
}

/**
 * Requeue rows stuck in 'sending' (e.g. a satellite drop right after a claim,
 * or a REST pull that was never acked). Runs periodically so nothing is ever
 * left undelivered permanently.
 */
async function requeueStale(pool, peerId, thresholdSeconds) {
  await pool.query(
    `UPDATE genie_outbox
        SET status = 'pending', next_attempt_at = NOW(), last_error = 'requeued (ack timeout)'
      WHERE peer_id = $1 AND status = 'sending'
        AND sent_at < NOW() - make_interval(secs => $2)`,
    [peerId, thresholdSeconds || 600]
  );
}

async function outboxStats(pool, peerId) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM genie_outbox WHERE peer_id = $1 GROUP BY status`,
    [peerId]
  );
  const stats = { pending: 0, sending: 0, delivered: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.count;
  return stats;
}

async function logCommand(pool, peerId, command, status, latencyMs) {
  await pool.query(
    `INSERT INTO genie_commands (peer_id, command, status, latency_ms) VALUES ($1, $2, $3, $4)`,
    [peerId, command, status, latencyMs == null ? null : Math.round(latencyMs)]
  );
}

async function openSession(pool, peerId, transport) {
  const { rows } = await pool.query(
    `INSERT INTO comms_sessions (peer_id, transport, status) VALUES ($1, $2, 'connected') RETURNING id`,
    [peerId, transport]
  );
  return rows[0].id;
}

async function closeSession(pool, sessionId, status, reason) {
  if (!sessionId) return;
  await pool.query(
    `UPDATE comms_sessions SET status = $2, disconnected_at = NOW(), reason = $3
      WHERE id = $1 AND disconnected_at IS NULL`,
    [sessionId, status, reason || null]
  );
}

async function recentSessions(pool, peerId, limit) {
  const { rows } = await pool.query(
    `SELECT id, transport, status, bytes_sent, bytes_received, connected_at, disconnected_at, reason
       FROM comms_sessions WHERE peer_id = $1
      ORDER BY connected_at DESC LIMIT $2`,
    [peerId, limit || 20]
  );
  return rows;
}

/** Constant-time lookup of the peer owning `key` (compares sha256 hashes). */
async function verifyPeerKey(pool, key) {
  if (!key) return null;
  const { rows } = await pool.query('SELECT * FROM genie_peers WHERE enabled = TRUE');
  return rows.find((p) => p.api_key_hash && safeEqual(p.api_key_hash, key)) || null;
}
exports.claimBatch = claimBatch;
exports.deliverBatch = deliverBatch;
exports.failBatch = failBatch;
exports.requeueStale = requeueStale;
exports.outboxStats = outboxStats;
exports.logCommand = logCommand;
exports.openSession = openSession;
exports.closeSession = closeSession;
exports.recentSessions = recentSessions;
exports.verifyPeerKey = verifyPeerKey;
exports.ensurePeerRow = ensurePeerRow;
exports.getPeer = getPeer;
exports.listPeers = listPeers;
exports.setPeerStatus = setPeerStatus;
exports.pushEvent = pushEvent;
/* ------------------------------------------------------------------ *
 * Domain command executor — shared by every transport so JARV-Genie gets the
 * same behaviour over outbound WebSocket, inbound Socket.IO or REST.
 * Privileged: the peer is the operator's personal assistant, so reads span
 * the whole vault; writes are deliberately limited and audited.
 * ------------------------------------------------------------------ */
function buildExecutor(pool, meshRef) {
  const handlers = {
    'status': async () => (meshRef.getStatus ? meshRef.getStatus() : { ok: true }),

    'profiles.list': async () => {
      const { rows } = await pool.query('SELECT id, name, monthly_budget, created_at FROM profiles ORDER BY name');
      return { profiles: rows };
    },

    'receipts.list': async (args = {}) => {
      const limit = Math.min(Number(args.limit) || 50, 200);
      const params = [limit];
      let sql = `SELECT id, profile_id, vendor, date, total, tax_amount, category, currency,
                        is_business, project_name, created_at, confidence_score
                   FROM receipts WHERE 1 = 1`;
      let idx = 2;
      if (args.profileId) { sql += ` AND profile_id = $${idx++}`; params.push(args.profileId); }
      if (args.startDate) { sql += ` AND date >= $${idx++}`; params.push(args.startDate); }
      if (args.endDate) { sql += ` AND date <= $${idx++}`; params.push(args.endDate); }
      if (args.category) { sql += ` AND category = $${idx++}`; params.push(args.category); }
      sql += ' ORDER BY created_at DESC LIMIT $1';
      const { rows } = await pool.query(sql, params);
      return { receipts: rows };
    },

    'receipts.get': async (args = {}) => {
      if (!args.id) throw new Error('receipt id required');
      const { rows } = await pool.query('SELECT * FROM receipts WHERE id = $1', [args.id]);
      if (!rows.length) throw new Error('receipt not found');
      return { receipt: rows[0] };
    },

    'receipts.update': async (args = {}) => {
      const body = args.patch || args.body || {};
      const allowed = ['vendor', 'category', 'is_business', 'business_notes', 'project_name', 'tax_category', 'is_verified'];
      const sets = [];
      const params = [];
      let idx = 1;
      for (const key of allowed) {
        if (body[key] !== undefined) { sets.push(`${key} = $${idx++}`); params.push(body[key]); }
      }
      if (!sets.length) throw new Error('no fields to update');
      params.push(args.id);
      const { rows } = await pool.query(
        `UPDATE receipts SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params
      );
      if (!rows.length) throw new Error('receipt not found');
      return { receipt: rows[0] };
    },

    'receipts.notes': async (args = {}) => {
      if (!args.id) throw new Error('receipt id required');
      const { rows } = await pool.query(
        `UPDATE receipts SET business_notes = $2 WHERE id = $1 RETURNING id, business_notes`,
        [args.id, String(args.business_notes || '').slice(0, 5000)]
      );
      if (!rows.length) throw new Error('receipt not found');
      return { receipt: rows[0] };
    },

    'daily.summary': async (args = {}) => {
      const fallback = (await pool.query('SELECT id FROM profiles ORDER BY created_at LIMIT 1')).rows[0];
      const profileId = args.profileId || (fallback && fallback.id);
      if (!profileId) return { today: null };
      const [today, miles] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(total), 0) AS spend, COUNT(id) AS receipts,
                  COALESCE(SUM(total) FILTER (WHERE is_business), 0) AS business_spend
             FROM receipts WHERE profile_id = $1 AND date = CURRENT_DATE`,
          [profileId]
        ),
        pool.query(
          `SELECT COALESCE(SUM(miles), 0) AS miles, COUNT(*) AS shifts
             FROM shifts
            WHERE profile_id = $1 AND status = 'completed' AND end_time >= date_trunc('day', CURRENT_DATE)`,
          [profileId]
        ),
      ]);
      return {
        profileId,
        today: {
          spend: Number(today.rows[0].spend),
          business_spend: Number(today.rows[0].business_spend),
          receipts: Number(today.rows[0].receipts),
          miles: Number(miles.rows[0].miles),
          shifts: Number(miles.rows[0].shifts),
        },
      };
    },

    'analytics.trends': async (args = {}) => {
      const months = Math.min(Number(args.months) || 6, 24);
      const profileId = args.profileId;
      const params = profileId ? [profileId, months] : [months];
      const where = profileId ? 'WHERE profile_id = $1' : '';
      const monParam = profileId ? '$2' : '$1';
      const { rows } = await pool.query(
        `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
                COUNT(id)::int AS receipts,
                COALESCE(SUM(total), 0) AS spend
           FROM receipts
          ${where}
           AND date >= date_trunc('month', CURRENT_DATE) - (${monParam} || ' months')::interval
          GROUP BY 1 ORDER BY 1`,
        params
      );
      return { trends: rows };
    },

    'comms.status': async () => (meshRef.getStatus ? meshRef.getStatus() : { ok: true }),

    // ---- Genie AI relay: Free DeepSeek V4 (or any OpenAI-compatible model) ----
    // usable as JARV-Genie's main brain over every mesh transport.
    'ai.status': async () => {
      if (!meshRef.ai) throw new Error('AI relay not configured (set DEEPSEEK_API_KEY)');
      return meshRef.ai.getStatus();
    },

    'ai.complete': async (args = {}) => {
      if (!meshRef.ai) throw new Error('AI relay not configured (set DEEPSEEK_API_KEY)');
      if (!args.messages && !args.prompt && args.input === undefined) {
        throw new Error('prompt or messages required');
      }
      return meshRef.ai.complete(args);
    },

    'ai.chat': async (args = {}) => {
      if (!meshRef.ai) throw new Error('AI relay not configured (set DEEPSEEK_API_KEY)');
      return meshRef.ai.complete(args);
    },

    'ai.task': async (args = {}, ctx = {}) => {
      if (!meshRef.ai) throw new Error('AI relay not configured (set DEEPSEEK_API_KEY)');
      if (!args.messages && !args.prompt) throw new Error('prompt or messages required');
      const messages = meshRef.ai.complete
        ? normalizeForTask(meshRef.ai, args)
        : [];
      const { rows: [task] } = await pool.query(
        `INSERT INTO genie_ai_logs (peer_id, task_type, model, state, prompt, options)
         VALUES ($1, 'chat', $2, 'pending', $3, $4) RETURNING *`,
        [ctx.peerId || null, args.model || meshRef.ai.config.model, JSON.stringify(messages), JSON.stringify({
          temperature: args.temperature, max_tokens: args.max_tokens, timeoutMs: args.timeoutMs,
          model: args.model || meshRef.ai.config.model,
        })]
      );
      return { taskId: Number(task.id), state: task.state };
    },

    'ai.result.get': async (args = {}, ctx = {}) => {
      if (!meshRef.ai) throw new Error('AI relay not configured (set DEEPSEEK_API_KEY)');
      if (!args.id) throw new Error('task id required');
      const task = await meshRef.ai.getTask(ctx.peerId || null, args.id);
      if (!task) throw new Error('task not found');
      return { task };
    },

    // ---- JARV OSINT (satellite comms intelligence, cross-trained) ----
    'osint.handbook': async (args = {}, ctx = {}) => {
      if (!ctx.jarv) throw new Error('JARV agent not available');
      return ctx.jarv.executeTool('jarv_osint_handbook', {});
    },
    'osint.satvision': async (args = {}, ctx = {}) => {
      if (!ctx.jarv) throw new Error('JARV agent not available');
      const allowed = ['lat', 'lon', 'alt', 'satellites', 'passes', 'min_el', 'overhead', 'footprint'];
      for (const k of Object.keys(args || {})) if (!allowed.includes(k)) throw new Error(`unknown osint.satvision param: ${k}`);
      return ctx.jarv.executeTool('jarv_satvision', args);
    },

    // Full JARV chat: AI tool-use loop so JARV answers using its tools
    // (OSINT handbook, jarv_satvision, sandbox read/write/run) mid-conversation.
    'jarv.ask': async (args = {}, ctx = {}) => {
      if (!ctx.jarv) throw new Error('JARV agent not available');
      const text = args.prompt != null ? String(args.prompt) : null;
      if (text == null && !Array.isArray(args.messages)) throw new Error('prompt or messages required');
      return ctx.jarv.ask(text != null ? text : args.messages, {
        maxToolTurns: args.maxToolTurns, model: args.model, max_tokens: args.max_tokens,
      });
    },
  };

  // Normalize a prompt/messages into an array for persistent storage.
  function normalizeForTask(ai, args) {
    if (Array.isArray(args.messages)) {
      return ai.config.systemPrompt && !args.messages.some((m) => m.role === 'system')
        ? [{ role: 'system', content: ai.config.systemPrompt }, ...args.messages]
        : args.messages;
    }
    const msg = [{ role: 'user', content: String(args.prompt || args.input || '') }];
    return ai.config.systemPrompt ? [{ role: 'system', content: ai.config.systemPrompt }, ...msg] : msg;
  }

  let currentJarv = meshRef.jarv;
  function setJarv(j) { currentJarv = j; }

  async function executor(command, args, ctx = {}) {
    const fn = handlers[command];
    if (!fn) throw new Error(`unknown command: ${command}`);
    return fn(args, { ...ctx, jarv: currentJarv });
  }

  executor.setJarv = setJarv;
  return executor;
}
exports.buildExecutor = buildExecutor;
/* ------------------------------------------------------------------ *
 * makeMesh — the main controller: peer seeding, durability helpers, the
 * persistent outbound WebSocket link, and the HTTPS fallback flusher.
 * ------------------------------------------------------------------ */
function makeMesh({ pool, log, config = {}, ai = null, jarv = null }) {
  const cfg = {
    enabled: envBool(config.enabled != null ? config.enabled : process.env.GENIE_MESH_ENABLED, true),
    peerName: config.peerName || DEFAULT_PEER_NAME,
    outboundUrl: config.outboundUrl || process.env.JARV_GENIE_URL || '',
    socketUrl: config.socketUrl || makeSocketUrl(config.outboundUrl || process.env.JARV_GENIE_URL || '') || null,
    outboundToken: config.outboundToken || process.env.JARV_GENIE_OUTBOUND_TOKEN || '',
    inboundKey: config.inboundKey || process.env.JARV_GENIE_API_KEY || '',
    satlink: envBool(config.satlink != null ? config.satlink : process.env.GENIE_SATLINK, false),
    scope: config.scope || 'read-write',
    outboxBatch: Number(config.outboxBatch || process.env.GENIE_OUTBOX_BATCH || 20),
    flushIntervalMs: Number(config.flushIntervalMs || process.env.GENIE_FLUSH_INTERVAL_MS || 15000),
    ackTimeoutMs: Number(config.ackTimeoutMs || (envBool(null, config.satlink || envBool(process.env.GENIE_SATLINK, false)) ? 45000 : 20000)),
    backoffSeconds: Number(config.backoffSeconds || (envBool(null, config.satlink || envBool(process.env.GENIE_SATLINK, false)) ? 30 : 60)),
    socket: config.socket !== false,
    httpFlush: config.httpFlush !== false,
  };
  // Accept a plain fn, a console-like logger ({info}), or nothing.
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const state = {
    stopped: false,
    started: false,
    defaultPeer: null,
    ws: null,
    connected: false,
    sessionId: null,
    wsSessionId: null,
    reconnectDelay: 1000,
    lastError: null,
    lastConnectedAt: null,
    bytesSent: 0,
    bytesReceived: 0,
    lastPongAt: 0,
    pendingBatch: null,
    ackTimer: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    flusherTimer: null,
    pumpTimer: null,
    ai: ai,
    jarv: null,
  };
  const executor = buildExecutor(pool, { getStatus: () => getStatus(), ai: state.ai, jarv: state.jarv });

  function setJarv(j) { state.jarv = j; executor.setJarv(j); }

  async function refreshDefaultPeer() {
    if (!cfg.enabled) { state.defaultPeer = null; return null; }
    // Pass logFn through as cfg.log so a minted inbound API key is printed
    // once at seed time — otherwise the operator can never retrieve it.
    try { state.defaultPeer = await ensurePeerRow(pool, { ...cfg, log: logFn }); }
    catch (e) { logFn(`[genie-mesh] ensurePeerRow failed: ${e.message}`); }
    return state.defaultPeer;
  }

  async function requirePeer() {
    if (!state.defaultPeer) await refreshDefaultPeer();
    return state.defaultPeer;
  }

  /** Outbound domain event → durable outbox. Used by routes/worker. */
  async function emit(eventType, payload) {
    if (!cfg.enabled || state.stopped) return;
    const peer = await requirePeer();
    if (!peer) return;
    try { await pushEvent(pool, peer.id, eventType, payload == null ? {} : payload); }
    catch (e) { logFn(`[genie-mesh] emit ${eventType} failed: ${e.message}`); }
  }

  /** Emit an outbox event scoped to a specific peer (used by AI task results). */
  async function emitTo(peerId, eventType, payload) {
    if (!cfg.enabled || state.stopped || !peerId) return;
    try { await pushEvent(pool, peerId, eventType, payload == null ? {} : payload); }
    catch (e) { logFn(`[genie-mesh] emitTo ${eventType} failed: ${e.message}`); }
  }

  async function verifyKey(key) {
    return verifyPeerKey(pool, key);
  }

  async function setPeerState(status, opts) {
    const peer = await requirePeer();
    if (peer) await setPeerStatus(pool, peer.id, status, opts);
  }

  async function getStatus() {
    const peer = state.defaultPeer || await requirePeer();
    let outbox = { pending: 0, sending: 0, delivered: 0, failed: 0 };
    let peers = [];
    let sessions = [];
    if (cfg.enabled && peer) {
      try { outbox = await outboxStats(pool, peer.id); } catch (e) {}
      try { peers = await listPeers(pool); } catch (e) {}
      try { sessions = await recentSessions(pool, peer.id, 5); } catch (e) {}
    }
    return {
      version: MESH_VERSION,
      enabled: cfg.enabled,
      mode: cfg.satlink ? 'satellite' : 'terrestrial',
      peer: peer ? { name: peer.name, status: peer.status, scope: peer.scope, satlink: peer.satlink, last_seen_at: peer.last_seen_at } : null,
      outbound: {
        url: cfg.outboundUrl || (peer && peer.endpoint_url) || null,
        socket: state.connected,
        socketPath: cfg.outboundUrl || null,
        lastConnectedAt: state.lastConnectedAt ? new Date(state.lastConnectedAt).toISOString() : null,
        lastError: state.lastError,
        reconnectDelayMs: state.reconnectDelay,
        bytesSent: state.bytesSent,
        bytesReceived: state.bytesReceived,
      },
      outbox,
      sessions,
      ai: state.ai ? await state.ai.getStatus().catch(() => null) : null,
    };
  }

  function stop() {
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.ackTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.flusherTimer);
    clearInterval(state.pumpTimer);
    if (state.wsSessionId) closeSession(pool, state.wsSessionId, 'disconnected', 'mesh stopped').catch(() => {});
    try { if (state.ws) state.ws.close(4001, 'mesh stopped'); } catch (e) {}
  }

  async function start() {
    if (!cfg.enabled) { logFn('[genie-mesh] disabled (GENIE_MESH_ENABLED=false).'); return; }
    await refreshDefaultPeer();
    if (!state.defaultPeer) { logFn('[genie-mesh] no peer row available; mesh idle.'); return; }
    startOutboundLink();
    startFlusher();
    state.started = true;
    logFn(`[genie-mesh] started (peer=${state.defaultPeer.name}, mode=${cfg.satlink ? 'satellite' : 'terrestrial'}, outbound_socket=${cfg.socket && !!cfg.outboundUrl})`);
  }
/* -------- persistent outbound WebSocket link -------- */
  // Prefer the native global `WebSocket` (Node 23+), fall back to the `ws`
  // package (Node 20 LTS / node:20-alpine Docker image). Without this, the
  // outbound socket is silently disabled in every production deployment.
  let WebSocketCtor = null;
  if (typeof WebSocket === 'function') {
    WebSocketCtor = WebSocket;
  } else {
    try { WebSocketCtor = require('ws'); } catch (e) { WebSocketCtor = null; }
  }
  const hasNativeWs = !!WebSocketCtor;

  function startOutboundLink() {
    if (!cfg.socket) return;
    if (!hasNativeWs) {
      logFn('[genie-mesh] No WebSocket implementation available (install the ws package or upgrade Node); outbound socket disabled (HTTPS flusher still active).');
      return;
    }
    if (!cfg.outboundUrl) {
      logFn('[genie-mesh] JARV_GENIE_URL not set; outbound socket idle (HTTPS flusher still active).');
      return;
    }
    const connect = () => {
      if (state.stopped) return;
      state.lastError = null;
      let ws;
      try {
        ws = new WebSocketCtor(cfg.socketUrl || cfg.outboundUrl, 'fortress-genie-mesh');
      } catch (e) {
        state.lastError = String((e && e.message) || e);
        scheduleReconnect();
        return;
      }
      state.ws = ws;

      ws.addEventListener('open', () => {
        if (state.stopped) return;
        state.connected = true;
        state.sessionId = crypto.randomUUID();
        state.lastConnectedAt = Date.now();
        state.reconnectDelay = 1000;
        state.lastPongAt = Date.now();
        const peer = state.defaultPeer;
        send({
          type: 'hello', version: MESH_VERSION, peer: peer && peer.name,
          sessionId: state.sessionId, token: cfg.outboundToken || '', satlink: cfg.satlink,
        });
        if (peer) {
          setPeerState('online').catch(() => {});
          openSession(pool, peer.id, 'ws').then((id) => { state.wsSessionId = id; }).catch(() => {});
        }
        void flushLoop();
      });

      ws.addEventListener('message', (ev) => {
        const size = typeof ev.data === 'string' ? Buffer.byteLength(ev.data) : String(ev.data).length;
        state.bytesReceived += size;
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
        void handleIncoming(msg);
      });

      ws.addEventListener('close', (ev) => {
        state.connected = false;
        if (state.wsSessionId) {
          closeSession(pool, state.wsSessionId, 'disconnected', `socket closed ${ev.code} ${ev.reason || ''}`).catch(() => {});
          state.wsSessionId = null;
        }
        if (state.defaultPeer) setPeerState('reconnecting', { error: `socket closed ${ev.code}` }).catch(() => {});
        scheduleReconnect();
      });

      ws.addEventListener('error', (e) => {
        state.lastError = String((e && e.message) || 'websocket error');
      });
    };

    const send = (obj) => {
      const ws = state.ws;
      if (!state.connected || !ws || ws.readyState !== 1) return false;
      try {
        const text = JSON.stringify(obj);
        ws.send(text);
        state.bytesSent += Buffer.byteLength(text);
        return true;
      } catch (e) { return false; }
    };

    async function handleIncoming(msg) {
      const peer = state.defaultPeer;
      switch (msg && msg.type) {
        case 'pong':
          state.lastPongAt = Date.now();
          break;
        case 'ack': {
          clearTimeout(state.ackTimer);
          state.pendingBatch = null;
          const ids = (msg.ids || msg.delivered || []).map(Number).filter((n) => Number.isFinite(n));
          if (ids.length && peer) await deliverBatch(pool, peer.id, ids).catch(() => {});
          void flushLoop();
          break;
        }
        case 'command': {
          const t0 = Date.now();
          let ok = false, data = null, error = null;
          try { data = await executor(msg.command, msg.args || {}, { peerId: peer && peer.id }); ok = true; }
          catch (e) { error = String((e && e.message) || e); }
          if (msg.id != null) send({ type: 'reply', id: msg.id, ok, data, error });
          if (peer) await logCommand(pool, peer.id, msg.command || '?', ok ? 'ok' : 'error', Date.now() - t0).catch(() => {});
          break;
        }
        case 'ping':
          send({ type: 'pong', t: Date.now() });
          break;
        default:
          break;
      }
    }
    async function flushLoop() {
      if (!state.connected || state.stopped) return;
      if (state.pendingBatch) return; // one in-flight batch at a time
      const peer = state.defaultPeer;
      if (!peer) return;
      try {
        const batch = await claimBatch(pool, peer.id, cfg.outboxBatch, cfg.backoffSeconds);
        if (!batch.length) return;
        const payload = batch.map((b) => ({ id: Number(b.id), event_type: b.event_type, payload: b.payload }));
        const sent = send({ type: 'push', sessionId: state.sessionId, batch: payload });
        if (!sent) {
          await failBatch(pool, peer.id, payload.map((p) => p.id), 'socket not writable', cfg.backoffSeconds).catch(() => {});
          return;
        }
        state.pendingBatch = payload;
        clearTimeout(state.ackTimer);
        state.ackTimer = setTimeout(async () => {
          if (!state.pendingBatch) return;
          const stuck = state.pendingBatch;
          state.pendingBatch = null;
          await failBatch(pool, peer.id, stuck.map((p) => p.id), 'ack timeout', cfg.backoffSeconds).catch(() => {});
          void flushLoop();
        }, cfg.ackTimeoutMs);
      } catch (e) {
        logFn(`[genie-mesh] flushLoop error: ${(e && e.message) || e}`);
      }
    }

    function scheduleReconnect() {
      if (state.stopped) return;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
      if (state.reconnectDelay < 60000) state.reconnectDelay = Math.min(60000, state.reconnectDelay * 2);
    }

    connect();
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      if (!state.connected) return;
      if (Date.now() - state.lastPongAt > 3 * 25000) {
        try { state.ws && state.ws.close(4000, 'heartbeat timeout'); } catch (e) {}
        return;
      }
      send({ type: 'ping', t: Date.now() });
    }, 25000);

    // Pump: regularly checks the outbox while connected so events emitted
    // between acks still stream live (critical for a "connected forever" link).
    clearInterval(state.pumpTimer);
    state.pumpTimer = setInterval(() => {
      if (!state.stopped && state.connected) void flushLoop();
    }, Math.max(1000, Math.round(cfg.flushIntervalMs / 5)));
  }

  /* -------- HTTPS fallback flusher (works when the socket is down) -------- */
  function postJson(urlString, bodyStr, useGzip, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(urlString); } catch (e) { return reject(e); }
      const lib = u.protocol === 'https:' ? https : http;
      const payload = useGzip ? zlib.gzipSync(Buffer.from(bodyStr)) : Buffer.from(bodyStr);
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'User-Agent': `fortress-genie-mesh/${MESH_VERSION}`,
          ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
        },
        timeout: timeoutMs || 20000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch (e) { resolve({ error: 'non-json response from remote' }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function startFlusher() {
    if (!cfg.httpFlush) return;
    setTimeout(() => void httpFlush(), 5000);
    clearInterval(state.flusherTimer);
    state.flusherTimer = setInterval(() => {
      if (state.stopped) return;
      const peerId = state.defaultPeer && state.defaultPeer.id;
      if (!peerId) return;
      // Sweep stale 'sending' rows back to pending (satellite drop safety net).
      const threshold = Math.max(cfg.backoffSeconds, Math.ceil(cfg.ackTimeoutMs / 1000) * 2);
      requeueStale(pool, peerId, threshold).catch(() => {});
      if (!state.connected) void httpFlush();
    }, cfg.flushIntervalMs);
  }

  async function httpFlush() {
    if (state.stopped) return;
    const peer = state.defaultPeer;
    if (!peer) return;
    const endpoint = cfg.outboundUrl || peer.endpoint_url;
    if (!endpoint || !/^https?:/i.test(endpoint)) return;
    const inboxUrl = makeInboxPath(endpoint);
    if (!inboxUrl) return;
    if (state.connected) return; // socket is healthy; don't double-send
    const batch = await claimBatch(pool, peer.id, cfg.outboxBatch, cfg.backoffSeconds).catch(() => []);
    if (!batch.length) return;
    const body = JSON.stringify({
      peer: peer.name,
      token: cfg.outboundToken || '',
      batch: batch.map((b) => ({ id: Number(b.id), event_type: b.event_type, payload: b.payload })),
      sentAt: nowIso(),
      satlink: cfg.satlink,
    });
    let reply;
    try {
      reply = await postJson(inboxUrl, body, cfg.satlink, cfg.ackTimeoutMs);
    } catch (e) {
      await failBatch(pool, peer.id, batch.map((b) => Number(b.id)), (e && e.message) || 'http flush failed', cfg.backoffSeconds).catch(() => {});
      return;
    }
    const ids = (reply && (reply.acked || reply.delivered)) || [];
    if (ids.length) {
      await deliverBatch(pool, peer.id, ids.map(Number)).catch(() => {});
    } else {
      await failBatch(pool, peer.id, batch.map((b) => Number(b.id)), (reply && reply.error) || 'no ack from remote', cfg.backoffSeconds).catch(() => {});
    }
  }

  /** Claim pending outbox rows for out-of-band delivery (Telegram tunnel). */
  async function claimOutbox(limit = cfg.outboxBatch) {
    const { rows } = await pool.query(
      'SELECT id, event_type, payload, attempts, created_at FROM genie_outbox WHERE status = \'pending\' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [limit],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    await pool.query(
      `UPDATE genie_outbox SET status = 'sending' WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
      ids,
    ).catch(() => {});
    return rows;
  }

  /** Mark claimed outbox rows as delivered after a successful push. */
  async function markOutboxDelivered(ids) {
    if (!ids || !ids.length) return;
    await pool.query(
      `UPDATE genie_outbox SET status = 'delivered' WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
      ids.map(Number),
    ).catch((e) => logFn(`[genie-mesh] markOutboxDelivered failed: ${e.message}`));
  }

  return {
    start, stop, emit, emitTo, getStatus, verifyKey, setPeerState,
    requirePeer, refreshDefaultPeer, executor, claimOutbox, markOutboxDelivered,
    listPeers: () => listPeers(pool),
    ai: state.ai,
    config: cfg,
    setJarv,
  };
}

exports.makeMesh = makeMesh;
/* ------------------------------------------------------------------ *
 * createGenieApi — REST gateway for JARV-Genie (agentic access).
 * Every call must present the peer API key via `X-Genie-Key`. All commands
 * are logged to genie_commands. Small, satellite-friendly payloads.
 * ------------------------------------------------------------------ */
function createGenieApi({ pool, mesh, rateLimit, log }) {
  const express = require('express'); // lazy: only the backend has express
  const router = express.Router();
  // Accept a plain fn, a console-like logger ({info}), or nothing.
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});

  router.use(async (req, res, next) => {
    const key = req.get('x-genie-key') || (req.body && req.body._key) || (req.query && req.query.key);
    if (!key) return res.status(401).json({ error: 'X-Genie-Key header required' });
    const peer = await mesh.verifyKey(key).catch(() => null);
    if (!peer) return res.status(401).json({ error: 'unauthorized' });
    if (peer.scope === 'read' && req.method !== 'GET') {
      return res.status(403).json({ error: 'peer is configured read-only' });
    }
    req.geniePeer = peer;
    if (rateLimit) {
      const rl = rateLimit(`genie:${peer.name}`);
      if (rl.blocked) return res.status(429).json({ error: 'rate limited', retryInSeconds: rl.remainingSeconds });
    }
    next();
  });

  // Wraps the shared executor with audit logging + latency.
  async function runAs(req, res, command, args) {
    const t0 = Date.now();
    try {
      const data = await mesh.executor(command, args, { peerId: req.geniePeer.id });
      await logCommand(pool, req.geniePeer.id, command, 'ok', Date.now() - t0).catch(() => {});
      res.json(data);
    } catch (e) {
      const status = /(not found|required)/i.test(String((e && e.message) || e)) ? 404 : 400;
      await logCommand(pool, req.geniePeer.id, command, 'error', Date.now() - t0).catch(() => {});
      res.status(status).json({ error: String((e && e.message) || e) });
    }
  }

  router.get('/status', (req, res) => void runAs(req, res, 'status', {}));
  router.get('/profiles', (req, res) => void runAs(req, res, 'profiles.list', {}));
  router.get('/receipts', (req, res) => void runAs(req, res, 'receipts.list', {
    profileId: req.query.profileId, startDate: req.query.startDate, endDate: req.query.endDate,
    category: req.query.category, limit: req.query.limit,
  }));
  router.get('/receipts/:id', (req, res) => void runAs(req, res, 'receipts.get', { id: req.params.id }));
  router.patch('/receipts/:id', (req, res) => void runAs(req, res, 'receipts.update', { id: req.params.id, patch: req.body }));
  router.post('/receipts/:id/notes', (req, res) => void runAs(req, res, 'receipts.notes', {
    id: req.params.id, business_notes: req.body && req.body.business_notes,
  }));
  router.get('/daily-summary', (req, res) => void runAs(req, res, 'daily.summary', { profileId: req.query.profileId }));
  router.get('/analytics/spending-trends', (req, res) => void runAs(req, res, 'analytics.trends', {
    profileId: req.query.profileId, months: req.query.months,
  }));

  // ---- Genie AI relay (Free DeepSeek V4 as JARV-Genie's main brain) ----
  // Same key-auth + rate-limit + audit as everything else; the heavy lifting
  // happens on Fortress Hub's internet leg, so the peer only needs to reach us.
  if (mesh.ai) {
    router.get('/ai/status', (req, res) => void runAs(req, res, 'ai.status', {}));
    router.post('/ai/complete', (req, res) => void runAs(req, res, 'ai.complete', req.body || {}));
    router.post('/ai/chat', (req, res) => void runAs(req, res, 'ai.chat', req.body || {}));
    router.post('/ai/task', (req, res) => void runAs(req, res, 'ai.task', req.body || {}));
    router.get('/ai/task/:id', (req, res) => void runAs(req, res, 'ai.result.get', { id: req.params.id }));
  }

  // ---- JARV OSINT (satellite comms intelligence over the mesh) ----
  router.get('/osint/handbook', (req, res) => void runAs(req, res, 'osint.handbook', {}));
  router.get('/osint/satvision', (req, res) => void runAs(req, res, 'osint.satvision', {
    lat: req.query.lat, lon: req.query.lon, alt: req.query.alt,
    satellites: req.query.satellites, passes: req.query.passes,
    min_el: req.query.min_el, overhead: req.query.overhead, footprint: req.query.footprint,
  }));
  router.post('/osint/satvision', (req, res) => void runAs(req, res, 'osint.satvision', req.body || {}));
  router.post('/jarv/ask', (req, res) => void runAs(req, res, 'jarv.ask', req.body || {}));

    // Pull-mode delivery: the peer fetches pending outbox events over REST
  // (satellite-friendly: works with high delay, tiny round-trips), then acks.
  router.get('/outbox', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    const batch = await claimBatch(pool, req.geniePeer.id, limit, 900).catch(() => []);
    res.json({ batch: batch.map((b) => ({ id: Number(b.id), event_type: b.event_type, payload: b.payload })) });
  });

  // Lightweight comms health (REST alias of the comms.status socket command).
  // JARV-Genie over sat links can hit this without going through the socket.
  router.get('/comms/status', (req, res) => void runAs(req, res, 'comms.status', {}));

  router.post('/outbox/ack', async (req, res) => {
    const ids = (req.body && (req.body.ids || req.body.delivered)) || [];
    const n = await deliverBatch(pool, req.geniePeer.id, ids.map(Number));
    res.json({ acked: n });
  });

  // External events FROM JARV-Genie INTO Fortress Hub (voice notes, alerts,
  // agent announcements). Audited, then broadcast to live dashboard clients.
  router.post('/events', async (req, res) => {
    const { event_type: eventType, payload = {} } = req.body || {};
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ error: 'event_type required' });
    }
    await logCommand(pool, req.geniePeer.id, `event:${eventType}`, 'ok', 0).catch(() => {});
    if (req.app && req.app.settings['genie:io']) {
      req.app.settings['genie:io'].emit('genie:event', { eventType, payload, from: req.geniePeer.name });
    }
    res.json({ ok: true });
  });

  // Ultra-light endpoint for high-latency sat links: up-to-date in a few bytes.
  router.get('/health-comms', async (req, res) => {
    const stats = await outboxStats(pool, req.geniePeer.id).catch(() => ({}));
    res.json({
      ok: true, t: Date.now(), link: req.geniePeer.status, backlog: stats.pending || 0,
      mode: mesh.config.satlink ? 'sat' : 'land',
    });
  });

  return router;
}
exports.createGenieApi = createGenieApi;

/* ------------------------------------------------------------------ *
 * attachInboundSocket — Socket.IO namespace on the existing http server so
 * JARV-Genie can hold a persistent inbound connection to Fortress Hub.
 * Reuses the Server instance already created by server.js (no new deps).
 * ------------------------------------------------------------------ */
function attachInboundSocket({ io, mesh, pool, log }) {
  // Accept a plain fn, a console-like logger ({info}), or nothing.
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const ns = io.of('/genie');
  // Auth: token in handshake.auth.token OR x-genie-key header matches a peer key.
  ns.use((socket, next) => {
    const key = (socket.handshake.auth && socket.handshake.auth.token)
      || (socket.handshake.headers && socket.handshake.headers['x-genie-key']);
    mesh.verifyKey(key)
      .then((peer) => {
        if (!peer) return next(new Error('unauthorized'));
        socket.geniePeer = peer;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });

  ns.on('connection', (socket) => {
    const peer = socket.geniePeer;
    logFn(`[genie-mesh] inbound socket connected: ${peer.name} (#${socket.id})`);
    mesh.setPeerState('online', { lastSeen: nowIso() }).catch(() => {});
    let sessionId = null;
    openSession(pool, peer.id, 'socket').then((id) => { sessionId = id; }).catch(() => {});

    const runCommand = async (msg = {}) => {
      const t0 = Date.now();
      let ok = false, data = null, error = null;
      try { data = await mesh.executor(msg.command, msg.args || {}, { peerId: peer.id }); ok = true; }
      catch (e) { error = String((e && e.message) || e); }
      if (msg.id != null) socket.emit('mesh:reply', { id: msg.id, ok, data, error });
      await logCommand(pool, peer.id, msg.command || '?', ok ? 'ok' : 'error', Date.now() - t0).catch(() => {});
    };

    socket.on('mesh:command', (msg) => void runCommand(msg));
    socket.on('mesh:ping', () => socket.emit('mesh:pong', { t: Date.now() }));

    socket.once('disconnect', (reason) => {
      if (sessionId) closeSession(pool, sessionId, 'disconnected', reason).catch(() => {});
      logFn(`[genie-mesh] inbound socket disconnected: ${peer.name} (${reason})`);
    });
  });

  return ns;
}
exports.attachInboundSocket = attachInboundSocket;