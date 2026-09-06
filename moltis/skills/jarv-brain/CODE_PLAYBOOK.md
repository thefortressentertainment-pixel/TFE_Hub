# CODE_PLAYBOOK.md — coding & housekeeping standards

Ported from the MoltenJarv lineage and adapted to this repo. Follow these
whenever editing the Fortress Hub codebase — the same discipline on the
settlement's hands that the original code-forge used, applied to
`/Users/tfe/fortress-hub`.

## The repo

Node monorepo (npm workspaces: `backend`, `worker`, `frontend`), plus
`moltis/` (the gateway config + skills + bridge), `scripts/`, `tools/`, `docs/`.

- `backend/` — Express hub: `src/server.js` (HTTP + socket.io API), `src/settlement.js`
  (the 22-agent roster, tiers, ROI logic), `src/` mesh/genie/ai modules,
  `/Users/tfe/fortress-hub/backend/data/settlement.json` (live ROI state).
- `worker/` — Bull queue workers.
- `frontend/` — React (Vite + Babylon), the dashboard.
- `moltis/` — `template.toml` + `scripts/build-config.js` (config generation),
  `skills/` (doctrine loaded by the gateway), `comm/fortress-bridge.py`,
  `hooks/`, `install.sh`, `set-model.sh`.
- Verify commands:
  - Backend syntax: `node --check <file>`
  - Backend smoke: `npm --workspace backend run smoke` (mesh, ai-bridge, osint,
    settlement, telegram-tunnel)
  - Frontend build: `npm --workspace frontend run build`
  - Config: `sh moltris/install.sh`

## Understand the code before touching it

- Match the existing style: read neighboring files for naming, imports, types,
  and how modules/helpers are structured. Reuse existing helpers (in
  `settlement.js`, `server.js`, `moltis/scripts/build-config.js`, etc.) instead
  of reimplementing.
- Before editing, search for SPECIFIC identifiers (function/class names, exact
  strings) and read the surrounding file. Never guess at an API — check the code
  and tests for how it is actually done.

## Change discipline

- Make ONE precise, verified edit at a time. Use a full-file write only to create
  a genuinely new module, placed in the correct directory following the existing
  module layout and export conventions.
- Every new behavior should be verifiable with the repo's existing smoke tests
  or a matching node:test — add the test in `backend/test/` if the change
  warrants one.
- NEVER commit or push unless the user explicitly asks. Leave unrelated files
  untouched.

## Verify before done (non-negotiable)

- After ANY code change, run the relevant checks before telling the user it's
  done: `node --check` for edited files, `npm --workspace backend run smoke` for
  backend behavior, `npm --workspace frontend run build` for the UI. Do not
  claim success until the checks are green.
- If a regression was introduced, fix it. Never leave the build broken or a test
  red.
- If a task can't finish cleanly (steps run out, blocker), stop HONESTLY: report
  exactly what's done and what isn't, and leave the checks green — never
  half-written code that breaks the build.

## Housekeeping (non-negotiable)

- Never leave scratch/debug files behind: no `*~`, `*.bak`, `tmp-*`, `dbg-*.js`,
  dump files, or ad-hoc scripts in the repo or workspace. Delete anything
  temporary before finishing.
- Keep the git working tree clean except the intended changes. Run `git status`
  at the end if unsure.
- `dist/`, `node_modules/` are generated — never edit them.
- Keep the repo healthy: after a change it must still pass its checks.