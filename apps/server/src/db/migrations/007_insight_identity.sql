ALTER TABLE hourly_aircraft_activity
  ADD COLUMN IF NOT EXISTS callsigns text[] NOT NULL DEFAULT '{}';

-- Existing hourly rows pre-date callsign retention. Daily summaries cover the
-- same observations and provide a safe identity backfill for operator
-- inference without requiring retained position detail.
UPDATE hourly_aircraft_activity h
SET callsigns = d.callsigns
FROM daily_aircraft_summary d
WHERE d.icao = h.icao
  AND d.summary_date = (h.bucket_hour AT TIME ZONE 'UTC')::date
  AND cardinality(h.callsigns) = 0
  AND cardinality(d.callsigns) > 0;
