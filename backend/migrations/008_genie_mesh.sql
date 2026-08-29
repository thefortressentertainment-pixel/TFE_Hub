-- 008_genie_mesh.sql
-- Genie Mesh: durable bidirectional link between Fortress Hub and JARV-Genie.
-- Purpose-built to survive intermittent / high-latency / low-bandwidth links
-- (Starlink, Iridium, OneWeb, geostationary comms sats, congested LTE, etc.):
--   * genie_peers    -> registered assistant peers that may talk to Fortress Hub
--   * genie_outbox   -> durable outbound event queue (the "never lose a message" layer)
--   * genie_commands -> audit log of every agentic command issued by a peer
--   * comms_sessions -> link session history (uptime / transport / bytes)

CREATE TABLE IF NOT EXISTS genie_peers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(50) DEFAULT 'assistant',
  endpoint_url TEXT,
  api_key_hash VARCHAR(128),
  scope VARCHAR(20) DEFAULT 'read-write',
  status VARCHAR(20) DEFAULT 'offline',
  enabled BOOLEAN DEFAULT TRUE,
  satlink BOOLEAN DEFAULT FALSE,
  last_seen_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS genie_outbox (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID REFERENCES genie_peers(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  next_attempt_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_genie_outbox_pending ON genie_outbox(peer_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_genie_outbox_created ON genie_outbox(created_at);

CREATE TABLE IF NOT EXISTS genie_commands (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID REFERENCES genie_peers(id) ON DELETE CASCADE,
  command VARCHAR(64) NOT NULL,
  status VARCHAR(20) DEFAULT 'received',
  latency_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_genie_commands_peer ON genie_commands(peer_id, created_at);

CREATE TABLE IF NOT EXISTS comms_sessions (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID REFERENCES genie_peers(id) ON DELETE CASCADE,
  transport VARCHAR(20) DEFAULT 'socket',
  status VARCHAR(20) DEFAULT 'connected',
  bytes_sent BIGINT DEFAULT 0,
  bytes_received BIGINT DEFAULT 0,
  connected_at TIMESTAMP DEFAULT NOW(),
  disconnected_at TIMESTAMP,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_comms_sessions_peer ON comms_sessions(peer_id, connected_at);