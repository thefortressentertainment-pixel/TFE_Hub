const fs = require('fs');
const path = require('path');

// Master provider registry for cloud API keys editable from the Settings panel.
// `env` is the env var that the aiBridge reads; `active` is filled live from the
// configured failover chain (see listKeys).
const PROVIDERS = [
  { name: 'Groq',            env: 'GROQ_API_KEY',          note: 'fast free tier, Llama/Qwen',            url: 'https://console.groq.com/keys' },
  { name: 'Cerebras',        env: 'CEREBRAS_API_KEY',      note: 'ultra-fast inference',                   url: 'https://cloud.cerebras.ai/' },
  { name: 'Gemini',          env: 'GEMINI_API_KEY',        note: 'Google Gemini',                          url: 'https://aistudio.google.com/apikey' },
  { name: 'Mistral',         env: 'MISTRAL_API_KEY',       note: 'La Plateforme',                          url: 'https://console.mistral.ai/' },
  { name: 'OpenRouter',      env: 'OPENROUTER_API_KEY',    note: 'many models, one key',                   url: 'https://openrouter.ai/keys' },
  { name: 'NVIDIA',          env: 'NVIDIA_API_KEY',        note: 'build.nvidia.com',                       url: 'https://build.nvidia.com/' },
  { name: 'SambaNova',       env: 'SAMBANOVA_API_KEY',     note: 'fast open models',                       url: 'https://cloud.sambanova.ai/' },
  { name: 'GitHub Models',   env: 'GITHUB_MODELS_TOKEN',   note: 'GH PAT with models scope',               url: 'https://github.com/settings/tokens' },
  { name: 'Cohere',          env: 'COHERE_API_KEY',        note: 'Command R',                              url: 'https://dashboard.cohere.com/api-keys' },
  { name: 'SiliconFlow',     env: 'SILICONFLOW_API_KEY',   note: 'China cloud, open models',               url: 'https://cloud.siliconflow.cn/' },
  { name: 'Together',        env: 'TOGETHER_API_KEY',      note: 'open-source router',                     url: 'https://api.together.ai/settings/api-keys' },
  { name: 'HuggingFace',     env: 'HUGGINGFACE_API_KEY',   note: 'HF inference',                           url: 'https://huggingface.co/settings/tokens' },
  { name: 'Fireworks',       env: 'FIREWORKS_API_KEY',     note: 'fast serverless',                        url: 'https://fireworks.ai/account/api-keys' },
  { name: 'Nebius',          env: 'NEBIUS_API_KEY',        note: 'cloud + open models',                    url: 'https://console.nebius.com/settings/api-keys' },
  { name: 'Scaleway',        env: 'SCALEWAY_API_KEY',      note: 'EU cloud, fal-style',                    url: 'https://console.scaleway.com/iam/api-keys' },
  { name: 'Z.AI',            env: 'ZAI_API_KEY',           note: 'Zhipu GLM',                              url: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { name: 'Venice',          env: 'VENICE_API_KEY',        note: 'privacy-first, uncensored',              url: 'https://venice.ai/api-keys' },
  { name: 'Hyperbolic',      env: 'HYPERBOLIC_API_KEY',    note: 'affordable GPU cloud',                   url: 'https://app.hyperbolic.xyz/settings' },
  { name: 'Novita',          env: 'NOVITA_API_KEY',        note: 'many open models',                       url: 'https://novita.ai/settings/key-management' },
  { name: 'Cloudflare',      env: 'CLOUDFLARE_API_KEY',    note: 'Workers AI',                             url: 'https://dash.cloudflare.com/profile/api-tokens' },
  { name: 'Cloudflare Acc.', env: 'CLOUDFLARE_ACCOUNT_ID', note: 'required with Workers AI',               url: 'https://dash.cloudflare.com/' },
];

function envPath() {
  return path.resolve(__dirname, '..', '.env');
}

function mask(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function readEnv() {
  try { return fs.readFileSync(envPath(), 'utf8'); } catch (e) { return ''; }
}

// Parse .env into a map, preserving the raw file for rewrite.
function parseEnv(text) {
  const map = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      val = val.replace(/^["']|["']$/g, '');
      map[m[1]] = val;
    }
  }
  return map;
}

// Upsert KEY=value lines into the .env file, preserving comments/order and any
// lines we do not touch. Values are written without surrounding quotes.
function writeEnv(updates) {
  const file = envPath();
  const text = readEnv();
  const lines = text.split('\n');
  const existingKeys = new Set();
  lines.forEach((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) existingKeys.add(m[1]);
  });
  const out = [];
  let wrote = new Set();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && updates[m[1]] !== undefined) {
      const val = String(updates[m[1]]).trim();
      out.push(`${m[1]}=${val}`);
      wrote.add(m[1]);
    } else {
      out.push(line === '' && out.length ? line : line);
    }
  }
  for (const key of Object.keys(updates)) {
    if (!wrote.has(key)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`${key}=${String(updates[key]).trim()}`);
    }
  }
  fs.writeFileSync(file, out.join('\n').replace(/\n+$/, '\n') + '\n');
}

// List each provider with its configured status (masked) + active-in-chain flag.
function listKeys(activeChain = []) {
  const parsed = parseEnv(readEnv());
  return PROVIDERS.map((p) => {
    const raw = parsed[p.env] != null ? parsed[p.env] : (process.env[p.env] || '');
    return {
      name: p.name,
      env: p.env,
      note: p.note,
      url: p.url,
      set: !!String(raw).trim(),
      masked: mask(raw),
      active: activeChain.includes(p.name.toLowerCase()),
    };
  });
}

// Validate + save keys. `keys` is an object of env var -> secret. Only keys that
// match the API-key-shaped providers (optionally, allowing account ID too) are
// accepted. Returns the masked result for the caller / UI.
function saveKeys(keys, activeChain = []) {
  const accepted = {};
  const allowed = new Set(PROVIDERS.map((p) => p.env));
  const errors = [];
  for (const [env, raw] of Object.entries(keys || {})) {
    if (!allowed.has(env)) { errors.push(`Unknown key ${env}`); continue; }
    const val = String(raw == null ? '' : raw).trim();
    accepted[env] = val; // empty string clears the key
  }
  if (Object.keys(accepted).length) {
    writeEnv(accepted);
    // Apply live so the aiBridge (which reads process.env per request) picks it up.
    for (const [env, val] of Object.entries(accepted)) {
      if (val) process.env[env] = val;
      else delete process.env[env];
    }
  }
  return { providers: listKeys(activeChain), errors };
}

module.exports = { PROVIDERS, listKeys, saveKeys, mask, upsertEnv: writeEnv };
