# Genie Mesh — JARV-Genie ⇄ Fortress Hub Integration & Protocol

This document is the contract for connecting **JARV-Genie** to **Fortress Hub**
"forever", including over **satellite comms** (Starlink, Iridium, OneWeb, GEO
links, or any high-latency / intermittent transport). It describes the wire
protocol, every endpoint, the durability guarantees, and the satellite tuning
knobs.

---

## 1. Architecture in one paragraph

Fortress Hub writes **every domain event that JARV-Genie should know about** into
a durable Postgres table called `genie_outbox` **before anything is sent**. A
mesh controller then tries to deliver those buffered events over up to three
transports, in order of preference:

1. **Persistent WebSocket** (outbound, Fortress Hub → JARV-Genie) — holds a
   long-lived socket with auto-reconnect and heartbeat, and streams batches live.
2. **HTTPS flusher** (outbound push) — activates automatically when the socket is
   down (e.g. a satellite blackout): `POST {endpoint}/api/genie/inbox`.
3. **REST pull** (inbound fetch) — JARV-Genie (or anything on the satellite
   link) can fetch buffered events with `GET /api/genie/outbox` and ack them.

A message is only removed from the queue after an explicit **ack**. If no ack
arrives, the batch is re-queued and tried again with backoff — forever.

```
                     ┌──────────────────────────────┐
    receipts /       │        Fortress Hub          │      ┌─────────────┐
    mileage /        │  ┌────────────────────────┐  │      │             │
    shifts / ...     │  │ events → genie_outbox  │  │◄────►│  JARV-Genie  │
  (app + worker) ───►│  └────────────────────────┘  │ push │             │
                     │   ◄ socket (wss://, live)    │ ack  │  (agent /    │
                     │   ◄ https flusher (fallback) │ pull │   assistant) │
                     └──────────────────────────────┘      └─────────────┘
```

Bidirectional = JARV-Genie can also **query Fortress Hub** (reads), **act**
(limited writes), and **send its own events** into the hub, over either:

- REST    → `https://<hub>/api/genie/*` with `X-Genie-Key`
- Socket  → Socket.IO namespace `/genie` on the hub

---

## 2. Durability guarantees

| Guarantee | Mechanism |
| --- | --- |
| No event lost in a mid-flight link drop | event is persisted in `genie_outbox` before transport; delivery only completes on ack |
| No double-processing confusion | `claimBatch` uses `FOR UPDATE SKIP LOCKED`, so concurrent senders (socket + flusher + multi-instance) each claim a row exactly once |
| Stuck `sending` rows self-heal | a sweeper re-queues rows whose `sent_at` is older than the ack window |
| Survives process restarts | queue lives in Postgres, not memory |
| Backlog visibility | `GET /api/comms/status` returns outbox counts per status |

### Event lifecycle

```
INSERT (peer_id, event_type, payload)        status = pending
          │
claimBatch() ──► status = sending, sent_at = now()
          │             │
   transport deliver     └──► ack timeout / drop → status = pending (exp. backoff)
          │
ack received (socket ack / https reply / REST ack)
          │
status = delivered, delivered_at = now()
```

---

## 3. Outbound protocol — Fortress Hub → JARV-Genie (WebSocket)

Fortress Hub acts as a **WebSocket client**. Configure the endpoint with
`JARV_GENIE_URL` (e.g. `wss://genie.yourdomain.com/socket`) and secure the
handshake with `JARV_GENIE_OUTBOUND_TOKEN`.

Frames are single JSON text messages.

### Handshake (client → server, on every connect)

```json
{ "type": "hello", "version": "1.0.0", "peer": "jarv-genie",
  "sessionId": "8f6bc7d7-...", "token": "<JARV_GENIE_OUTBOUND_TOKEN>", "satlink": false }
```

The server should keep the socket open; the client reconnects with exponential
backoff (1s → 60s) automatically and resumes flushing the queue.

### Outbound events (client → server)

```json
{ "type": "push", "sessionId": "<id>",
  "batch": [ { "id": 42, "event_type": "receipt.processed",
               "payload": { "receiptId": 123, "vendor": "Starbucks", "total": 5.5 } } ] }
```

Acknowledge by sending back the ids you accepted:

```json
{ "type": "ack", "ids": [42] }
```

