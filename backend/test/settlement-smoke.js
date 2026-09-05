// Fortress Settlement smoke — structural + guard checks only (no network).
// State is snapshot/reset/restored so the suite stays deterministic even after
// live talk/dispatch activity has bumped persisted ROI.
const fs = require('fs');
const path = require('path');
const settlement = require('../src/settlement');
const STATE_FILE = path.resolve(__dirname, '..', 'data', 'settlement.json');
const BASELINE = JSON.stringify({ updatedAt: null, agents: {} }, null, 2);

let pass = 0, fail = 0;
const check = (label, ok) => { if (ok) { pass++; console.log('  PASS ', label); } else { fail++; console.log('  FAIL ', label); } };

(async () => {
  const orig = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
  fs.writeFileSync(STATE_FILE, BASELINE);
  console.log('\n[1] Settlement roster');
  const team = settlement.team();
  check('22 agents in roster', team.ok && team.rosterCount === 22);
  const tierNames = team.tiers.map((t) => t.tier);
  check('6 tiers in order', JSON.stringify(tierNames) === JSON.stringify(['leadership', 'operations', 'specialist', 'support', 'grunt', 'heavy']));
  const heavy = team.tiers.find((t) => t.tier === 'heavy');
  check('heavy tier has Liberty Prime / Mr. Gutsy / Deathclaw', !!heavy && ['liberty-prime', 'gutsy', 'deathclaw'].every((id) => heavy.agents.some((a) => a.id === id)));
  const core = team.tiers[0].agents.find((a) => a.id === 'core');
  check('General Prestyn leads with default ROI 75', !!core && core.name === 'General Prestyn' && core.roi === 75 && core.uses === 0);

  console.log('[2] ROI summary');
  const roi = settlement.roiSummary();
  check('roi default is 75', roi.ok && roi.defaultRoi === 75 && roi.byAgent.core.roi === 75);

  console.log('[3] Guard rails');
  check('unknown agent rejected', (await settlement.talk('nope', 'hi')).ok === false);
  check('empty talk message rejected', (await settlement.talk('core', '  ')).ok === false);
  check('agency fails gracefully without chat deps', (await settlement.talk('core', 'hello')).ok === false);
  check('unknown dispatch rejected', (await settlement.dispatch('nope', 'task')).ok === false);
  check('empty task rejected', (await settlement.dispatch('core', '')).ok === false);

  console.log(`\nSETTLEMENT SMOKE: ${pass} passed, ${fail} failed`);
  if (orig) fs.writeFileSync(STATE_FILE, orig); else fs.rmSync(STATE_FILE, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('settlement smoke crash:', e); process.exit(1); });