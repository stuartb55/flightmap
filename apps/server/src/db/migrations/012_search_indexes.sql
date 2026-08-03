-- Free-text search runs over tables that grow indefinitely. `ILIKE '%…%'`
-- against a raw column cannot use a `lower(column) gin_trgm_ops` index, so the
-- queries are rewritten as `lower(column) LIKE lower(pattern)` and the missing
-- indexes are added here.

-- array_to_string is only STABLE because element output functions can be, but
-- for text[] it is immutable; wrapping it makes an expression index possible.
CREATE OR REPLACE FUNCTION flightmap_callsigns_text(callsigns text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT lower(array_to_string(callsigns, ' ')) $$;

CREATE INDEX IF NOT EXISTS summary_icao_trgm_idx
  ON daily_aircraft_summary USING gin (lower(icao::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS summary_callsigns_trgm_idx
  ON daily_aircraft_summary
  USING gin (flightmap_callsigns_text(callsigns) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS sessions_icao_trgm_idx
  ON track_sessions USING gin (lower(icao::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sessions_callsigns_trgm_idx
  ON track_sessions
  USING gin (flightmap_callsigns_text(callsigns) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS metadata_type_code_trgm_idx
  ON aircraft_metadata USING gin (lower(type_code) gin_trgm_ops);

-- Serves the per-aircraft EXISTS in liveAircraft().
CREATE INDEX IF NOT EXISTS alert_events_icao_active_idx
  ON alert_events (icao) WHERE dismissed_at IS NULL;

-- Redundant with the primary key, which leads with recorded_at on a table
-- already range-partitioned by it. Pure write cost on the largest table.
DROP INDEX IF EXISTS position_samples_time_idx;
