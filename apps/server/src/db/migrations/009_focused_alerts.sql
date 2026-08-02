-- A new ICAO address is routine receiver history, not an event requiring attention.
-- Preserve the canonical first-seen timestamp in aircraft_summary while removing
-- the redundant alert rows and configuration that caused noisy alert feeds.
DELETE FROM alert_events WHERE rule = 'first_seen';

UPDATE application_settings
SET settings = settings - 'firstSeenAlertsEnabled' - 'firstSeenAlertBaselineHours',
    updated_at = now()
WHERE settings ? 'firstSeenAlertsEnabled'
   OR settings ? 'firstSeenAlertBaselineHours';

UPDATE saved_views
SET configuration = jsonb_set(configuration, '{filters,alert}', '""'::jsonb),
    updated_at = now()
WHERE surface = 'history'
  AND configuration #>> '{filters,alert}' = 'first_seen';

ALTER TABLE alert_events
  DROP CONSTRAINT IF EXISTS alert_events_rule_check;

ALTER TABLE alert_events
  ADD CONSTRAINT alert_events_rule_check CHECK (
    rule IN ('emergency_squawk', 'emergency_state', 'watchlist')
  );
