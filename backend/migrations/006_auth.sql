ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE mileage_logs ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_profiles_owner_id ON profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_receipts_owner_id ON receipts(owner_id);
