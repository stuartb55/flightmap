CREATE TABLE IF NOT EXISTS daily_range_histogram (
  profile_date date NOT NULL,
  bearing_bucket smallint NOT NULL CHECK (bearing_bucket BETWEEN 0 AND 71),
  altitude_band text NOT NULL CHECK (altitude_band IN ('ground', 'low', 'medium', 'high')),
  range_bucket_nm smallint NOT NULL CHECK (range_bucket_nm BETWEEN 0 AND 500),
  reports bigint NOT NULL DEFAULT 0,
  aircraft_icaos text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (profile_date, bearing_bucket, altitude_band, range_bucket_nm)
);
CREATE INDEX IF NOT EXISTS daily_range_histogram_date_idx
  ON daily_range_histogram (profile_date DESC);

CREATE TABLE IF NOT EXISTS custom_alert_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  callsign_prefix text,
  icao char(6),
  operator text,
  type_code text,
  minimum_altitude_ft double precision,
  maximum_altitude_ft double precision,
  minimum_distance_nm double precision,
  maximum_distance_nm double precision,
  cooldown_minutes integer NOT NULL DEFAULT 0 CHECK (cooldown_minutes BETWEEN 0 AND 10080),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (minimum_altitude_ft IS NULL OR maximum_altitude_ft IS NULL OR minimum_altitude_ft <= maximum_altitude_ft),
  CHECK (minimum_distance_nm IS NULL OR maximum_distance_nm IS NULL OR minimum_distance_nm <= maximum_distance_nm),
  CHECK (callsign_prefix IS NOT NULL OR icao IS NOT NULL OR operator IS NOT NULL OR type_code IS NOT NULL
    OR minimum_altitude_ft IS NOT NULL OR maximum_altitude_ft IS NOT NULL
    OR minimum_distance_nm IS NOT NULL OR maximum_distance_nm IS NOT NULL)
);

ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'warning';
UPDATE alert_events SET severity = 'critical' WHERE rule IN ('emergency_squawk', 'emergency_state');
ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_severity_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_severity_check CHECK (severity IN ('info', 'warning', 'critical'));

ALTER TABLE alert_events DROP CONSTRAINT IF EXISTS alert_events_rule_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_rule_check CHECK (
  rule IN ('emergency_squawk', 'emergency_state', 'watchlist', 'custom')
);

UPDATE insight_backfill_state
SET status = 'pending', next_date = NULL, processed_days = 0,
    started_at = NULL, completed_at = NULL, last_error = NULL, updated_at = now()
WHERE id = true;
