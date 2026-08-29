'use strict';
/**
 * aiBridge.js — the "brain" relay for JARV-Genie.
 *
 * Makes a free DeepSeek V4 model (or any OpenAI-compatible endpoint / a
 * self-hosted DeepSeek V4 server via Ollama/vLLM) permanently available to
 * JARV-Genie as its main model. The key property: Fortress Hub does the
 * internet leg, so JARV-Genie only ever needs to reach the hub — over ANY
 * comms path (Starlink, cellular, LoRa-wrapped, whatever the mesh provides).
 *
 * Modes
 *  1. SYNC     ai.complete / ai.chat   — direct request/response over any
 *             transport (REST /api/genie/ai/*, Socket.IO /genie, outbound WS).
 *  2. ASYNC    ai.task                 — prompt is written to the durable
 *             genie_ai_logs queue first. A background processor calls the
 *             model and the result is delivered back through the genie_outbox
 *             ('ai.result' event) exactly like any other mesh event, plus a
 *             REST poll endpoint. Nothing is lost on a satellite hop.
 *
 * The provider mesh tries, in order: any custom OpenAI-compatible endpoint
 * (DEEPSEEK_BASE_URL style config), then every free-tier cloud host that has
 * a key installed (Groq, Cerebras, Gemini, Mistral, OpenRouter :free, NVIDIA
 * NIM, SambaNova, GitHub Models, Cohere), then the LOCAL quantized tier
 * (Ollama on this machine — works with zero internet), and finally the
 * keyless Pollinations relay. Rate limits (429) and quota walls (402) put a
 * provider on a short circuit-breaker cooldown instead of failing the call.
 * Medicinal/medical prompts are answered by the local tier only when
 * GENIE_AI_PRIVACY_LOCAL is on (default) and always carry a safety prompt.
 *
 * No new npm dependencies: uses http/https (same pattern as the mesh) and the
 * pg Pool the backend already owns.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const AI_VERSION = '2.0.0';
const DEFAULT_MODELS = ['deepseek-v4', 'deepseek-chat', 'deepseek-reasoner'];

/**
 * Free-tier provider registry — every entry is either a genuinely free tier
 * or free with a signup key. All endpoints are OpenAI-compatible
 * (/chat/completions), so one request path serves the whole mesh.
 * Order here is the default failover order; override with GENIE_AI_PROVIDERS.
 */
