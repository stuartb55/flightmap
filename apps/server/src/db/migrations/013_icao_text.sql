-- `icao char(6)` forced a defensive trim at every read: a value shorter than
-- six characters comes back space-padded, and one missed trim is a silent
-- mismatch. Every ICAO the application stores is exactly six hex characters,
-- so `text` costs nothing and removes the trap.
--
-- position_samples is deliberately left alone. It is the partitioned
-- highest-volume table in the system — hundreds of millions of rows inside the
-- retention window — and ALTER TYPE would rewrite every partition under an
-- ACCESS EXCLUSIVE lock. Its ICAOs are read through `trim()` in the queries
-- that touch them.

ALTER TABLE track_sessions ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE current_aircraft ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE aircraft_summary ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE daily_aircraft_summary ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE aircraft_metadata ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE watchlist ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE alert_events ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE hourly_aircraft_activity ALTER COLUMN icao TYPE text USING trim(icao);
ALTER TABLE custom_alert_rules ALTER COLUMN icao TYPE text USING trim(icao);
