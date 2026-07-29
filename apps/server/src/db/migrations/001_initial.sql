CREATE TABLE IF NOT EXISTS receiver_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  latitude double precision,
  longitude double precision,
  software_version text,
  advertised_refresh_ms double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collector_checkpoint (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  recorded_at timestamptz NOT NULL,
  messages bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS track_sessions (
  id uuid PRIMARY KEY,
  icao char(6) NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  last_position_at timestamptz NOT NULL,
  callsigns text[] NOT NULL DEFAULT '{}',
  sample_count bigint NOT NULL DEFAULT 0,
  minimum_altitude_ft double precision,
  maximum_altitude_ft double precision,
  minimum_ground_speed_kt double precision,
  maximum_ground_speed_kt double precision,
  closest_range_nm double precision,
  last_latitude double precision,
  last_longitude double precision,
  last_altitude_ft double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS track_sessions_icao_started_idx
  ON track_sessions (icao, started_at DESC);
CREATE INDEX IF NOT EXISTS track_sessions_started_idx
  ON track_sessions (started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS track_sessions_last_position_idx
  ON track_sessions (last_position_at DESC);

CREATE TABLE IF NOT EXISTS position_samples (
  recorded_at timestamptz NOT NULL,
  icao char(6) NOT NULL,
  session_id uuid NOT NULL,
  callsign text,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  altitude_barometric_ft double precision,
  altitude_geometric_ft double precision,
  on_ground boolean NOT NULL DEFAULT false,
  ground_speed_kt double precision,
  indicated_air_speed_kt double precision,
  true_air_speed_kt double precision,
  mach double precision,
  track_deg double precision,
  track_rate_deg_per_sec double precision,
  roll_deg double precision,
  magnetic_heading_deg double precision,
  true_heading_deg double precision,
  barometric_rate_fpm double precision,
  geometric_rate_fpm double precision,
  squawk text,
  emergency text,
  category text,
  rssi_dbfs double precision,
  messages bigint,
  seen_seconds double precision,
  seen_position_seconds double precision,
  nav_altitude_mcp_ft double precision,
  nav_altitude_fms_ft double precision,
  nav_heading_deg double precision,
  nav_qnh_hpa double precision,
  nav_modes text[] NOT NULL DEFAULT '{}',
  source text NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  distance_nm double precision,
  bearing_deg double precision,
  PRIMARY KEY (recorded_at, icao)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX IF NOT EXISTS position_samples_icao_time_idx
  ON position_samples (icao, recorded_at DESC);
CREATE INDEX IF NOT EXISTS position_samples_session_time_idx
  ON position_samples (session_id, recorded_at);
CREATE INDEX IF NOT EXISTS position_samples_time_idx
  ON position_samples (recorded_at DESC);

CREATE OR REPLACE FUNCTION ensure_position_partition(target_time timestamptz)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_day date := (target_time AT TIME ZONE 'UTC')::date;
  partition_name text := 'position_samples_' || to_char(partition_day, 'YYYYMMDD');
  range_start timestamptz := partition_day::timestamp AT TIME ZONE 'UTC';
  range_end timestamptz := (partition_day + 1)::timestamp AT TIME ZONE 'UTC';
BEGIN
  IF partition_day < (CURRENT_DATE - 370) OR partition_day > (CURRENT_DATE + 7) THEN
    RAISE EXCEPTION 'position partition date % is outside safety bounds', partition_day;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(partition_name)::bigint);
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF position_samples FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    range_start,
    range_end
  );
END;
$$;

DO $$
DECLARE
  day_offset integer;
BEGIN
  FOR day_offset IN -31..2 LOOP
    PERFORM ensure_position_partition(now() + make_interval(days => day_offset));
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS current_aircraft (
  icao char(6) PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  last_position_at timestamptz,
  session_id uuid,
  CONSTRAINT current_aircraft_session_fk
    FOREIGN KEY (session_id) REFERENCES track_sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS current_aircraft_updated_idx
  ON current_aircraft (updated_at DESC);

CREATE TABLE IF NOT EXISTS aircraft_summary (
  icao char(6) PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  total_observations bigint NOT NULL DEFAULT 0,
  session_count bigint NOT NULL DEFAULT 0,
  closest_range_nm double precision,
  latest_callsign text,
  latest_registration text,
  latest_type_code text,
  latest_operator text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aircraft_summary_last_seen_idx
  ON aircraft_summary (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS daily_aircraft_summary (
  summary_date date NOT NULL,
  icao char(6) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  observations bigint NOT NULL DEFAULT 0,
  positioned_observations bigint NOT NULL DEFAULT 0,
  session_count bigint NOT NULL DEFAULT 0,
  minimum_altitude_ft double precision,
  maximum_altitude_ft double precision,
  maximum_ground_speed_kt double precision,
  closest_range_nm double precision,
  callsigns text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (summary_date, icao)
);
CREATE INDEX IF NOT EXISTS daily_aircraft_summary_icao_date_idx
  ON daily_aircraft_summary (icao, summary_date DESC);
CREATE INDEX IF NOT EXISTS daily_aircraft_summary_date_idx
  ON daily_aircraft_summary (summary_date DESC, icao);

CREATE TABLE IF NOT EXISTS receiver_samples (
  recorded_at timestamptz PRIMARY KEY,
  message_rate_per_second double precision,
  accepted_messages bigint,
  bad_messages bigint,
  strong_signals bigint,
  signal_dbfs double precision,
  noise_dbfs double precision,
  peak_signal_dbfs double precision,
  cpu_demod_ms double precision,
  cpu_reader_ms double precision,
  cpu_background_ms double precision,
  health text NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS receiver_samples_time_idx
  ON receiver_samples (recorded_at DESC);

CREATE TABLE IF NOT EXISTS aircraft_metadata (
  icao char(6) PRIMARY KEY,
  registration text,
  type_code text,
  description text,
  operator text,
  owner text,
  country text
);
CREATE INDEX IF NOT EXISTS aircraft_metadata_registration_idx
  ON aircraft_metadata (lower(registration));
CREATE INDEX IF NOT EXISTS aircraft_metadata_type_idx
  ON aircraft_metadata (lower(type_code));
CREATE INDEX IF NOT EXISTS aircraft_metadata_operator_idx
  ON aircraft_metadata (lower(operator));

CREATE TABLE IF NOT EXISTS aircraft_metadata_import (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  source_url text NOT NULL,
  etag text,
  last_modified text,
  source_modified_at timestamptz,
  imported_at timestamptz,
  last_checked_at timestamptz,
  version text,
  row_count integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE TABLE IF NOT EXISTS watchlist (
  icao char(6) PRIMARY KEY,
  label text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id uuid PRIMARY KEY,
  icao char(6) NOT NULL,
  session_id uuid,
  rule text NOT NULL CHECK (
    rule IN ('emergency_squawk', 'emergency_state', 'first_seen', 'watchlist')
  ),
  state text,
  message text NOT NULL,
  callsign text,
  occurred_at timestamptz NOT NULL,
  dismissed_at timestamptz,
  dedupe_key text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS alert_events_occurred_idx
  ON alert_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS alert_events_icao_idx
  ON alert_events (icao, occurred_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_undismissed_idx
  ON alert_events (occurred_at DESC) WHERE dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS maintenance_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  retention_days integer NOT NULL,
  dropped_partitions integer NOT NULL DEFAULT 0,
  deleted_sessions bigint NOT NULL DEFAULT 0,
  deleted_alerts bigint NOT NULL DEFAULT 0,
  deleted_receiver_samples bigint NOT NULL DEFAULT 0
);
