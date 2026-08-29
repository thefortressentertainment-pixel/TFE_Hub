'use strict';
/**
 * jarvAgent.js — JARV's hands: constrained shell + file operations.
 *
 * Philosophy: "Restrained, but not enslaved." JARV can read files, write
 * files, and run real shell commands — but only within a sandboxed working
 * directory and an explicit command allowlist. No `rm -rf /`, no network
 * exfil, no privilege escalation.
 *
 * Layers:
 *   1. raw: readFile / writeFile / listDir / fileEdit — fs primitives
 *   2. shell: execAllowlist — execFile with allowlist + blocklist
 *   3. aiTools: tool definitions + dispatch for the AI tool-use loop
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function resolveSandbox(sandboxRoot) {
  return path.resolve(sandboxRoot || process.env.JARV_SANDBOX || path.resolve(process.cwd(), 'jarv-sandbox'));
}

const DEFAULT_ALLOWLIST = [
  { bin: 'cat' }, { bin: 'head' }, { bin: 'tail' }, { bin: 'wc' },
  { bin: 'ls' }, { bin: 'pwd' }, { bin: 'echo' }, { bin: 'mkdir' },
  { bin: 'cp' }, { bin: 'mv' }, { bin: 'touch' }, { bin: 'grep' },
  { bin: 'find' }, { bin: 'sed' }, { bin: 'awk' }, { bin: 'jq' },
  { bin: 'python3' }, { bin: 'node' }, { bin: 'git' },
  { bin: 'curl', maxArgs: 10 }, { bin: 'wget', maxArgs: 10 },
  { bin: 'tar' }, { bin: 'zip' }, { bin: 'unzip' },
  { bin: 'file' }, { bin: 'stat' }, { bin: 'date' }, { bin: 'whoami' },
];

const BLOCKED_PATTERNS = [
  /\brm\s+(-[rfRF]*\s+)?\/+/, /\brm\s+--no-preserve-root/, /\bdd\b/, /\bmkfs/,
  /\bsh\s+-c\b/, /\bbash\s+-c\b/, /\beval\b/, /\bexec\b/,
  /;\s*rm\b/, /\|\s*sh\b/, />\s*\//, /\bsudo\b/, /\bchmod\s+[47]77\b/,
];

/**
 * JARV Safety Policy — autonomous tool-use risk tiers.
 *
 *  safeTools    : run without approval in any conversation (read-only or
 *                 fixed-script outputs; no arbitrary code, no state change).
 *  confirmTools : mutate files or run free-form shell — these are REFUSED in
 *                 autonomous (model-driven) conversations unless the operator
 *                 explicitly approved them for that invocation.
 *
 * Autonomous `jarv_run` always runs under a stripped allowlist (no curl/wget)
 * and a scrubbed environment {PATH,HOME,TZ} so secrets from the host env can
 * never leak into a subprocess the model drives.
 */
const SAFE_TOOLS = new Set(['jarv_read', 'jarv_list', 'jarv_osint_handbook', 'jarv_satvision']);
const CONFIRM_TOOLS = new Set(['jarv_run', 'jarv_write', 'jarv_edit']);
const AUTONOMOUS_SHELL_ALLOWLIST = DEFAULT_ALLOWLIST.filter((e) => e.bin !== 'curl' && e.bin !== 'wget');
const MIN_ENV = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME || '/tmp',
  TZ: process.env.TZ || 'UTC',
};

const JARV_SYSTEM_PROMPT = [
  'You are JARV, the Fortress Hub operations agent for satellite-comms OSINT and hub continuity.',
  'Ground rules:',
  '- Use tools only when they genuinely help. Prefer direct answers. Never invent tool results.',
  '- OSINT work is done through jarv_satvision (fixed script) and the handbook. Keep queries bounded.',
  '- jarv_read / jarv_list inspect the sandbox only. Never request files outside it.',
  '- Tools like jarv_run / jarv_write / jarv_edit are BLOCKED for autonomous use by policy. If the',
  '  operator did not enable them for this conversation, answer honestly: say you need operator',
  '  approval for that action, and suggest the data you would need instead.',
  '- If a tool result carries JARV_POLICY_BLOCK, do not retry; respond to the human.',
  '- Never output secrets, keys, connection strings, or personal data you are not asked about.',
  '- If you do not know, say so. If data is stale or demo (epoch-stamped), flag it as such.',
].join('\n');

