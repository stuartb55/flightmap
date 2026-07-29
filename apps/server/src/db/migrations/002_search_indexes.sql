CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS track_sessions_callsigns_gin_idx
  ON track_sessions USING gin (callsigns);
CREATE INDEX IF NOT EXISTS metadata_registration_trgm_idx
  ON aircraft_metadata USING gin (lower(registration) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS metadata_description_trgm_idx
  ON aircraft_metadata USING gin (lower(description) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS metadata_operator_trgm_idx
  ON aircraft_metadata USING gin (lower(operator) gin_trgm_ops);
