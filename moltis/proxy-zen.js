#!/usr/bin/env node
// Fortress Zen bridge — OpenAI-compatible /v1 -> the opencode CLI account session.
// Lets Moltis (and anything OpenAI-compatible) reach big-pickle THROUGH the same
// logged-in opencode account that powers the editor, instead of the quota-capped
// OPENCODE_API_KEY. Each /chat/completions shells `opencode run -m opencode/big-pickle`.
//
// Endpoints:
//   GET  /v1/models
//   POST /v1/chat/completions   (stream=true emits SSE, otherwise JSON)
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 63851);
const MODEL = process.env.MODEL || 'opencode/nemotron-3.5-lightning-free';
const OPENCODE = process.env.OPENCODE_BIN || 'opencode';
const WORKDIR = process.env.FORTRESS_WORKDIR || process.env.HOME;
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 3);
// Full read/write/bash on the host: `opencode run --auto` auto-approves tools not
// explicitly denied (this gateway is bound to 127.0.0.1 behind password+TLS auth,
// and the user explicitly wants the openchamber/openCode-equivalent power here).
const AUTO = process.env.BRIDGE_AUTO !== '0';

let inflight = 0;

// Local id -> opencode account model. Anything prefixed openai/ (Moltis slot)
// or bare is translated; unknown ids fall back to MODEL so the slot always works.
const ALIASES = {
  'big-pickle': 'opencode/big-pickle',
  nemotron: 'opencode/nemotron-3-ultra-free',
  'nemotron-3-ultra-free': 'opencode/nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free': 'opencode/nemotron-3.5-lightning-free',
  'mimo-v2.5-free': 'opencode/mimo-v2.5-free',
  'ling-3.0-flash-fin-free': 'opencode/ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free': 'opencode/muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free': 'opencode/muse-spark-1.3-contributor-free',
  'ollama-cloud/nemotron-3-nano:30b': 'ollama-cloud/nemotron-3-nano:30b',
  'ollama-cloud/nemotron-3-super': 'ollama-cloud/nemotron-3-super',
  'ollama-cloud/nemotron-3-ultra': 'ollama-cloud/nemotron-3-ultra',
};
ALIASES['opencode/big-pickle'] = 'opencode/big-pickle';
for (const k of Object.keys(ALIASES)) ALIASES['openai/' + k] = ALIASES[k];

function mapModel(reqId) {
  return ALIASES[String(reqId || '')] || MODEL;
}

const MODELS = [...new Set(Object.keys(ALIASES))].map((id) => ({ id, object: 'model', owned_by: 'opencode' }));

function promptFrom(messages) {
  const parts = [];
  for (const m of messages || []) {
    const role = String(m.role || 'user');
    const text = String(m.content || '').trim();
    if (!text) continue;
    if (role === 'system') {
      // Replace Moltis doctrine with a clean opencode system prompt.
      // The Moltis skill/doctrine belongs in Moltis's agent loop; opencode needs
      // a practical coding-agent prompt, not "spawn sub-agents via fortress bridge".
      parts.push('SYSTEM INSTRUCTIONS:\nYou are a senior engineer with full read/write/execute access on this Mac. Use tools (bash, read, write, edit, grep, glob, task) to accomplish tasks. Be concise and direct.');
    } else if (role === 'user') parts.push('USER:\n' + text);
    else if (role === 'assistant') parts.push('ASSISTANT:\n' + text);
  }
  return parts.join('\n\n');
}

function runOpencode(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = AUTO ? ['run', '-m', model, '--auto', prompt || '(continue)'] : ['run', '-m', model, prompt || '(continue)'];
    const child = spawn(OPENCODE, args, { cwd: WORKDIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const hard = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
    child.on('error', (e) => { clearTimeout(hard); reject(e); });
    child.on('close', (code) => {
      clearTimeout(hard);
      if (code !== 0) return reject(new Error((stderr || 'opencode exited ' + code).trim().slice(0, 500)));
      const trimmed = stdout.trim();
      resolve(trimmed.replace(/^\s*>\s*.*\n?/, '').trim() || '(no reply)');
    });
  });
}

function completionBody(reqId, model, content) {
  return {
    id: reqId, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseChunk(reqId, model, delta, finish) {
  return 'data: ' + JSON.stringify({
    id: reqId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model, choices: [{ index: 0, delta, finish_reason: finish || null }],
  }) + '\n\n';
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 4e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && url === '/v1/models') return json(res, 200, { object: 'list', data: MODELS });
  if (req.method !== 'POST' || !url.endsWith('/v1/chat/completions')) return json(res, 404, { error: { message: 'not found', type: 'not_found' } });

  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: { message: 'bad json', type: 'parse_error' } }); }
  const stream = body.stream === true;
  const reqId = 'fortress-' + Math.random().toString(36).slice(2, 10);
  const prompt = promptFrom(body.messages);
  const model = mapModel(body.model);

  if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: { message: 'too many concurrent requests', type: 'rate_limit' } });
  inflight++;
  const done = () => { inflight = Math.max(0, inflight - 1); };

  try {
    const t0 = Date.now();
    const content = await runOpencode(prompt, model);
    console.log(new Date().toISOString(), `zen-bridge ok model=${model} ms=${Date.now() - t0} reply=${String(content).slice(0, 60).trim()}`);
    done();
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(sseChunk(reqId, model, { role: 'assistant', content: '' }, null));
      res.write(sseChunk(reqId, model, { content }, null));
      res.write(sseChunk(reqId, model, {}, 'stop'));
      res.end('data: [DONE]\n\n');
    } else {
      json(res, 200, completionBody(reqId, model, content));
    }
  } catch (e) {
    done();
    console.error(new Date().toISOString(), 'zen-bridge error:', String(e && e.message || e).slice(0, 300));
    json(res, 502, { error: { message: String(e && e.message || e), type: 'upstream_error' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zen-bridge] OpenAI-compatible ${MODEL} on http://127.0.0.1:${PORT}/v1 (cwd=${WORKDIR})`);
});