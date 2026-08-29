# Fortress Hub

Local setup for the Fortress receipt hub app.

## Requirements

- Node.js installed
- Redis running locally on `127.0.0.1:6379`
- PostgreSQL running locally on `127.0.0.1:5432`
- Postgres database `fortress` created with user `postgres` / password `postgres`

## Install dependencies

```bash
cd ~/fortress-hub
npm install
```

## Start services

From the project root, run everything in one go:

```bash
cd ~/fortress-hub
npm run dev
```

That launches the backend, worker, and frontend together. If you prefer separate terminals, use:

1. Backend
```bash
cd ~/fortress-hub
npm run start:backend
```

2. Worker
```bash
cd ~/fortress-hub
npm run start:worker
```

3. Frontend
```bash
cd ~/fortress-hub
npm run start:frontend
```

## Defaults

- Backend: `http://localhost:4002`
- Upload endpoint: `http://localhost:4002/api/upload`
- Job status: `http://localhost:4002/api/job/:id`
- Receipts list: `http://localhost:4002/api/receipts`

## Genie Mesh (JARV-Genie integration)

Fortress Hub ships with a **durable, bidirectional link to JARV-Genie** that is
built to stay connected "forever" and to keep working over satellite comms
(Starlink, Iridium, and other high-latency / intermittent links).

Core ideas:

- **Outbox + ack** — every domain event is written to Postgres first
  (`genie_outbox`) and only marked delivered after an explicit ack, so nothing
  is lost when a link drops mid-transfer.
- **Persistent outbound socket** — the backend holds a native WebSocket to
  `JARV_GENIE_URL` with auto-reconnect + heartbeat.
- **HTTPS fallback + REST pull** — when the socket is down, an HTTPS flusher
  pushes batches; JARV-Genie can also pull with `GET /api/genie/outbox` and ack.
- **Agentic API** — JARV-Genie can call `https://<hub>/api/genie/*` with the
  `X-Genie-Key` header (profiles, receipts, daily summary, trends, notes…).

Environment variables (backend):

| Var | Purpose |
| --- | --- |
| `GENIE_MESH_ENABLED` | `"true"`/`"false"` — master switch (default true) |
| `GENIE_SATLINK` | `"true"` enables satellite tuning (bigger batches, longer timeouts, gzip) |
| `JARV_GENIE_URL` | outbound WebSocket endpoint, e.g. `wss://genie.example.com/socket` |
| `JARV_GENIE_API_KEY` | inbound key JARV-Genie presents as `X-Genie-Key` (auto-generated on first boot if unset — printed once to logs) |
| `JARV_GENIE_OUTBOUND_TOKEN` | token Fortress Hub sends in the socket `hello` |

### Free DeepSeek V4 — JARV-Genie's main brain

The Genie Mesh also ships a **model relay** so JARV-Genie can use **free
DeepSeek V4** (or any OpenAI-compatible model / self-hosted DeepSeek server) as
its main model **permanently**, over any comms path. Fortress Hub does the
internet leg; JARV-Genie only talks to the hub.

- **Sync** — `POST /api/genie/ai/complete` / `/ai/chat` (or the `ai.complete` /
  `ai.chat` commands over socket) for direct request/response.
- **Durable async** — `POST /api/genie/ai/task` writes the prompt to Postgres
  first; a background processor calls the model and delivers the result as an
  `ai.result` event over the mesh outbox (socket / HTTPS / pull) — nothing is
  lost on a satellite hop. Poll `GET /api/genie/ai/task/:id` too.
- **Provider fallback** — tries the configured model, then `deepseek-chat` /
  `deepseek-reasoner`, and reports 401/402/429 clearly.

AI environment variables:

| Var | Purpose |
| --- | --- |
| `GENIE_AI_ENABLED` | master switch (default true) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (required for the official endpoint) |
| `DEEPSEEK_BASE_URL` | endpoint; `https://api.deepseek.com/v1` or your self-hosted V4 server |
| `DEEPSEEK_MODEL` | primary model, default `deepseek-v4` |
| `DEEPSEEK_FALLBACK_MODELS` | comma-separated fallbacks |
| `DEEPSEEK_FREE` | `"true"` = free-tier mode (reported in status) |
| `DEEPSEEK_SYSTEM_PROMPT` | optional base persona/system prompt for JARV-Genie |
| `DEEPSEEK_MAX_TOKENS` / `DEEPSEEK_TEMPERATURE` | defaults 2000 / 0.7 |

Run the migrations with `npm run migrate`. See `docs/genie-mesh.md` for the full
protocol, all endpoints, and the satellite deployment guide.

## Manual tunnel testing (Tailscale + Telegram)

JARV-Genie now has two zero-config continuity paths that work behind CGNAT,
hotspots and satellite links. Both are live the moment the backend starts;
neither requires opening inbound ports.

### 1. Tailscale (private tailnet HTTP/WS)

The backend binds `HOST` (default `0.0.0.0`) and logs its tailnet IP on boot
(auto-detected via `tailscale ip -4`) so peers on the same tailnet can reach it:

```bash
# On the hub machine (this repo):
npm start
# → "Tailscale: http://100.x.y.z:4002 (tailnet-only; JARV_GENIE_URL can point here)"

# From the JARV-Genie machine over the tailnet:
curl -H "X-Genie-Key: $JARV_GENIE_API_KEY" http://100.x.y.z:4002/api/genie/health-comms   # → {"ok":true,"mode":"land"|"sat",...}

# Hub-side env so the hub dials JARV-Genie over Tailscale too (backend/.env;
# see backend/.env.example for every variable):
JARV_GENIE_URL=https://jarv-genie.<tailnet>.ts.net   # outbound socket + HTTPS inbox
JARV_GENIE_API_KEY=<printed at first seed, or pre-set this before first boot>
GENIE_SATLINK=true                                   # longer ack timeouts + gentler backoff
```

Verify both directions with `GET /api/comms/status` (authenticated dashboard
route): `outbound.socket` should be `true` and `peers` should list
`jarv-genie` with a recent `last_seen_at`.

### 2. Telegram (outbound long-poll — works with zero inbound ports)

```bash
# 1. Create a bot with @BotFather, copy the token.
# 2. Add to backend env:
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_CHATS=            # empty = bootstrap mode
# 3. Start the backend, message the bot /start from Telegram:
#    it replies with your chat ID. Put that ID in TELEGRAM_ALLOWED_CHATS and restart.
```

Authorized chat commands: `/status` (mesh + AI health), `/peer` (mesh peers),
`/task <prompt>` (durable AI task — result is pushed back when processed),
free text (sync AI relay reply), anything else → error reply. Every interaction
is audited into `genie_commands`; the poll session shows up in `comms_sessions`
as transport `telegram-longpoll` and in `GET /api/comms/telegram`.

### Smoke tests (no Postgres/Redis/bot needed)

```bash
npm run smoke        # mesh + AI relay + Telegram tunnel: 66 checks, all stubbed end-to-end
```

## Notes

- The frontend is configured to upload files to `localhost:4002`.
- The backend and worker default to local Redis/Postgres when `REDIS_URL` and `DATABASE_URL` are not provided.
- If port `4002` is already in use, stop the existing backend instance before starting a second one.