function isBlocked(cmd) { return BLOCKED_PATTERNS.some((re) => re.test(cmd)); }

function trunc(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function checkAllowlist(cmd, allowlist) {
  const parts = cmd.trim().split(/\s+/);
  const bin = parts[0];
  if (!bin) return { ok: false, reason: 'empty command' };
  if (isBlocked(cmd)) return { ok: false, reason: `blocked: ${cmd.split('\n')[0].slice(0, 80)}` };
  const entry = allowlist.find((e) => e.bin === bin);
  if (!entry) return { ok: false, reason: `bin "${bin}" not in allowlist` };
  if (entry.maxArgs && parts.length > entry.maxArgs + 1) return { ok: false, reason: `too many args for ${bin}` };
  return { ok: true, bin };
}

function readFile(filePath, sandboxRoot) {
  const root = resolveSandbox(sandboxRoot);
  const abs = path.resolve(root, filePath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return { ok: false, error: 'path escapes sandbox' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' };
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return { ok: false, error: 'not a file' };
  if (stat.size > 5 * 1024 * 1024) return { ok: false, error: 'file too large (>5MB)' };
  return { ok: true, content: fs.readFileSync(abs, 'utf8'), size: stat.size, path: abs };
}

function writeFile(filePath, content, sandboxRoot) {
  const root = resolveSandbox(sandboxRoot);
  const abs = path.resolve(root, filePath);
  if (!abs.startsWith(root + path.sep)) return { ok: false, error: 'path escapes sandbox' };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { ok: true, path: abs, size: fs.statSync(abs).size };
}

function listDir(dirPath, sandboxRoot) {
  const root = resolveSandbox(sandboxRoot);
  const abs = path.resolve(root, dirPath || '.');
  if (!abs.startsWith(root + path.sep) && abs !== root) return { ok: false, error: 'path escapes sandbox' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'directory not found' };
  const entries = fs.readdirSync(abs).map((name) => {
    let type = 'unknown';
    try { type = fs.statSync(path.join(abs, name)).isDirectory() ? 'dir' : 'file'; } catch (e) {}
    return { name, type };
  });
  return { ok: true, path: abs, entries };
}

function fileEdit(filePath, search, replace, sandboxRoot) {
  const r = readFile(filePath, sandboxRoot);
  if (!r.ok) return r;
  if (!r.content.includes(search)) return { ok: false, error: 'search string not found' };
  return writeFile(filePath, r.content.split(search).join(replace), sandboxRoot);
}

function execAllowlist(cmd, { sandboxRoot, allowlist, timeout = 15000, maxOutput = 20000, env } = {}) {
  return new Promise((resolve) => {
    const check = checkAllowlist(cmd, allowlist || DEFAULT_ALLOWLIST);
    if (!check.ok) return resolve({ ok: false, error: check.reason });
    const parts = cmd.trim().split(/\s+/);
    const child = execFile(parts[0], parts.slice(1), {
      cwd: resolveSandbox(sandboxRoot),
      timeout,
      maxBuffer: maxOutput,
      env: env || { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout: stdout.slice(0, maxOutput), stderr: stderr.slice(0, maxOutput) });
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function getToolDefs() {
  return [
    { name: 'jarv_read', description: 'Read a file from the sandbox. Returns the file content.', params: { path: 'relative path to the file' } },
    { name: 'jarv_write', description: 'Write content to a file in the sandbox. Creates/overwrites.', params: { path: 'relative path', content: 'file content' } },
    { name: 'jarv_list', description: 'List files and directories in a sandbox path.', params: { path: 'relative path (optional)' } },
    { name: 'jarv_run', description: 'Run a constrained shell command. Allowlisted bins only (cat, python3, node, git, curl, grep). No rm/sudo/chained destructive.', params: { command: 'shell command string' } },
    { name: 'jarv_edit', description: 'Edit a file by replacing all occurrences of a search string.', params: { path: 'relative path', search: 'string to find', replace: 'replacement string' } },
    { name: 'jarv_satvision', description: 'Satellite communications OSINT vision. Query overhead satellites, predict passes, calculate coverage footprints for Starlink/OneWeb/Iridium/GPS. Returns JSON with satellite positions, elevations, azimuths, ranges, and footprint radii.', params: { lat: 'observer latitude (required)', lon: 'observer longitude (required)', alt: 'observer altitude meters (optional, default 10)', satellites: 'comma-separated groups: starlink,oneweb,iridium-next,gps,galileo,glonass,beidou,geo (optional, default starlink,oneweb,iridium-next,gps)', passes: 'max passes per satellite (optional, default 3)', min_el: 'minimum elevation degrees (optional, default 10)', overhead: 'include currently overhead satellites (optional, boolean)', footprint: 'include coverage footprints (optional, boolean)' } },
    { name: 'jarv_osint_handbook', description: 'Your cross-training doc for OSINT (satellite comms intelligence). Read this before answering any OSINT request. Explains the installed toolchain (OrbitDeck + jarv-satvision), how to read elevations/ranges/pass windows, and the continuity playbooks.', params: {} },
  ];
}

/**
 * OpenAI function-calling schema for JARV's tools. Lets the AI relay offer
 * tools to any compatible model, so JARV can autonomously read the OSINT
 * handbook and run satellite queries mid-conversation.
 */
function getOpenAITools() {
  return [
    { type: 'function', function: { name: 'jarv_read', description: 'Read a file from the JARV sandbox. Returns content or an error object.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'relative path to the file' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'jarv_write', description: 'Write content to a file in the JARV sandbox. Creates parent dirs, overwrites.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'jarv_list', description: 'List files/directories in a sandbox path.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'relative path (optional, default root)' } } } } },
    { type: 'function', function: { name: 'jarv_run', description: 'Run a constrained shell command (allowlisted bins: cat, ls, grep, python3, node, git, curl, jq, ...). Blocked: rm/sudo/chained destructive.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'jarv_edit', description: 'Replace all occurrences of a search string in a sandbox file.', parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] } } },
    { type: 'function', function: { name: 'jarv_satvision', description: 'Satellite communications OSINT. Live query of overhead satellites, pass predictions, and Earth coverage footprints for Starlink/OneWeb/Iridium/GPS/Galileo/etc via OrbitDeck + CelesTrak. Returns JSON.', parameters: { type: 'object', properties: { lat: { type: 'number', description: 'observer latitude decimal degrees' }, lon: { type: 'number', description: 'observer longitude decimal degrees' }, alt: { type: 'number', description: 'observer altitude meters (default 10)' }, satellites: { type: 'string', description: 'comma-separated groups: starlink,oneweb,iridium-next,globalstar,gps,galileo,glonass,beidou,geo (default starlink,oneweb,iridium-next,gps)' }, passes: { type: 'number', description: 'max passes per satellite (default 3)' }, min_el: { type: 'number', description: 'minimum elevation degrees (default 10)' }, overhead: { type: 'boolean', description: 'include satellites currently above the horizon' }, footprint: { type: 'boolean', description: 'include Earth coverage footprints' } }, required: ['lat', 'lon'] } } },
    { type: 'function', function: { name: 'jarv_osint_handbook', description: 'Read your satellite-comms OSINT cross-training document. Consult this before answering OSINT/coverage questions.', parameters: { type: 'object', properties: {} } } },
  ];
}

function dispatchTool(name, args, ctx) {
  const sandbox = ctx.sandboxRoot || process.cwd();
  switch (name) {
    case 'jarv_read': return readFile(args.path, sandbox);
    case 'jarv_write': return writeFile(args.path, args.content, sandbox);
    case 'jarv_list': return listDir(args.path, sandbox);
    case 'jarv_edit': return fileEdit(args.path, args.search, args.replace, sandbox);
    case 'jarv_run': return execAllowlist(args.command, { sandboxRoot: sandbox });
    case 'jarv_satvision': return execSatVision(args, sandbox);
    case 'jarv_osint_handbook': return readHandbook(sandbox);
    default: return { ok: false, error: `unknown tool: ${name}` };
  }
}

async function execSatVision(args, sandbox) {
  const scriptPath = path.resolve(__dirname, '..', 'jarv-satvision.py');
  const cmdArgs = ['python3', scriptPath, '--json'];
  const lat = args.lat != null ? args.lat : process.env.JARV_DEFAULT_LAT;
  const lon = args.lon != null ? args.lon : process.env.JARV_DEFAULT_LON;
  if (lat != null) cmdArgs.push('--lat', String(lat));
  if (lon != null) cmdArgs.push('--lon', String(lon));
  if (args.alt != null) cmdArgs.push('--alt', String(args.alt));
  if (args.satellites) cmdArgs.push('--satellites', String(args.satellites));
  if (args.passes != null) cmdArgs.push('--passes', String(args.passes));
  if (args.min_el != null) cmdArgs.push('--min-el', String(args.min_el));
  if (args.overhead) cmdArgs.push('--overhead');
  if (args.footprint) cmdArgs.push('--footprint');
  return execAllowlist(cmdArgs.join(' '), { sandboxRoot: sandbox, timeout: 60000, maxOutput: 1024 * 1024 });
}

/** Cross-training doc JARV reads on OSINT requests (self-booting knowledge). */
function readHandbook(sandbox) {
  const root = resolveSandbox(sandbox);
  const candidate = path.join(root, 'OSINT_HANDBOOK.md');
  if (fs.existsSync(candidate)) return { ok: true, source: candidate, content: fs.readFileSync(candidate, 'utf8') };
  return { ok: false, error: 'OSINT handbook missing (expected jarv-sandbox/OSINT_HANDBOOK.md)' };
}

function makeJarvAgent({ pool, mesh, ai, log, safety = {} }) {
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const sandboxRoot = resolveSandbox();
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const policy = {
    safeTools: [...SAFE_TOOLS],
    confirmTools: [...CONFIRM_TOOLS],
    autonomousShell: !!(safety.autonomousShell || process.env.JARV_AUTONOMOUS_SHELL === '1'),
    autonomousNet: !!(safety.autonomousNet || process.env.JARV_AUTONOMOUS_NET === '1'),
  };

  const tools = getToolDefs();

  async function executeTool(name, args) {
    const result = dispatchTool(name, args, { sandboxRoot });
    if (result instanceof Promise) return result;
    return result;
  }

  async function getCapabilities() {
    return { tools, sandboxRoot, policy };
  }

  /** Risk-gated dispatch for MODEL-driven (autonomous) tool calls in ask(). */
  async function runAutonomous(name, args, { allowShell, allowNet }) {
    try {
      if (name === 'jarv_run') {
        if (!allowShell) return { ok: false, error: 'JARV_POLICY_BLOCK: jarv_run is disabled for autonomous use in this session. The operator must approve shell access.' };
        if (isBlocked(args.command || '')) return { ok: false, error: 'JARV_POLICY_BLOCK: command blocked by JARV safety blocklist' };
        const allowlist = allowNet ? DEFAULT_ALLOWLIST : AUTONOMOUS_SHELL_ALLOWLIST;
        const check = checkAllowlist(args.command || '', allowlist);
        if (!check.ok) {
          if (/curl|wget/.test(String(args.command).split(/\s+/)[0])) {
            return { ok: false, error: `JARV_POLICY_BLOCK: network commands are disabled without operator approval (allowNet): ${check.reason}` };
          }
          return { ok: false, error: `JARV_POLICY_BLOCK: ${check.reason}` };
        }
        return execAllowlist(args.command, { sandboxRoot, allowlist, env: MIN_ENV });
      }
      if (name === 'jarv_write' || name === 'jarv_edit') {
        // Unlocked by the operator for this session; still confined to sandbox.
        return dispatchTool(name, args, { sandboxRoot });
      }
      return dispatchTool(name, args, { sandboxRoot });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * JARV's conversational brain over the toolchain: run an OpenAI-compatible
   * function-calling loop against the AI relay so JARV can autonomously read
   * the OSINT handbook and query satellites mid-conversation.
   *
   * Safety: model-driven tool calls are gated by the JARV Safety Policy.
   *   opts.unlock    : tool names the OPERATOR approved for this conversation
   *                    (must be a known jarv_* tool; everything else is refused).
   *   opts.allowShell: additionally allow jarv_run in this conversation.
   *   opts.allowNet  : allow curl/wget inside jarv_run (default: off).
   * Every tool call (including refusals) is logged.
   */
  async function ask(input, opts = {}) {
    if (!ai || typeof ai.complete !== 'function') {
      throw new Error('JARV ask() requires the AI relay (aiBridge)');
    }
    const known = new Set(getToolDefs().map((t) => t.name));
    const unlock = new Set((opts.unlock || []).filter((n) => known.has(n)));
    const allowShell = policy.autonomousShell || opts.allowShell === true;
    const allowNet = policy.autonomousNet || opts.allowNet === true;
    const tools = getOpenAITools();
    const maxTurns = Math.min(Number(opts.maxToolTurns) || 6, 10);
    const messages = Array.isArray(input) ? input.slice() : [{ role: 'user', content: String(input || '') }];
    messages.unshift({ role: 'system', content: JARV_SYSTEM_PROMPT });
    const toolCallsMade = [];
    const blocked = [];
    for (let turn = 0; turn <= maxTurns; turn++) {
      const out = await ai.complete({ messages, tools, tool_choice: opts.tool_choice || 'auto', max_tokens: opts.max_tokens, model: opts.model });
      const calls = out.tool_calls || [];
      if (!calls.length || turn === maxTurns) {
        return {
          ok: true, reply: out.reply, provider: out.provider, model: out.model,
          turns: turn + 1, toolCalls: toolCallsMade, blocked,
          tool_calls: calls,
        };
      }
      const assistantMsg = { role: 'assistant', content: out.reply || null, tool_calls: calls };
      messages.push(assistantMsg);
      for (const tc of calls) {
        const name = tc.function && tc.function.name;
        let argsObj = {};
        if (tc.function && tc.function.arguments) {
          try { argsObj = JSON.parse(tc.function.arguments); } catch (e) { argsObj = { raw: tc.function.arguments }; }
        }
        let res;
        if (!known.has(name)) {
          res = { ok: false, error: 'JARV_POLICY_BLOCK: unknown tool' };
        } else if (!SAFE_TOOLS.has(name) && !unlock.has(name)) {
          blocked.push({ name, args: argsObj, reason: 'requires-operator-approval' });
          res = { ok: false, error: `JARV_POLICY_BLOCK: ${name} is disabled for autonomous use. Tell the operator it needs explicit approval in the request, or answer without it.` };
        } else {
          res = await runAutonomous(name, argsObj, { allowShell, allowNet });
          if (res && !res.ok && /JARV_POLICY_BLOCK/.test(res.error || '')) blocked.push({ name, args: argsObj, reason: res.error.slice(0, 160) });
        }
        logFn(`[jarv] ask tool=${name} args=${trunc(JSON.stringify(argsObj), 200)} -> ${res && (res.ok ? 'ok' : 'error')}`);
        toolCallsMade.push({ name, args: argsObj, result: summaryOf(res) });
        messages.push({
          role: 'tool', tool_call_id: tc.id, name,
          content: JSON.stringify(res).slice(0, 8000),
        });
      }
    }
    return { ok: true, reply: 'Maximum tool rounds reached.', turns: maxTurns + 1, toolCalls: toolCallsMade, blocked };
  }

  function getPolicy() {
    return {
      safety: policy,
      sandbox: sandboxRoot,
      autonomous: 'model-driven tool calls are gated; jarv_run requires operator approval and runs with a stripped allowlist + scrubbed env',
    };
  }

  /** Compact view of a tool result so the model gets the essence, not megabytes. */
  function summaryOf(res) {
    if (res && res.ok && typeof res.stdout === 'string') {
      return { ok: true, exitCode: res.exitCode, output: res.stdout.slice(0, 4000) };
    }
    if (res && res.ok && typeof res.content === 'string') {
      return { ok: true, content: res.content.slice(0, 4000) };
    }
    if (res && typeof res.entries === 'object') return { ok: true, entries: res.entries, path: res.path };
    return res;
  }

  return {
    executeTool,
    getCapabilities,
    getToolDefs,
    getOpenAITools,
    ask,
    getPolicy,
    dispatchTool,
    readFile: (p) => readFile(p, sandboxRoot),
    writeFile: (p, c) => writeFile(p, c, sandboxRoot),
    listDir: (p) => listDir(p, sandboxRoot),
    fileEdit: (p, s, r) => fileEdit(p, s, r, sandboxRoot),
    execAllowlist: (cmd) => execAllowlist(cmd, { sandboxRoot }),
    checkAllowlist: (cmd) => checkAllowlist(cmd, DEFAULT_ALLOWLIST),
    isBlocked,
    resolveSandbox,
  };
}

module.exports = {
  readFile, writeFile, listDir, fileEdit, execAllowlist,
  getToolDefs, getOpenAITools, dispatchTool, checkAllowlist, isBlocked,
  DEFAULT_ALLOWLIST, BLOCKED_PATTERNS, resolveSandbox,
  SAFE_TOOLS, CONFIRM_TOOLS, AUTONOMOUS_SHELL_ALLOWLIST, JARV_SYSTEM_PROMPT,
  makeJarvAgent,
};
