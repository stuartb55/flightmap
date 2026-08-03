import { describe } from "vitest";
import { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrator.js";
import { loadConfig, type Config } from "../../src/config.js";
import { FlightRepository } from "../../src/db/repository.js";
import { normaliseSnapshot } from "../../src/domain/normalise.js";
import type { NormalisedSnapshot } from "../../src/domain/normalise.js";

/**
 * Integration tests run against a real PostgreSQL. They are skipped unless
 * FLIGHTMAP_TEST_DATABASE_URL is set, so the default `npm test` still runs
 * with no services. CI sets it from a service container.
 */
export const testDatabaseUrl = process.env.FLIGHTMAP_TEST_DATABASE_URL ?? null;
export const describeDatabase = testDatabaseUrl ? describe : describe.skip;

export function integrationConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      SERVE_WEB: "false",
      DATABASE_URL: testDatabaseUrl ?? "postgres://unused"
    }),
    ...overrides
  };
}

export async function createTestDatabase(
  overrides: Partial<Config> = {}
): Promise<{ database: Database; config: Config }> {
  const config = integrationConfig(overrides);
  const database = new Database(config);
  await migrate(database);
  return { database, config };
}

/** Everything the application writes, in dependency order. */
const applicationTables = [
  "alert_events",
  "position_samples",
  "track_sessions",
  "current_aircraft",
  "daily_coverage_cell_aircraft",
  "daily_coverage_cells",
  "daily_range_histogram_aircraft",
  "daily_range_histogram",
  "hourly_aircraft_activity",
  "daily_aircraft_summary",
  "aircraft_summary",
  "aircraft_metadata",
  "watchlist",
  "custom_alert_rules",
  "saved_views",
  "receiver_samples",
  "collector_checkpoint",
  "maintenance_log"
];

export async function resetDatabase(database: Database): Promise<void> {
  await database.query(
    `TRUNCATE ${applicationTables.join(", ")} RESTART IDENTITY CASCADE`
  );
}

export function repository(
  database: Database,
  overrides: Partial<Config> = {}
): FlightRepository {
  return new FlightRepository(database, integrationConfig(overrides));
}

type AircraftOverrides = {
  hex?: string;
  flight?: string;
  lat?: number | null;
  lon?: number | null;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  squawk?: string;
  seen?: number;
};

/** Builds a receiver payload and normalises it exactly as the collector does. */
export function snapshot(
  recordedAt: Date,
  aircraft: AircraftOverrides[],
  messages = 1_000
): NormalisedSnapshot {
  return normaliseSnapshot(
    {
      now: recordedAt.getTime() / 1000,
      messages,
      aircraft: aircraft.map((item) => ({
        hex: item.hex ?? "400001",
        flight: item.flight ?? "TEST123",
        lat: item.lat === undefined ? 53.4 : item.lat,
        lon: item.lon === undefined ? -2.3 : item.lon,
        alt_baro: item.alt_baro ?? 12_000,
        alt_geom: item.alt_geom ?? 12_200,
        gs: item.gs ?? 350,
        track: 90,
        baro_rate: 0,
        squawk: item.squawk ?? "7000",
        category: "A3",
        nic: 8,
        rssi: -12.5,
        messages: 500,
        seen: item.seen ?? 0,
        seen_pos: item.seen ?? 0,
        type: "adsb_icao",
        version: 2
      }))
    },
    { receiverLatitude: 53.61, receiverLongitude: -2.31 }
  );
}
