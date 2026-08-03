import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/database.js";
import { InsightBackfillService } from "../../src/services/insight-backfill.js";
import { MaintenanceService } from "../../src/services/maintenance.js";
import {
  createTestDatabase,
  describeDatabase,
  repository,
  resetDatabase,
  snapshot
} from "./harness.js";

const logger = { info: vi.fn(), error: vi.fn() };

describeDatabase("retention maintenance against PostgreSQL", () => {
  let database: Database;

  beforeAll(async () => {
    ({ database } = await createTestDatabase());
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await resetDatabase(database);
    vi.clearAllMocks();
  });

  it("drops expired partitions and keeps the retained ones", async () => {
    const now = new Date();
    const flights = repository(database);
    const stale = new Date(now.getTime() - 40 * 86_400_000);
    // ensure_position_partition refuses dates outside its safety bounds, so
    // the partition is created through the same path ingestion uses.
    await database.query("SELECT ensure_position_partition($1)", [stale]);
    await flights.ingestSnapshot(snapshot(now, [{}]));

    const service = new MaintenanceService(
      database,
      { historyRetentionDays: 30, sessionGapSeconds: 300 },
      logger
    );
    const result = await service.run(now);

    expect(result.failedSteps).toEqual([]);
    expect(result.droppedPartitions).toBe(1);
    const partitions = await database.query<{ relname: string }>(
      `SELECT child.relname
       FROM pg_inherits
       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
       JOIN pg_class child ON pg_inherits.inhrelid = child.oid
       WHERE parent.oid = 'position_samples'::regclass`
    );
    const dropped = `position_samples_${stale.toISOString().slice(0, 10).replaceAll("-", "")}`;
    expect(partitions.rows.map((row) => row.relname)).not.toContain(dropped);
    expect(partitions.rows.length).toBeGreaterThan(0);
  });

  it("deletes expired rows in batches and records the run", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const expired = new Date(now.getTime() - 40 * 86_400_000);
    // More rows than one delete batch, so the ctid loop has to iterate.
    await database.query(
      `INSERT INTO receiver_samples (recorded_at, health, raw)
       SELECT $1::timestamptz - make_interval(secs => index), 'online', '{}'::jsonb
       FROM generate_series(1, 12000) AS index`,
      [expired]
    );
    await database.query(
      `INSERT INTO alert_events (
         id, icao, rule, message, severity, occurred_at, dedupe_key
       )
       SELECT gen_random_uuid(), '400001', 'watchlist', 'old', 'warning',
              $1::timestamptz, 'dedupe-' || index
       FROM generate_series(1, 100) AS index`,
      [expired]
    );

    const service = new MaintenanceService(
      database,
      { historyRetentionDays: 30, sessionGapSeconds: 300 },
      logger
    );
    const result = await service.run(now);

    expect(result.failedSteps).toEqual([]);
    expect(result.deletedReceiverSamples).toBe(12_000);
    expect(result.deletedAlerts).toBe(100);
    const remaining = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM receiver_samples"
    );
    expect(remaining.rows[0]?.count).toBe("0");
    const log = await database.query<{ dropped_partitions: number }>(
      "SELECT dropped_partitions FROM maintenance_log"
    );
    expect(log.rows).toHaveLength(1);
  });

  it("closes sessions that stopped reporting and detaches the live row", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    const flights = repository(database, { sessionGapSeconds: 300 });
    await flights.ingestSnapshot(snapshot(at, [{}]));

    const service = new MaintenanceService(
      database,
      { historyRetentionDays: 30, sessionGapSeconds: 300 },
      logger
    );
    await service.run(new Date(at.getTime() + 3_600_000));

    const sessions = await database.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM track_sessions"
    );
    expect(sessions.rows[0]?.ended_at).not.toBeNull();
    const current = await database.query<{ session_id: string | null }>(
      "SELECT session_id FROM current_aircraft"
    );
    expect(current.rows[0]?.session_id).toBeNull();
  });

  it("rebuilds a day of insights from retained position samples", async () => {
    const day = "2026-08-01";
    const flights = repository(database);
    for (let index = 0; index < 5; index += 1) {
      await flights.ingestSnapshot(
        snapshot(new Date(`2026-08-01T10:00:0${index}.000Z`), [
          { hex: "400001" },
          { hex: "400002" }
        ])
      );
    }
    await database.query("DELETE FROM daily_coverage_cell_aircraft");
    await database.query("DELETE FROM daily_coverage_cells");

    const service = new InsightBackfillService(database, logger);
    await (
      service as unknown as { backfillDay: (day: string) => Promise<void> }
    ).backfillDay(day);

    const cells = await database.query<{ reports: string }>(
      "SELECT reports FROM daily_coverage_cells"
    );
    expect(cells.rows[0]?.reports).toBe("10");
    const members = await database.query<{ icao: string }>(
      "SELECT icao FROM daily_coverage_cell_aircraft ORDER BY icao"
    );
    expect(members.rows.map((row) => row.icao)).toEqual(["400001", "400002"]);
    const rangeMembers = await database.query<{ count: string }>(
      "SELECT count(DISTINCT icao) AS count FROM daily_range_histogram_aircraft"
    );
    expect(rangeMembers.rows[0]?.count).toBe("2");
  });
});
