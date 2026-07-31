ALTER TABLE profiles ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE mileage_logs ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id);
CREATE INDEX IF NOT EXISTS idx_receipts_device_id ON receipts(device_id);
