-- Distinct-aircraft membership moves out of the aggregate rows.
-- The `aircraft_icaos text[]` columns were read, concatenated, de-duplicated
-- and rewritten in full on every 1 Hz snapshot, so the write cost of a busy
-- cell grew all day and only reset at midnight UTC.

CREATE TABLE IF NOT EXISTS daily_coverage_cell_aircraft (
  coverage_date date NOT NULL,
  latitude_index smallint NOT NULL CHECK (latitude_index BETWEEN 0 AND 3599),
  longitude_index smallint NOT NULL CHECK (longitude_index BETWEEN 0 AND 7199),
  icao text NOT NULL,
  PRIMARY KEY (coverage_date, latitude_index, longitude_index, icao)
);

-- Serves the single-cell detail view, which filters cell first and date second.
CREATE INDEX IF NOT EXISTS daily_coverage_cell_aircraft_cell_idx
  ON daily_coverage_cell_aircraft
     (latitude_index, longitude_index, coverage_date, icao);

CREATE TABLE IF NOT EXISTS daily_range_histogram_aircraft (
  profile_date date NOT NULL,
  bearing_bucket smallint NOT NULL CHECK (bearing_bucket BETWEEN 0 AND 71),
  altitude_band text NOT NULL
    CHECK (altitude_band IN ('ground', 'low', 'medium', 'high')),
  range_bucket_nm smallint NOT NULL CHECK (range_bucket_nm BETWEEN 0 AND 500),
  icao text NOT NULL,
  PRIMARY KEY (profile_date, bearing_bucket, altitude_band, range_bucket_nm, icao)
);

INSERT INTO daily_coverage_cell_aircraft (
  coverage_date, latitude_index, longitude_index, icao
)
SELECT coverage_date, latitude_index, longitude_index, trim(icao)
FROM daily_coverage_cells
CROSS JOIN LATERAL unnest(aircraft_icaos) AS icao
WHERE trim(icao) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO daily_range_histogram_aircraft (
  profile_date, bearing_bucket, altitude_band, range_bucket_nm, icao
)
SELECT profile_date, bearing_bucket, altitude_band, range_bucket_nm, trim(icao)
FROM daily_range_histogram
CROSS JOIN LATERAL unnest(aircraft_icaos) AS icao
WHERE trim(icao) <> ''
ON CONFLICT DO NOTHING;

ALTER TABLE daily_coverage_cells DROP COLUMN IF EXISTS aircraft_icaos;
ALTER TABLE daily_range_histogram DROP COLUMN IF EXISTS aircraft_icaos;
