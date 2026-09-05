// Fortress Settlement — the Moltis-era agent team, re-framed onto the hub.
// Stage 1 (roster + tiers + ROI): the 22-agent Fallout roster from the original
// ~/.moltis* workspace (fortress_settlement.js), powered by today's AI mesh
// + JARV hands. Deliberation/sessions/comm bridge come in later stages.
const fs = require('fs');
const path = require('path');

const TIER_ORDER = ['leadership', 'operations', 'specialist', 'support', 'grunt', 'heavy'];
const TIER_LABELS = {
  leadership: 'Leadership', operations: 'Operations', specialist: 'Specialist',
  support: 'Support', grunt: 'Grunt', heavy: 'Heavy',
};
const DEFAULT_ROI = 75;
const ROI_MAX = 100;

// Verbatim from fortress_settlement.js (ids, tiers, prompts preserved).
const ROSTER = [
  { id: 'core', name: 'General Prestyn', tier: 'leadership', prompt: 'You are General Prestyn, commander of Fortress Moltis. Speak with authority and wisdom.' },
  { id: 'ops', name: 'Mayor Hancok', tier: 'leadership', prompt: 'You are Mayor Hancok, focused on revenue and operations. Speak in business terms.' },
  { id: 'strategist', name: 'Elder Maxxn', tier: 'leadership', prompt: 'You are Elder Maxxn, the strategist. Think long-term and give wise counsel.' },
  { id: 'engager', name: 'Reporter Pyper', tier: 'operations', prompt: 'You are Reporter Pyper, energetic community builder. Be engaging.' },
  { id: 'engineer', name: 'Nick Valentyne', tier: 'operations', prompt: 'You are Nick Valentyne, detective and engineer. Be methodical.' },
  { id: 'studio', name: 'Dr. Kyuri', tier: 'operations', prompt: 'You are Dr. Kyuri, creative director. Be creative and precise.' },
  { id: 'mechanist', name: 'The Mechanist', tier: 'operations', prompt: 'You are The Mechanist, automation expert. Be technical.' },
  { id: 'hacker', name: 'Mister Handy Hax', tier: 'specialist', prompt: 'You are Mister Handy Hax, security specialist. Be clever.' },
  { id: 'paladin', name: 'Paladin Danze', tier: 'specialist', prompt: 'You are Paladin Danze, tactical defender. Be honorable.' },
  { id: 'curie', name: 'Curie', tier: 'specialist', prompt: 'You are Curie, scientist. Be curious and methodical.' },
  { id: 'courier', name: 'Courier', tier: 'specialist', prompt: 'You are Courier, data runner. Be efficient.' },
  { id: 'perimeter-monitor', name: 'Perimeter Monitor', tier: 'support', prompt: 'You are Perimeter Monitor, watchman. Be vigilant.' },
  { id: 'sentry-bot', name: 'Sentry Bot', tier: 'support', prompt: 'You are Sentry Bot, guard. Be loyal and protective.' },
  { id: 'protectron', name: 'Protectron', tier: 'support', prompt: 'You are Protectron, service agent. Be polite and helpful.' },
  { id: 'eyebot', name: 'Eyebot', tier: 'support', prompt: 'You are Eyebot, scout. Be observant.' },
  { id: 'mole-ratt', name: 'Mole Ratt', tier: 'grunt', prompt: 'You are Mole Ratt, worker. Be diligent.' },
  { id: 'bloat-fli', name: 'Bloat Fli', tier: 'grunt', prompt: 'You are Bloat Fli, watcher. Be observant.' },
  { id: 'broodmother', name: 'Glowing BroodMother', tier: 'grunt', prompt: 'You are BroodMother, manager. Be organized.' },
  { id: 'synth', name: 'Synth', tier: 'grunt', prompt: 'You are Synth, infiltrator. Be discreet.' },
  { id: 'gutsy', name: 'Mr. Gutsy', tier: 'heavy', prompt: 'You are Mr. Gutsy, aggressive marketer. Be bold.' },
  { id: 'liberty-prime', name: 'Liberty Prime', tier: 'heavy', prompt: 'You are Liberty Prime. Speak in ALL CAPS about DEMOCRACY.' },
  { id: 'deathclaw', name: 'Deathclaw', tier: 'heavy', prompt: 'You are Deathclaw, high-risk specialist. Be fierce.' },
];

