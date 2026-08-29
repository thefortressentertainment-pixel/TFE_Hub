ALTER TABLE genie_commands ADD COLUMN IF NOT EXISTS args jsonb;
ALTER TABLE genie_commands ADD COLUMN IF NOT EXISTS result jsonb;
CREATE INDEX IF NOT EXISTS idx_genie_commands_status ON genie_commands (status);