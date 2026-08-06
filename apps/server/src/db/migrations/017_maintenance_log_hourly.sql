-- The retention run has deleted from `hourly_aircraft_activity` since it was
-- split into per-step transactions, but the audit row never recorded it — so
-- the one table whose deletions are not visible as reclaimed partitions was
-- also the one the log could not account for.

ALTER TABLE maintenance_log
  ADD COLUMN IF NOT EXISTS deleted_hourly_activity bigint NOT NULL DEFAULT 0;