Only acked ids are marked delivered. Unacked ids are retried with backoff.

### Commands (server → client→ back to server)

JARV-Genie asks Fortress Hub a question over the same socket:

```json
{ "type": "command", "id": "req-1", "command": "receipts.list", "args": { "limit": 5 } }
```

Fortress Hub replies via the same socket:

```json
{ "type": "reply", "id": "req-1", "ok": true,
  "data": { "receipts": [ { "id": 123, "vendor": "Starbucks", "total": 5.5 } ] } }
```

Errors: `{ "type": "reply", "id": "req-1", "ok": false, "error": "receipt not found" }`.

### Keepalive

```json
{ "type": "ping", "t": 1765072380000 }   { "type": "pong", "t": 1765072380000 }
```

A socket that misses three pongs is torn down and reconnected. If JARV-Genie
cannot hold a WebSocket open, use the HTTPS `inbox` (below) or REST pull.

---

## 4. HTTPS inbox (fallback push)

When the socket is down, Fortress Hub POSTs the same batch to
`POST {JARV_GENIE_URL-with-http-scheme}/api/genie/inbox` (a `/socket` path
suffix is stripped).

```
Authorization: the body includes { "peer", "token", "batch", "sentAt", "satlink" }
Expected response: { "acked": [42] }   (or { "delivered": [...] })
```

In satellite mode (`GENIE_SATLINK=true`) the body is gzip-compressed
(`Content-Encoding: gzip`) and timeouts grow to 45s.

---

## 5. Inbound protocol — JARV-Genie → Fortress Hub

### REST gateway `https://<hub>/api/genie/*`

All calls require header `X-Genie-Key: <JARV_GENIE_API_KEY>`. On the first boot
when no key is configured, Fortress Hub generates one and prints it once to the
logs: `[genie-mesh] INBOUND API KEY (save into your JARV-Genie config)`.
Provide your own via `JARV_GENIE_API_KEY` before first boot to avoid the printed
key.
| Method & Path | Command | Notes |
| --- | --- | --- |
| `GET /api/genie/status` | `status` | mesh health, peer, outbox stats, sessions, AI status |
| `GET /api/genie/comms/status` | `comms.status` | comms-focused health (REST alias of socket `comms.status` command) |
| `GET /api/genie/profiles` | `profiles.list` | all profiles |
| `GET /api/genie/receipts?profileId=&startDate=&endDate=&category=&limit=` | `receipts.list` | max 200 |
| `GET /api/genie/receipts/:id` | `receipts.get` | full receipt |
| `PATCH /api/genie/receipts/:id` | `receipts.update` | vendor, category, is_business, business_notes, project_name, tax_category, is_verified |
| `POST /api/genie/receipts/:id/notes` | `receipts.notes` | `{ "business_notes": "..." }` |
| `GET /api/genie/daily-summary?profileId=` | `daily.summary` | today's spend/miles/shifts |
| `GET /api/genie/analytics/spending-trends?profileId=&months=` | `analytics.trends` | monthly buckets |
| `GET /api/genie/outbox?limit=` | pull | fetch pending events (satellite friendly) |
| `POST /api/genie/outbox/ack` | ack | `{ "ids": [42] }` |
| `POST /api/genie/events` | ingest | `{ "event_type": "...", "payload": {} }` delivers JARV-Genie events into the hub |
| `GET /api/genie/health-comms` | lite | `{ "ok": true, "t": ..., "link": "...", "backlog": N, "mode": "sat"|"land" }` (~50 bytes, for sat links) |
| `GET /api/genie/ai/status` | `ai.status` | AI relay status (DeepSeek V4 provider, model, pending tasks) |
| `POST /api/genie/ai/complete` | `ai.complete` | sync LLM request/response (prompt or messages) |
| `POST /api/genie/ai/chat` | `ai.chat` | sync chat (alias of ai.complete, messages array) |
| `POST /api/genie/ai/task` | `ai.task` | durable async task → persisted first, result via outbox |
| `GET /api/genie/ai/task/:id` | `ai.result.get` | poll an async AI task state/result |

Every command call is recorded in `genie_commands` (peer, command, status,
latency) for auditability. Writes are forbidden for peers configured
`scope=read`; all paths are rate-limited.

### Socket.IO inbound namespace `/genie`

