CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES profiles(id);
