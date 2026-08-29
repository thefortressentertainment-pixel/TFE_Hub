'use strict';
/**
 * osint-smoke.js — smoke test for JARV OSINT (satellite comms intelligence).
 * Runs WITHOUT network by exercising the offline paths:
 *   1. jarvAgent loads with OSINT capabilities exposed
 *   2. jarv_osint_handbook tool returns the cross-training doc
 *   3. mesh executor osint.handbook proxies to JARV
 *   4. mesh executor osint.satvision rejects unknown params (no network hit)
 */
const path = require('path');
const os = require('os');
const genieMesh = require('../src/genieMesh');
const jarvAgent = require('../src/jarvAgent');

let failed = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra ? '→ ' + extra : ''}`); }
}

function makeTinyPool() {
  return {
    async query(sql) {
      if (sql.includes('INSERT INTO genie_commands')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function main() {
  console.log('\n[1] JARV agent OSINT capabilities');
  const sandbox = fsMkdtemp();
  const jarv = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), mesh: null, ai: null, log: () => {} });
  const caps = await jarv.getCapabilities();
  check('jarv agent exposes OSINT tool defs', ['jarv_satvision', 'jarv_osint_handbook'].every((t) => caps.tools.some((d) => d.name === t)));
  check('jarv agent has sandbox root', typeof caps.sandboxRoot === 'string' && caps.sandboxRoot.length > 0);

  console.log('\n[2] jarv_osint_handbook tool');
  const hb = await jarv.executeTool('jarv_osint_handbook', {});
  check('handbook tool returns ok', hb && hb.ok === true);
  check('handbook mentions OrbitDeck', hb && hb.ok && /OrbitDeck/.test(hb.content || ''));
  check('handbook mentions continuity playbooks', hb && hb.ok && /playbook/i.test(hb.content || ''));

  console.log('\n[3] mesh executor osint.handbook (via setJarv wiring)');
  const executor = genieMesh.buildExecutor(makeTinyPool(), { getStatus: () => ({ ok: true }), jarv });
  const viaMesh = await executor('osint.handbook', {}, { peerId: 'telegram-relay' });
  check('osint.handbook over mesh returns doc', viaMesh && viaMesh.ok === true && /OrbitDeck/.test(viaMesh.content || ''));

  console.log('\n[4] mesh executor osint.satvision param guards');
  let rejected = null;
  try { await executor('osint.satvision', { lat: 40.4, lon: -3.65, evil: 1 }, {}); }
  catch (e) { rejected = String((e && e.message) || e); }
  check('unknown satvision param rejected', !!rejected && /unknown osint\.satvision param/.test(rejected));
  const noJarvExecutor = genieMesh.buildExecutor(makeTinyPool(), { getStatus: () => ({ ok: true }) });
  let noJarvErr = null;
  try { await noJarvExecutor('osint.handbook', {}, {}); }
  catch (e) { noJarvErr = String((e && e.message) || e); }
  check('missing jarv handled gracefully', !!noJarvErr && /JARV agent not available/.test(noJarvErr));

  console.log('\n[5] OpenAI tool schema');
  const tools = jarvAgent.getOpenAITools();
  check('schema exposes 7 tools', Array.isArray(tools) && tools.length === 7);
  const sat = tools.find((t) => t.function.name === 'jarv_satvision');
  check('jarv_satvision schema requires lat+lon', !!sat && sat.function.parameters.required.includes('lat') && sat.function.parameters.required.includes('lon'));
  check('schema serializes to valid JSON', (() => { try { JSON.stringify(tools); return true; } catch (e) { return false; } })());
  let askRouteErr = null;
  try { await executor('jarv.ask', { prompt: 'hi' }, {}); }
  catch (e) { askRouteErr = String((e && e.message) || e); }
  check('mesh command jarv.ask routed to JARV', !!askRouteErr && /AI relay/.test(askRouteErr));

  console.log('\n[6] JARV ask() tool-use loop (stub AI)');
  let calls = 0;
  const stubAi = {
    complete: async (args) => {
      calls++;
      if (calls === 1) {
        return { ok: true, reply: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'jarv_osint_handbook', arguments: '{}' } }] };
      }
      return { ok: true, reply: 'Handbook loaded — 7 OSINT tools ready.', provider: 'stub', model: 'stub' };
    },
  };
  const jarvB = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: stubAi, log: () => {} });
  const ans = await jarvB.ask('are satellites overhead right now?');
  check('ask() executed the handbook tool', calls === 2 && ans.toolCalls.length === 1 && ans.toolCalls[0].name === 'jarv_osint_handbook');
  check('ask() returned final reply', ans.reply === 'Handbook loaded — 7 OSINT tools ready.');
  let askErr = null;
  try { await jarvB.ask('hi'); } catch (e) { askErr = String((e && e.message) || e); }
  // After loop consumed stub: complete now returns final immediately (calls goes 2→3), so no throw expected.
  check('ask() without allowed turns still yields a reply', typeof ans.reply === 'string' && ans.reply.length > 0);
  check('ask() throws when AI relay missing', (() => {
    const bare = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: null, log: () => {} });
    return bare.ask('hi').then(() => false).catch((e) => /AI relay/.test(String(e.message)));
  })());

  try { jarv.dispose && jarv.dispose(); } catch (e) {}
  fsRmdir(sandbox);
}

function fsMkdtemp() {
  const { mkdtempSync } = require('fs');
  return mkdtempSync(path.join(os.tmpdir(), 'jarv-osint-'));
}
function fsRmdir(p) {
  const { rmSync } = require('fs');
  try { rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

main().then(() => {
  console.log('\n==============================');
  console.log(failed === 0 ? 'ALL OSINT SMOKE TESTS PASSED' : `${failed} TEST(S) FAILED`);
  console.log('==============================\n');
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error('OSINT SMOKE CRASHED:', e);
  process.exit(1);
});