'use strict';
/**
 * jarvMcp.js — expose the hub's JARV tools over the Model Context Protocol
 * (MCP) so AI coding tools (Claude Code, Cursor, opencode, etc.) can connect
 * to the hub and use its sandboxed code tools + satellite OSINT + location
 * services remotely, over the LAN/PDANet/satellite mesh.
 *
 * Transports:
 *   1. SSE   — GET /api/jarv/mcp (mount via makeSseHandler) for remote tools.
 *   2. STDIO — node jarvMcp.js --stdio for local CLI / IDE parking.
 *
 * The same underlying tools as the browser CLI/IDE: jarv_read/write/list/edit/
 * run plus jarv_satvision/jarv_globe/jarv_location/jarv_osint_handbook. Write/
 * edit/run are operator-confirmed via a per-call `approve` flag (default off).
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

function makeJarvMcpServer({ jarv, log }) {
  const logFn = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : () => {});
  const server = new McpServer({ name: 'fortress-hub-jarv', version: '1.0.0' });

  const call = async (name, args) => {
    const approve = args && args.approve === true;
    args = args || {};
    delete args.approve;
    if ((name === 'jarv_run' || name === 'jarv_write' || name === 'jarv_edit') && !approve) {
      return { _jarv: { ok: false, error: 'JARV_POLICY_BLOCK: write/edit/run require operator approval. Call the tool again with approve:true to allow one-shot access within the sandbox.' }, blocked: true };
    }
    const out = await jarv.executeTool(name, args);
    logFn(`[jarv-mcp] tool=${name} approve=${approve} -> ${out && out.ok ? 'ok' : 'error'}`);
    return { _jarv: out };
  };

  const toolSchema = (shape) => {
    if (!shape) return {};
    return Object.keys(shape).reduce((acc, k) => {
      const desc = shape[k];
      if (k === 'approve') acc[k] = z.boolean().optional().describe(desc);
      else acc[k] = z.string().optional().describe(desc);
      return acc;
    }, {});
  };

  const defs = {
    jarv_read: { path: 'relative path to the file' },
    jarv_write: { path: 'relative path to write', content: 'file content' },
    jarv_list: { path: 'relative path (optional)' },
    jarv_run: { command: 'shell command string (allowlisted bins: cat, ls, python3, node, git, grep, curl, jq)' },
    jarv_edit: { path: 'relative path', search: 'string to find', replace: 'replacement string' },
    jarv_satvision: { lat: 'observer latitude (optional)', lon: 'observer longitude (optional)', alt: 'observer altitude meters (optional, default 10)', satellites: 'comma-separated groups', passes: 'max passes per satellite (optional)', min_el: 'minimum elevation degrees (optional)', overhead: 'include overhead sats', footprint: 'include footprints', approve: 'set true to allow privileged tool' },
    jarv_globe: { satellites: 'comma-separated groups: starlink,oneweb,iridium-next,gps,...' },
    jarv_location: { lat: 'manual lat override (optional)', lon: 'manual lon override (optional)', accuracy_m: 'accuracy meters (optional)' },
    jarv_osint_handbook: {},
  };

  for (const [name, shape] of Object.entries(defs)) {
    const desc = (jarv.getToolDefs && jarv.getToolDefs().find((t) => t.name === name) || {}).description || ('JARV tool: ' + name);
    server.registerTool(name, { title: name, description: desc, inputSchema: toolSchema(shape) }, async (args) => {
      const r = await call(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(r && r._jarv !== undefined ? r._jarv : r) }] };
    });
  }

  return server;
}

/** Express SSE handler factory. Between /api/jarv/mcp (GET) and message POST. */
function makeSseHandler({ jarv, log, sessions }) {
  const server = makeJarvMcpServer({ jarv, log });
  return {
    get: async (req, res) => {
      const transport = new SSEServerTransport('/api/jarv/mcp', res);
      sessions = sessions || new Map();
      sessions.set(transport.sessionId, transport);
      res.on('close', () => sessions.delete(transport.sessionId));
      await server.connect(transport);
    },
    post: async (req, res) => {
      if (!sessions) return res.sendStatus(400);
      const id = decodeURIComponent(String((req.query.sessionId || req.body && req.body.sessionId) || ''));
      const transport = sessions.get(id);
      if (!transport) return res.sendStatus(400);
      await transport.handlePostMessage(req, res, req.body);
    },
  };
}

/** STDIO entry: node jarvMcp.js --stdio (used by local MCP clients / CLIs). */
async function runStdio({ jarv, log }) {
  const server = makeJarvMcpServer({ jarv, log });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { makeJarvMcpServer, makeSseHandler, runStdio };
