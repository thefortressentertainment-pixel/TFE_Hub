CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  device_id VARCHAR(64),
  purpose VARCHAR(100),
  start_time TIMESTAMP DEFAULT NOW(),
  end_time TIMESTAMP,
  miles NUMERIC(8,2),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shifts_device_id ON shifts(device_id);
CREATE INDEX IF NOT EXISTS idx_shifts_profile_id ON shifts(profile_id);
