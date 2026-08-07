-- Callsign-to-route lookups, cached.
--
-- ADS-B does not carry a route, so this is the result of asking an external
-- service about a callsign. It is cached because the answer changes on the
-- airline's schedule rather than on the aircraft's, and because the same
-- callsign is asked about every time anyone selects that aircraft.
--
-- A lookup that found nothing is cached too, under `found = false`: without it
-- every general-aviation callsign — which will never resolve — is re-asked on
-- every selection for as long as the aircraft is in range.
CREATE TABLE IF NOT EXISTS flight_routes (
  callsign text PRIMARY KEY,
  found boolean NOT NULL,
  origin_iata text,
  origin_icao text,
  origin_name text,
  origin_municipality text,
  destination_iata text,
  destination_icao text,
  destination_name text,
  destination_municipality text,
  resolved_at timestamptz NOT NULL DEFAULT now()
);

-- The sweep that drops entries past their time to live orders by age.
CREATE INDEX IF NOT EXISTS flight_routes_resolved_at_idx
  ON flight_routes (resolved_at);
