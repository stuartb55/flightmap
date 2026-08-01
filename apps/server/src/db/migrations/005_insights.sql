ALTER TABLE daily_aircraft_summary
  ADD COLUMN IF NOT EXISTS maximum_range_nm double precision;

CREATE TABLE IF NOT EXISTS hourly_aircraft_activity (
  bucket_hour timestamptz NOT NULL,
  icao char(6) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  reports bigint NOT NULL DEFAULT 0,
  positioned_reports bigint NOT NULL DEFAULT 0,
  session_ids uuid[] NOT NULL DEFAULT '{}',
  maximum_range_nm double precision,
  maximum_altitude_ft double precision,
  PRIMARY KEY (bucket_hour, icao)
);
CREATE INDEX IF NOT EXISTS hourly_aircraft_activity_icao_hour_idx
  ON hourly_aircraft_activity (icao, bucket_hour DESC);

CREATE TABLE IF NOT EXISTS daily_coverage_cells (
  coverage_date date NOT NULL,
  latitude_index smallint NOT NULL CHECK (latitude_index BETWEEN 0 AND 3599),
  longitude_index smallint NOT NULL CHECK (longitude_index BETWEEN 0 AND 7199),
  reports bigint NOT NULL DEFAULT 0,
  aircraft_icaos text[] NOT NULL DEFAULT '{}',
  maximum_altitude_ft double precision,
  PRIMARY KEY (coverage_date, latitude_index, longitude_index)
);
CREATE INDEX IF NOT EXISTS daily_coverage_cells_date_idx
  ON daily_coverage_cells (coverage_date DESC);

CREATE TABLE IF NOT EXISTS insight_backfill_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  oldest_date date,
  newest_date date,
  next_date date,
  processed_days integer NOT NULL DEFAULT 0,
  total_days integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO insight_backfill_state (id, status)
VALUES (true, 'pending')
ON CONFLICT (id) DO NOTHING;
