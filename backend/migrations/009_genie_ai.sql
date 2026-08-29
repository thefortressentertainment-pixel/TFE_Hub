-- 009_genie_ai.sql
-- Genie AI Relay: durable async LLM task queue so JARV-Genie can use a model
-- (free DeepSeek V4 by default, or any OpenAI-compatible endpoint) as its main
-- brain "forever", over ANY communications path (satellite included).
--   * genie_ai_logs -> every AI task, its state, reply, usage, latency.
-- Results are delivered back over the existing genie_outbox ('ai.result')
-- which the mesh pushes over socket / HTTPS / pull — nothing is lost.

CREATE TABLE IF NOT EXISTS genie_ai_logs (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID REFERENCES genie_peers(id) ON DELETE CASCADE,
  task_type VARCHAR(20) DEFAULT 'chat',
  model VARCHAR(100),
  state VARCHAR(20) DEFAULT 'pending',
  prompt JSONB NOT NULL DEFAULT '[]'::jsonb,
  options JSONB DEFAULT '{}'::jsonb,
  reply JSONB,
  usage JSONB,
  error TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_genie_ai_peer_state ON genie_ai_logs(peer_id, state, created_at);