const PROVIDERS = [
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  { name: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY',
    models: ['llama-3.3-70b', 'llama3.1-8b'] },
  { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash'] },
  { name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY',
    models: ['mistral-small-latest', 'open-mistral-nemo'] },
  { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
    models: ['deepseek/deepseek-chat-v3.1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-72b-instruct:free', 'google/gemma-3-27b-it:free'] },
  { name: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY',
    models: ['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct'] },
  { name: 'sambanova', baseUrl: 'https://api.sambanova.ai/v1', keyEnv: 'SAMBANOVA_API_KEY',
    models: ['Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.3-70B-Instruct'] },
  { name: 'github', baseUrl: 'https://models.github.ai/inference', keyEnv: 'GITHUB_MODELS_TOKEN',
    models: ['openai/gpt-4o-mini', 'meta/Llama-3.1-8B-Instruct'] },
  { name: 'cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', keyEnv: 'COHERE_API_KEY',
    models: ['command-r7b-12-2024'] },
  // LOCAL offline tier: quantized models on this machine. No key, no internet.
  { name: 'ollama', baseUrl: null, keyEnv: null, local: true,
    models: ['llama3.2', 'qwen3:1.7b', 'qwen2.5:0.5b'] },
  // Keyless anonymous relay — last resort only (rate-limited, no SLA).
  { name: 'pollinations', baseUrl: 'https://text.pollinations.ai', keyEnv: null, anonymous: true,
    models: ['openai'] },
];

/** Medical-safety persona appended to any medicinal/medical inquiry. */
const MEDICAL_SAFETY_PROMPT = [
  'You are JARV-Genie, a safety-first assistant. This conversation may involve health or medicinal topics.',
  'Rules: (1) You are not a doctor and never diagnose; give general, educational information only.',
  '(2) Never recommend specific doses, prescriptions, or drug combinations — say "ask a pharmacist or clinician".',
  '(3) If the situation could be an emergency (chest pain, trouble breathing, overdose, suicidal thoughts, severe bleeding), tell the person to contact local emergency services immediately.',
  '(4) Prefer conservative, widely-accepted guidance and cite uncertainty honestly.',
  '(5) Be calm, kind, and practical. Never invent drug interactions.',
].join(' ');

/** Heuristic detector for medicinal/medical prompts (privacy + safety routing). */
const MEDICAL_TERMS = [
  'medic', 'dose', 'dosage', 'dosing', 'symptom', 'diagnos', 'prescri', 'pharmac', 'medication',
  'treatment', 'therapy', 'fever', 'infection', 'inflammation', 'blood pressure', 'glucose',
  'insulin', 'antibiotic', 'painkiller', 'ibuprofen', 'paracetamol', 'acetaminophen', 'overdose',
  'suicid', 'chest pain', 'emergency room', 'er visit', 'pill', 'tablet', 'mg per',
].join('|');

function envBool(value, def) {
  if (value == null || value === '') return def;
  return !/^(false|0|off|no)$/i.test(String(value));
}

/**
 * Minimal JSON request helper over http/https (works on every Node the app
 * already supports; mirrors the mesh's postJson pattern).
 */
function requestJson(method, urlString, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj));
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers
      ),
      timeout: timeoutMs || 30000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = (parsed && parsed.error && (parsed.error.message || parsed.error))
          || `HTTP ${res.statusCode}`;
        const err = new Error(String(msg));
        err.status = res.statusCode;
        err.body = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('ai request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
exports.requestJson = requestJson;
/**
 * makeAiBridge — the AI relay controller.
 *   options: { pool, log, config, transport?, getMesh? }
 *   - transport: optional async fn(messages, opts) for tests/self-host,
 *     defaults to the DeepSeek OpenAI-compatible HTTP client.
 *   - getMesh: optional fn() returning the mesh (used to emitTo peers).
 */
function makeAiBridge({ pool, log, config = {}, transport, getMesh }) {
  const cfg = {
    enabled: envBool(config.enabled != null ? config.enabled : process.env.GENIE_AI_ENABLED, true),
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (config.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: config.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4',
    fallbackModels: (config.fallbackModels || process.env.DEEPSEEK_FALLBACK_MODELS || DEFAULT_MODELS.join(',')).split(',').map(s => s.trim()).filter(Boolean),
    systemPrompt: config.systemPrompt || process.env.DEEPSEEK_SYSTEM_PROMPT || '',
    maxTokens: Number(config.maxTokens || process.env.DEEPSEEK_MAX_TOKENS || 2000),
    temperature: Number(config.temperature || process.env.DEEPSEEK_TEMPERATURE || 0.7),
    free: envBool(config.free != null ? config.free : process.env.DEEPSEEK_FREE, true),
    // --- free-tier mesh configuration ---
    providerOrder: (config.providerOrder || process.env.GENIE_AI_PROVIDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    localFirst: envBool(config.localFirst != null ? config.localFirst : process.env.GENIE_AI_LOCAL_FIRST, false),
    privacyLocal: envBool(config.privacyLocal != null ? config.privacyLocal : process.env.GENIE_AI_PRIVACY_LOCAL, true),
    ollamaBaseUrl: (config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    ollamaModels: (config.ollamaModels || process.env.OLLAMA_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    safetyPrompt: config.safetyPrompt != null ? String(config.safetyPrompt)
      : (process.env.GENIE_AI_SAFETY_PROMPT != null ? process.env.GENIE_AI_SAFETY_PROMPT : MEDICAL_SAFETY_PROMPT),
    pollIntervalMs: Number(config.pollIntervalMs || process.env.GENIE_AI_POLL_MS || 8000),
    maxBatch: Number(config.maxBatch || process.env.GENIE_AI_BATCH || 5),
    auto: config.auto !== false,
  };
  // Accept a plain fn, a console-like logger ({info}), or nothing.
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const state = {
    started: false, stopped: false, timer: null, processing: false,
    lastError: null, lastLatencyMs: null, lastModelUsed: null,
    lastProviderUsed: null, providerHealth: {},
  };
  const callModel = transport || meshTransport;

  /** True when text looks medicinal/medical (drives privacy + safety routing). */
  function looksMedical(text) {
    return new RegExp(MEDICAL_TERMS, 'i').test(String(text || ''));
  }

  /** Merge the safety persona into the system slot (prepend if none). */
  function injectSafety(messages) {
    const safety = String(cfg.safetyPrompt || '').trim();
    if (!safety) return messages;
    if (messages.length && messages[0] && messages[0].role === 'system') {
      return [{ role: 'system', content: `${safety}\n\n${messages[0].content}` }, ...messages.slice(1)];
    }
    return [{ role: 'system', content: safety }, ...messages];
  }

  /** Env/config key lookup ('' ⇒ not configured). */
  function resolveKey(keyEnv) {
    if (!keyEnv) return '';
    const raw = config[keyEnv] != null ? config[keyEnv] : (process.env[keyEnv] || '');
    return String(raw).trim();
  }

  function localModels() {
    const o = PROVIDERS.find((p) => p.name === 'ollama');
    return cfg.ollamaModels.length ? cfg.ollamaModels.slice() : (o ? o.models.slice() : ['llama3.2']);
  }

  /** Ordered attempt list. forceLocal pins to on-machine Ollama (privacy). */
  function makeChain(forceLocal) {
    if (forceLocal) {
      return [{ name: 'ollama-local', baseUrl: cfg.ollamaBaseUrl, apiKey: '', local: true, models: localModels() }];
    }
    const chain = [];
    const customKey = String(cfg.apiKey || '').trim();
    if (customKey && cfg.baseUrl) {
      chain.push({
        name: 'custom', baseUrl: cfg.baseUrl, apiKey: customKey,
        models: [cfg.model, ...cfg.fallbackModels].filter((m, i, a) => m && a.indexOf(m) === i),
      });
    }
    let keyed = PROVIDERS.filter((p) => p.keyEnv && resolveKey(p.keyEnv))
      .map((p) => ({ name: p.name, baseUrl: p.baseUrl, apiKey: resolveKey(p.keyEnv), models: p.models.slice() }));
    if (cfg.providerOrder.length) {
      keyed.sort((a, b) => {
        const ia = cfg.providerOrder.indexOf(a.name);
        const ib = cfg.providerOrder.indexOf(b.name);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }
    const localEntry = { name: 'ollama-local', baseUrl: cfg.ollamaBaseUrl, apiKey: '', local: true, models: localModels() };
    const anon = PROVIDERS.filter((p) => p.anonymous)
      .map((p) => ({ name: p.name, baseUrl: p.baseUrl, apiKey: '', anonymous: true, models: p.models.slice(), path: p.path || '/chat/completions' }));
    if (cfg.localFirst) chain.push(localEntry, ...keyed, ...anon);
    else chain.push(...keyed, localEntry, ...anon);
    return chain;
  }

  function chainNames() { return makeChain(false).map((e) => e.name); }
  function meshAvailable() { return chainNames().length > 0; }

  /**
   * One OpenAI-compatible call against a single provider entry. Every
   * registry host (and Ollama) speaks this shape, so one path serves all.
   * `options.tools` (array) + `options.tool_choice` enable function calling,
   * and the raw assistant message (incl. `tool_calls`) is returned for the
   * caller to orchestrate a JARV tool loop.
   */
  async function chatOnce(entry, model, messages, options) {
    const body = { model, messages, temperature: options.temperature, max_tokens: options.max_tokens, stream: false };
    if (options.tools) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;
    const headers = { 'User-Agent': `fortress-genie-mesh/${AI_VERSION}`, 'Content-Type': 'application/json' };
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    const resp = await requestJson('POST', `${entry.baseUrl}${entry.path || '/chat/completions'}`, headers, body, options.timeoutMs || 60000);
    if (!resp || !resp.choices || !resp.choices.length) throw new Error('empty completion response');
    const content = resp.choices[0].message && resp.choices[0].message.content;
    return {
      content: content == null ? '' : String(content),
      message: resp.choices[0].message || null,
      model: resp.model || model,
      usage: resp.usage || null,
      cached: !!(resp.usage && (resp.usage.prompt_cache_hit_tokens || resp.usage.prompt_tokens_details)),
    };
  }

  /**
   * The mesh itself: walk the chain honouring circuit breakers (429 ⇒ 60s,
   * 401/402/403 ⇒ 15min, 5xx ⇒ 30s cooldown), model fallback inside each
   * provider, and privacy pinning. Reports which provider actually answered.
   */
  async function meshTransport(messages, options) {
    const chain = makeChain(!!options.forceLocal);
    const now = Date.now();
    const anyHealthy = chain.some((e) => {
      const h = state.providerHealth[e.name];
      return e.local || !h || !h.cooldownUntil || h.cooldownUntil <= now;
    });
    let lastErr = null;
    for (const entry of chain) {
      const h = state.providerHealth[entry.name]
        || (state.providerHealth[entry.name] = { ok: 0, fail: 0, cooldownUntil: 0, lastError: null });
      if (h.cooldownUntil > now && anyHealthy && !entry.local) continue; // breaker open, others up
      for (const m of entry.models) {
        try {
          const res = await chatOnce(entry, m, messages, options);
          h.ok++; h.cooldownUntil = 0; h.lastError = null;
          state.lastProviderUsed = entry.name;
          return Object.assign(res, { provider: entry.name, local: !!entry.local });
        } catch (e) {
          lastErr = e;
          h.fail++; h.lastError = String((e && e.message) || e);
          if (e.status === 429) h.cooldownUntil = Date.now() + 60000;
          else if (e.status === 401 || e.status === 402 || e.status === 403) h.cooldownUntil = Date.now() + 15 * 60000;
          else if (e.status >= 500) h.cooldownUntil = Date.now() + 30000;
          const modelErr = e.status && (e.status === 400 || e.status === 404) && /model/i.test(String(e.message));
          if (!modelErr) break; // provider-level failure → next provider
        }
      }
    }
    if (options.forceLocal) {
      throw new Error(`privacy-local mode: no local model answered (Ollama at ${cfg.ollamaBaseUrl}); medical prompts are never sent to the cloud. ${lastErr ? lastErr.message : ''}`.trim());
    }
    throw lastErr || new Error('no AI provider in the mesh accepted the request');
  }

  /** Build the OpenAI-style messages array from prompt/messages + system prompt. */
  function normalizeMessages(args = {}) {
    let messages = args.messages;
    if (!Array.isArray(messages)) {
      messages = [{ role: 'user', content: String(args.prompt || args.input || 'Hello') }];
    }
    messages = messages
      .map((m) => (typeof m === 'string' ? { role: 'user', content: m } : m))
      .filter((m) => m && m.role && m.content != null);
    const system = args.system && String(args.system).trim() ? String(args.system).trim() : cfg.systemPrompt.trim();
    if (system && !messages.some((m) => m.role === 'system')) {
      messages = [{ role: 'system', content: system }, ...messages];
    }
    return messages;
  }

  function buildOptions(args = {}) {
    return {
      temperature: args.temperature != null ? Number(args.temperature) : cfg.temperature,
      max_tokens: args.max_tokens != null ? Number(args.max_tokens) : cfg.maxTokens,
      model: args.model || cfg.model,
      timeoutMs: args.timeoutMs || 60000,
      tools: Array.isArray(args.tools) && args.tools.length ? args.tools : null,
      tool_choice: args.tool_choice || undefined,
      maxToolTurns: args.maxToolTurns || 0,
    };
  }


  /** Synchronous completion (request/response, any transport). */
  async function complete(args) {
    // Privacy routing: explicit local pin, or any medicinal content when
    // GENIE_AI_PRIVACY_LOCAL is on (default) — such prompts NEVER leave the
    // machine; they are answered only by the local quantized Ollama tier.
    const textBlob = args.prompt != null ? String(args.prompt) : JSON.stringify(args.messages || []);
    const medical = looksMedical(textBlob);
    const forceLocal = args.local === true || args.forceLocal === true || (cfg.privacyLocal && medical);
    let messages = normalizeMessages(args);
    if (medical || forceLocal) messages = injectSafety(messages);
    const options = Object.assign(buildOptions(args), { forceLocal });
    const t0 = Date.now();
    try {
      const result = await callModel(messages, options);
      state.lastLatencyMs = Date.now() - t0;
      state.lastModelUsed = result.model || options.model;
      state.lastProviderUsed = result.provider || state.lastProviderUsed || (transport ? 'custom-transport' : null);
      state.lastError = null;
      return {
        ok: true,
        provider: result.provider || (transport ? 'custom-transport' : state.lastProviderUsed || 'mesh'),
        local: !!result.local,
        privacy: forceLocal ? 'local-only' : (medical ? 'local-only' : 'standard'),
        model: result.model || options.model,
        reply: result.content, usage: result.usage || null,
        latencyMs: state.lastLatencyMs, cached: !!result.cached,
        tool_calls: (result.message && result.message.tool_calls) || null,
      };
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      state.lastLatencyMs = Date.now() - t0;
      throw e;
    }
  }
  /** Stored columns are JSONB, but tolerate JSON strings (mixed writers/migrations). */
  function parseStoredJson(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  /** Durable async task: persist to genie_ai_logs FIRST, process later. */
  async function createTask({ peerId, taskType = 'chat', messages, options = {} }) {
    const opts = buildOptions(options);
    const { rows } = await pool.query(
      `INSERT INTO genie_ai_logs (peer_id, task_type, model, state, prompt, options)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
      [peerId || null, taskType, opts.model, JSON.stringify(messages || []), JSON.stringify(opts)]
    );
    return rows[0];
  }

  async function getTask(peerId, id) {
    const { rows } = await pool.query(
      'SELECT * FROM genie_ai_logs WHERE id = $1 AND ($2::uuid IS NULL OR peer_id = $2)',
      [id, peerId || null]
    );
    return rows[0] || null;
  }

  /** Atomically claim pending tasks; requeue anything stuck 'processing'. */
  async function claimPending(limit) {
    // Requeue tasks stuck in 'processing' (crash / timeout) after 5 minutes.
    await pool.query(
      `UPDATE genie_ai_logs SET state = 'pending'
        WHERE state = 'processing' AND created_at < NOW() - INTERVAL '5 minutes'`
    ).catch(() => {});
    const { rows } = await pool.query(
      `UPDATE genie_ai_logs g
          SET state = 'processing'
        WHERE g.id IN (
          SELECT id FROM genie_ai_logs
           WHERE state = 'pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id, peer_id, task_type, model, prompt, options`,
      [limit || cfg.maxBatch]
    );
    return rows;
  }

  /** Process one batch of queued tasks, then deliver results via the mesh outbox. */
  async function processPendingBatch(limit) {
    if (state.stopped || state.processing) return { processed: 0 };
    state.processing = true;
    let processed = 0;
    try {
      const rows = await claimPending(limit);
      for (const row of rows) {
        processed++;
        const taskId = Number(row.id);
        const t0 = Date.now();
        const messages = parseStoredJson(row.prompt) || [];
        const storedOpts = parseStoredJson(row.options) || {};
        // Privacy + safety routing for durable tasks too: medicinal content
        // stays on the local quantized tier and gets the safety persona.
        const textBlob = JSON.stringify(messages);
        const medical = looksMedical(textBlob);
        const forceLocal = cfg.privacyLocal && medical;
        const routedMessages = (medical || forceLocal) ? injectSafety(messages) : messages;
        const options = Object.assign({}, storedOpts, {
          model: row.model || storedOpts.model || cfg.model,
        }, forceLocal ? { forceLocal: true } : {});
        try {
          const result = await callModel(routedMessages, options);
          const latency = Date.now() - t0;
          await pool.query(
            `UPDATE genie_ai_logs
                SET state = 'completed', reply = $2, usage = $3, latency_ms = $4, completed_at = NOW(), error = NULL
              WHERE id = $1`,
            [row.id, JSON.stringify(result.content), JSON.stringify(result.usage || null), latency]
          );
          state.lastError = null;
          state.lastModelUsed = result.model || options.model;
          state.lastLatencyMs = latency;
          const m = getMesh && getMesh();
          if (m && m.emitTo) {
            await m.emitTo(row.peer_id, 'ai.result', {
              taskId, ok: true, model: result.model || options.model,
              reply: result.content, usage: result.usage || null, latencyMs: latency,
            }).catch(() => {});
          }
          logFn(`[ai-bridge] task #${taskId} completed (${(result.content || '').length} chars, model=${state.lastModelUsed})`);
        } catch (e) {
          const message = String((e && e.message) || e).slice(0, 1000);
          const latency = Date.now() - t0;
          await pool.query(
            `UPDATE genie_ai_logs
                SET state = 'failed', error = $2, latency_ms = $3, completed_at = NOW()
              WHERE id = $1`,
            [row.id, message, latency]
          );
          state.lastError = message;
          const m = getMesh && getMesh();
          if (m && m.emitTo) {
            await m.emitTo(row.peer_id, 'ai.failed', { taskId, ok: false, error: message }).catch(() => {});
          }
          logFn(`[ai-bridge] task #${taskId} failed: ${message}`);
        }
      }
    } finally {
      state.processing = false;
    }
    return { processed };
  }

  async function getStatus() {
    const tasks = { pending: 0, processing: 0, completed: 0, failed: 0 };
    try {
      const { rows } = await pool.query('SELECT state, COUNT(*)::int AS count FROM genie_ai_logs GROUP BY state');
      for (const r of rows) tasks[r.state] = r.count;
    } catch (e) { /* status is best-effort */ }
    const chain = chainNames();
    const now = Date.now();
    const providerHealth = {};
    for (const [name, h] of Object.entries(state.providerHealth)) {
      providerHealth[name] = {
        ok: h.ok, fail: h.fail,
        cooling: !!(h.cooldownUntil && h.cooldownUntil > now),
        lastError: h.lastError,
      };
    }
    return {
      version: AI_VERSION,
      enabled: cfg.enabled && chain.length > 0,
      tier: cfg.free ? 'free' : 'api',
      free: !!cfg.free,
      provider: state.lastProviderUsed || (chain.includes('custom') ? 'custom' : chain[0] || 'none'),
      providers: chain,
      providerHealth,
      localModels: localModels(),
      privacyLocal: cfg.privacyLocal,
      localFirst: cfg.localFirst,
      configurable: cfg.baseUrl,
      model: cfg.model,
      fallbackModels: cfg.fallbackModels,
      lastModelUsed: state.lastModelUsed,
      lastProviderUsed: state.lastProviderUsed,
      lastError: state.lastError,
      lastLatencyMs: state.lastLatencyMs,
      pendingTasks: tasks.pending,
      tasks,
    };
  }

  function start() {
    if (!cfg.enabled) { logFn('[ai-bridge] GENIE_AI_ENABLED=false — relay disabled.'); return; }
    const chain = chainNames();
    if (chain.length) {
      const keyed = chain.filter((n) => n !== 'ollama-local' && n !== 'pollinations');
      logFn(`[ai-bridge] free-tier mesh active — ${chain.length} provider(s): ${chain.join(' → ')}`);
      if (!keyed.length && !cfg.apiKey) {
        logFn('[ai-bridge] no cloud keys set — running on local Ollama + anonymous relays only; add GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY etc. for the keyed free tier.');
      }
    } else {
      logFn('[ai-bridge] no AI providers available — set DEEPSEEK_API_KEY (or any provider key) or start Ollama locally.');
    }
    if (!cfg.auto) return;
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!state.stopped) void processPendingBatch(); }, cfg.pollIntervalMs);
    void processPendingBatch();
  }

  function stop() {
    state.stopped = true;
    clearInterval(state.timer);
  }

  return {
    start, stop, complete, createTask, getTask, processPendingBatch, getStatus,
    config: cfg,
  };
}

exports.makeAiBridge = makeAiBridge;
exports.requestJson = requestJson;
exports.AI_VERSION = AI_VERSION;