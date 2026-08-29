-- hub_locations: family device fixes reported into the hub (location services).
CREATE TABLE IF NOT EXISTS hub_locations (
    device_id text PRIMARY KEY,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    accuracy_m double precision,
    source text,
    updated_at timestamptz NOT NULL DEFAULT now()
);