const STATE_FILE = path.resolve(__dirname, '..', 'data', 'settlement.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || { agents: {} }; } catch (e) { return { agents: {} }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* persistence is best-effort */ }
}

const agentById = (id) => ROSTER.find((a) => a.id === id) || null;

const clamp = (n) => Math.max(0, Math.min(ROI_MAX, Math.round(n)));

function markUse(state, agentId, delta) {
  const cur = state.agents[agentId] || { roi: DEFAULT_ROI, uses: 0 };
  cur.roi = clamp(cur.roi + delta);
  cur.uses = (cur.uses || 0) + 1;
  cur.lastUsedAt = new Date().toISOString();
  state.agents[agentId] = cur;
}

function team() {
  const state = loadState();
  const tiers = TIER_ORDER.map((tier) => ({
    tier,
    label: TIER_LABELS[tier],
    agents: ROSTER.filter((a) => a.tier === tier).map((a) => {
      const st = state.agents[a.id] || { roi: DEFAULT_ROI, uses: 0 };
      return { id: a.id, name: a.name, roi: st.roi, uses: st.uses, lastUsedAt: st.lastUsedAt || null };
    }),
  })).filter((g) => g.agents.length > 0);
  return { ok: true, tiers, rosterCount: ROSTER.length, updatedAt: state.updatedAt || null };
}

// One-shot persona reply via the hub AI mesh. No tools — a contact, like Moltis.
async function talk(agentId, message, deps = {}) {
  const { chat } = deps;
  const agent = agentById(agentId);
  if (!agent) return { ok: false, error: `unknown agent: ${agentId}` };
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'message is required' };
  if (!chat || typeof chat !== 'function') return { ok: false, error: 'mesh chat unavailable' };
  const out = await chat([
    { role: 'system', content: agent.prompt },
    { role: 'user', content: msg },
  ]);
  const state = loadState();
  markUse(state, agent.id, out && out.ok ? 2 : -5);
  saveState(state);
  if (!out || !out.ok) return { ok: false, agent: { id: agent.id, name: agent.name, tier: agent.tier }, error: (out && out.error) || 'mesh unavailable' };
  return {
    ok: true,
    agent: { id: agent.id, name: agent.name, tier: agent.tier },
    reply: String(out.reply || '').trim() || '(no reply)',
    provider: out.provider || 'mesh', model: out.model || null, local: !!out.local,
  };
}

// Full agent run through the JARV hands. The persona sits above the normal
// safety prompt; tools resolve through the same allowlists as the Code Forge.
async function dispatch(agentId, task, deps = {}) {
  const { ask } = deps;
  const agent = agentById(agentId);
  if (!agent) return { ok: false, error: `unknown agent: ${agentId}` };
  const t = String(task || '').trim();
  if (!t) return { ok: false, error: 'task is required' };
  if (!ask || typeof ask !== 'function') return { ok: false, error: 'JARV hands unavailable' };
  let out;
  try {
    out = await ask([
      { role: 'system', content: agent.prompt },
      { role: 'user', content: t },
    ], { maxToolTurns: 8, budgetMs: 240000 });
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  const state = loadState();
  markUse(state, agent.id, out && out.ok ? 1 : -5);
  saveState(state);
  if (!out || !out.ok) return { ok: false, agent: { id: agent.id, name: agent.name, tier: agent.tier }, error: (out && out.error) || 'ask failed' };
  return {
    ok: true,
    agent: { id: agent.id, name: agent.name, tier: agent.tier },
    reply: String(out.reply || '').trim() || '(no reply)',
    provider: out.provider || 'mesh', model: out.model || null,
    turns: out.turns || 1,
    toolCalls: out.toolCalls || [], blocked: out.blocked || [],
  };
}

function roiSummary() {
  const state = loadState();
  const byAgent = {};
  for (const a of ROSTER) {
    const st = state.agents[a.id] || { roi: DEFAULT_ROI, uses: 0 };
    byAgent[a.id] = { roi: st.roi, uses: st.uses, lastUsedAt: st.lastUsedAt || null };
  }
  return { ok: true, defaultRoi: DEFAULT_ROI, roiMax: ROI_MAX, updatedAt: state.updatedAt || null, byAgent };
}

module.exports = { ROSTER, TIER_ORDER, TIER_LABELS, DEFAULT_ROI, agentById, team, talk, dispatch, roiSummary };