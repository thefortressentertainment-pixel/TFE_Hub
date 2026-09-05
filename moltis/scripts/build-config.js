// Builds the full Moltis config from the single source of truth: the Fortress
// Settlement roster in backend/src/settlement.js. Emits moltris.build/moltis.toml.
// NOTE: fields validated against `moltis config check` (0.10.18) — presets only
// accept model / delegate_only / system_prompt_suffix.
const fs = require('fs');
const path = require('path');

const settlement = require('../../backend/src/settlement');
const T = path.resolve(__dirname, '..');
const OUT_DIR = path.join(T, 'build');

// tier -> spawn behavior. leadership/heavy delegate (never do hands work);
// support/grunt/specialist/operations carry out tasks.
const TIER_DELEGATE = {
  leadership: true,
  operations: false,
  specialist: false,
  support: false,
  grunt: false,
  heavy: true,
};

// QUANTIZED LOCAL MODELS: All tiers use local Ollama models to avoid burning
// cloud token limits. qwen2.5:1.5b for complex reasoning (operations/specialist/
// leadership). The hands tiers (support/grunt/heavy) use qwen2.5-coder:0.5b —
// same ~115 tok/s as qwen2.5:0.5b but code/tool-call tuned, which is what
// bridge dispatch and spawn_agent need. Falls back to the opencode bridge
// (big-pickle) only when explicitly requested for complex tasks.
const TIER_MODEL = {
  leadership: "ollama/qwen2.5:1.5b",
  operations: "ollama/qwen2.5:1.5b",
  specialist: "ollama/qwen2.5:1.5b",
  support: "ollama/qwen2.5-coder:0.5b",
  grunt: "ollama/qwen2.5-coder:0.5b",
  heavy: "ollama/qwen2.5-coder:0.5b",
};

const TIER_HINT = {
  leadership: 'You command. Delegate work by spawning sub-agents (spawn_agent); hands work only via the fortress bridge.',
  operations: 'You run operations through the fortress bridge and the exec tool.',
  specialist: 'You bring specialist skill; drive the fortress bridge and research tools.',
  support: 'You keep watch and deliver; work the fortress bridge.',
  grunt: 'You do the hands work. Execute via the fortress bridge (dispatch/talk) and report exactly what came back.',
  heavy: 'You are the heavy iron. Take the high-risk tasks; delegate prep to subordinates.',
};

function presetSection(agent) {
  const delegate = TIER_DELEGATE[agent.tier] === true;
  const suffix = `${agent.prompt} ${TIER_HINT[agent.tier]}`;
  const lines = [];
  lines.push(`[agents.presets.${agent.id}]`);
  lines.push(`model = "${TIER_MODEL[agent.tier]}"`);
  lines.push(`delegate_only = ${delegate ? 'true' : 'false'}`);
  lines.push(`system_prompt_suffix = ${JSON.stringify(suffix)}`);
  return lines.join('\n');
}

const generated = settlement.ROSTER.map(presetSection).join('\n\n');

let target = fs.readFileSync(path.join(T, 'template.toml'), 'utf8');
if (!target.includes('__AGENTS_PRESETS__')) throw new Error('template.toml missing __AGENTS_PRESETS__ marker');
target = target.replace('__AGENTS_PRESETS__', generated);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'moltis.toml'), target);

const counts = {};
settlement.ROSTER.forEach((a) => { counts[a.tier] = (counts[a.tier] || 0) + 1; });
console.log(`wrote moltris.build/moltis.toml — ${settlement.ROSTER.length} agents, tier counts:`, counts);