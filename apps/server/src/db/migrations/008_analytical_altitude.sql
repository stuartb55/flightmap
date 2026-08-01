ALTER TABLE position_samples
  ADD COLUMN IF NOT EXISTS analytical_altitude_ft double precision;

-- Existing extrema were calculated from unchecked receiver values. Retained
-- position detail is rebuilt by InsightBackfillService after this migration;
-- the raw barometric and geometric values remain available unchanged.
-- For older rollups whose raw detail has expired, an extreme value cannot be
-- corroborated, so it is made unavailable instead of being presented as fact.
UPDATE daily_coverage_cells
SET maximum_altitude_ft = NULL
WHERE maximum_altitude_ft > 60000;

UPDATE hourly_aircraft_activity
SET maximum_altitude_ft = NULL
WHERE maximum_altitude_ft > 60000;

UPDATE daily_aircraft_summary
SET maximum_altitude_ft = NULL
WHERE maximum_altitude_ft > 60000;

UPDATE track_sessions s
SET minimum_altitude_ft = NULL,
    maximum_altitude_ft = NULL,
    last_altitude_ft = NULL,
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM position_samples p WHERE p.session_id = s.id
);

UPDATE insight_backfill_state
SET status = 'pending',
    next_date = NULL,
    processed_days = 0,
    started_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    updated_at = now()
WHERE id = true;
