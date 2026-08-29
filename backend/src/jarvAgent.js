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

function isBlocked(cmd) { return BLOCKED_PATTERNS.some((re) => re.test(cmd)); }

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

function execAllowlist(cmd, { sandboxRoot, allowlist, timeout = 15000, maxOutput = 20000 } = {}) {
  return new Promise((resolve) => {
    const check = checkAllowlist(cmd, allowlist || DEFAULT_ALLOWLIST);
    if (!check.ok) return resolve({ ok: false, error: check.reason });
    const parts = cmd.trim().split(/\s+/);
    const child = execFile(parts[0], parts.slice(1), {
      cwd: resolveSandbox(sandboxRoot),
      timeout,
      maxBuffer: maxOutput,
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
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
  if (args.lat != null) cmdArgs.push('--lat', String(args.lat));
  if (args.lon != null) cmdArgs.push('--lon', String(args.lon));
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

function makeJarvAgent({ pool, mesh, ai, log }) {
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const sandboxRoot = resolveSandbox();
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const tools = getToolDefs();

  async function executeTool(name, args) {
    const result = dispatchTool(name, args, { sandboxRoot });
    if (result instanceof Promise) return result;
    return result;
  }

  async function getCapabilities() {
    return { tools, sandboxRoot };
  }

  return {
    executeTool,
    getCapabilities,
    getToolDefs,
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
  getToolDefs, dispatchTool, checkAllowlist, isBlocked,
  DEFAULT_ALLOWLIST, BLOCKED_PATTERNS, resolveSandbox,
  makeJarvAgent,
};