JARV-Genie (or a relay) may connect with the standard `socket.io-client`:

```js
const { io } = require('socket.io-client');
const s = io('https://<hub>/genie', { auth: { token: '<JARV_GENIE_API_KEY>' } });
s.on('connect', () => s.emit('mesh:command', { id: 'q1', command: 'daily.summary', args: {} }));
s.on('mesh:reply', (m) => console.log(m)); // { id:'q1', ok:true, data:{...} }
s.emit('mesh:ping');                       // → 'mesh:pong' keepalive
```

---

## 5.5 Genie AI relay — Free DeepSeek V4 (JARV-Genie's main brain)

The mesh relays any OpenAI-compatible model to JARV-Genie so it can run on
**free DeepSeek V4** as its permanent main model — with Fortress Hub doing the
internet leg, so JARV-Genie only ever needs a comms path back to the hub.

**Sync (request/response) over any transport:**

```bash
# REST (works over satellite via pull/long-poll too)
curl -X POST https://<hub>/api/genie/ai/complete \
  -H 'X-Genie-Key: <key>' -H 'Content-Type: application/json' \
  -d '{ "prompt": "Summarise today\'s spending" }'

curl -X POST https://<hub>/api/genie/ai/chat \
  -H 'X-Genie-Key: <key>' -H 'Content-Type: application/json' \
  -d '{ "messages": [ { "role": "user", "content": "hello" } ] }'
```

```json
{ "ok": true, "provider": "deepseek", "model": "deepseek-v4",
  "reply": "…", "usage": { "prompt_tokens": 12, "completion_tokens": 40 },
  "latencyMs": 842, "cached": false }
```

Over sockets the commands are `ai.complete`, `ai.chat`, and `ai.status`
(`{ "type": "command", "command": "ai.complete", "args": { "prompt": "…" } }`).

**Durable async (never-lose mode for satellite):**

```bash
curl -X POST https://<hub>/api/genie/ai/task \
  -H 'X-Genie-Key: <key>' -H 'Content-Type: application/json' \
  -d '{ "prompt": "Plan my shifts for next week" }'
# → { "taskId": 17, "state": "pending" }
```

The task is persisted to `genie_ai_logs`, processed in the background, and the
answer arrives as an **`ai.result` outbox event** (delivered by socket, HTTPS
flusher, or pull — whichever reaches JARV-Genie first). You can also poll:

```bash
curl -H 'X-Genie-Key: <key>' https://<hub>/api/genie/ai/task/17
# → { "task": { "state": "completed", "reply": "…", "usage": {…}, "latency_ms": 900 } }
```

Failures emit `ai.failed` events and record the error.

**Configuration** (see the README table): `GENIE_AI_ENABLED`, `DEEPSEEK_API_KEY`
(required for `https://api.deepseek.com/v1`), `DEEPSEEK_BASE_URL` (self-hosted
DeepSeek V4 via Ollama/vLLM needs no key), `DEEPSEEK_MODEL` (default
`deepseek-v4`), `DEEPSEEK_FALLBACK_MODELS`, `DEEPSEEK_FREE`, `DEEPSEEK_MAX_TOKENS`,
`DEEPSEEK_TEMPERATURE`, and `DEEPSEEK_SYSTEM_PROMPT` for JARV-Genie's persona.
Provider errors are surfaced plainly: `401` (key), `402` (billing/credit),
`429` (rate limit), model-not-found (auto-fallback to the next alias).

---

## 5.6 Tunnels — Tailscale + Telegram (continuity paths)

Two zero-inbound-port paths keep JARV-Genie usable when the primary link
cannot accept connections (CGNAT, hotspots, satellite):

**Tailscale (tailnet HTTP/WS).** The backend binds `HOST` (default
`0.0.0.0`) and auto-detects the tailnet IP on boot (`tailscale ip -4`,
logged as `Tailscale: http://100.x.y.z:4002`). Point `JARV_GENIE_URL` at the
hub's ts.net name or tailnet IP so the outbound socket + HTTPS inbox ride the
tailnet, and probe reachability with `GET /api/genie/health-comms` (the
satellite-lite keepalive — `{"ok":true,"link":...,"backlog":...,"mode":...}`).
Direction check: `GET /api/comms/status` → `outbound.socket: true`, peers
showing a fresh `last_seen_at`.

**Telegram (outbound long-poll).** Enabled by `TELEGRAM_BOT_TOKEN`
(see `backend/.env.example`). Uses `getUpdates` exclusively — no webhook, no
inbound ports; a webhook is deleted at startup to guarantee long-poll
exclusivity. The tunnel registers itself as a first-class mesh peer
(`telegram-relay`), opens a `comms_sessions` row with transport
`telegram-longpoll`, and audits every authorized interaction in
`genie_commands`. First run is bootstrap mode: with `TELEGRAM_ALLOWED_CHATS`
empty, `/start` replies with the caller's chat ID and everything else is
ignored; set the ID and restart to activate. Authorized commands:
`/status` (mesh + AI health), `/peer` (peer table), `/task <prompt>`
(durable task — the watcher pushes the completed reply back to the chat),
and free text (sync AI relay reply). Mesh events in the durable outbox are
also drained to authorized chats by `pushOutboxToChats()`. Tunnel health:
`GET /api/comms/telegram` (running, mode, traffic counters, authorized
chats, last command).

---

## 6. Satellite (Starlink / comms sat) deployment guide

Starlink and similar links are not "off" so much as **intermittently available**
(rain fade, handoffs, latency spikes to 40–80 ms+, occasional seconds-long
blackouts). The mesh is built for exactly this:

1. **Turn on satellite tuning:** `GENIE_SATLINK=true`
   - longer ack window (45s), slower HTTPS flush cadence, gzip bodies.
2. **Use pull mode when latency is high.** A JARV-Genie relay on the far end
   of a satellite link should poll `GET /api/genie/health-comms` (tiny) and
   `GET /api/genie/outbox?limit=50`, then `POST /api/genie/outbox/ack`. This
   performs a handful of round-trips per minute instead of constant chatter.
3. **Don't expect a socket on both ends at once.** The outbox does not care
   which transport delivers: socket when available, HTTPS otherwise, pull when
   convenient.
4. **Keep payloads small.** Compact JSON only; receipt images stay on Fortress
   Hub storage — JARV-Genie works with metadata, not images.
5. **Watch the backlog.** `GET /api/comms/status` → `outbox.pending` shows how
   far behind JARV-Genie is. The dashboard link chip shows `queue N`.

---

## 7. Database schema (migration `008_genie_mesh.sql`)

- `genie_peers` — assistant identity, scoped API key (sha256 hash only),
  endpoint URL, link status, satellite flag, last-seen.
- `genie_outbox` — `(peer_id, event_type, payload jsonb, status, attempts,
  next_attempt_at, sent_at, delivered_at, last_error)`.
- `genie_commands` — audit trail of every agentic call.
- `comms_sessions` — link session history (transport, bytes, connected_at…).

## 8. Security notes

- Inbound authentication is a bearer API key compared in constant time via
  sha256 hashes (`crypto.timingSafeEqual`). Keys are never stored in plaintext.
- The inbound Socket.IO namespace requires the same key in the handshake.
- Rate limiting + a full command audit log on every agentic call.
- The worker and backend both append to the outbox but only the backend runs
  the transport layer, keeping claim semantics single-owner.

## 9. Testing

```bash
npm run migrate              # applies 008_genie_mesh.sql + the rest
npm run smoke                # both suites below (no Postgres/Redis needed)

# individually:
cd backend
node test/mesh-smoke.js           # mesh: seeding, socket, outbox, comms.status, auth
node test/ai-bridge-smoke.js      # AI: fallback chain, durable queue, REST relay
node test/telegram-tunnel-smoke.js # Telegram: poll loop, commands, auth, outbox push
```

The mesh smoke proves peer seeding, socket handshake, outbox emit→push→ack→delivered,
command + comms.status round-trips, disconnect detection, REST auth (401/200),
`/health-comms`, event ingestion, and pull-mode delivery. The AI smoke runs a fake
DeepSeek endpoint and proves the model fallback chain, durable task state
(pending→processing→completed), result delivery via the outbox, status counters,
and the authenticated REST gateway (the real `verifyPeerKey` path). The Telegram
smoke runs the real poll loop against a fake Bot API: bootstrap mode, chat-ID
authorization, every tunnel command, durable `/task` result push, outbox drain,
and `genie_commands` auditing.
