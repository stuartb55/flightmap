import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/database.js";
import { InsightBackfillService } from "../../src/services/insight-backfill.js";
import { MaintenanceService } from "../../src/services/maintenance.js";
import {
  atMinutes,
  createTestDatabase,
  describeDatabase,
  repository,
  resetDatabase,
  snapshot,
  testDay
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

  /** Partition names carry their UTC day: position_samples_YYYYMMDD. */
  async function partitionDays(): Promise<string[]> {
    const result = await database.query<{ relname: string }>(
      `SELECT child.relname
       FROM pg_inherits
       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
       JOIN pg_class child ON pg_inherits.inhrelid = child.oid
       WHERE parent.oid = 'position_samples'::regclass`
    );
    return result.rows.map((row) => row.relname.replace("position_samples_", ""));
  }

  it("drops expired partitions and keeps the retained ones", async () => {
    const now = new Date();
    const flights = repository(database);
    const stale = new Date(now.getTime() - 40 * 86_400_000);
    // ensure_position_partition refuses dates outside its safety bounds, so
    // the partition is created through the same path ingestion uses.
    await database.query("SELECT ensure_position_partition($1)", [stale]);
    await flights.ingestSnapshot(snapshot(now, [{}]));

    // 001_initial seeds partitions from 31 days ago, and earlier tests leave
    // their own behind, so the expectation is the retention rule rather than
    // a fixed count.
    const day = (at: Date) => at.toISOString().slice(0, 10).replaceAll("-", "");
    const cutoffDay = day(new Date(now.getTime() - 30 * 86_400_000));
    const before = await partitionDays();
    const expectedDrops = before.filter((value) => value < cutoffDay);
    expect(expectedDrops).toContain(day(stale));

    const service = new MaintenanceService(
      database,
      { historyRetentionDays: 30, sessionGapSeconds: 300 },
      logger
    );
    const result = await service.run(now);

    expect(result.failedSteps).toEqual([]);
    expect(result.droppedPartitions).toBe(expectedDrops.length);
    const after = await partitionDays();
    expect(after).not.toContain(day(stale));
    expect(after.filter((value) => value < cutoffDay)).toEqual([]);
    expect(after).toContain(day(now));
  });

  it("deletes expired rows in batches and records the run", async () => {
    const now = atMinutes(0);
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
    // Every counter the run reports is auditable, including the hourly
    // deletions — the one table whose removals leave no dropped partition to
    // show for them.
    const log = await database.query<{
      dropped_partitions: number;
      deleted_alerts: string;
      deleted_receiver_samples: string;
      deleted_hourly_activity: string;
    }>(
      `SELECT dropped_partitions, deleted_alerts, deleted_receiver_samples,
              deleted_hourly_activity
       FROM maintenance_log`
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.deleted_alerts).toBe(String(result.deletedAlerts));
    expect(log.rows[0]?.deleted_receiver_samples).toBe(
      String(result.deletedReceiverSamples)
    );
    expect(log.rows[0]?.deleted_hourly_activity).toBe(
      String(result.deletedHourlyActivity)
    );
  });

  it("closes sessions that stopped reporting and detaches the live row", async () => {
    const at = atMinutes(600);
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
    const day = testDay.toISOString().slice(0, 10);
    const flights = repository(database);
    for (let index = 0; index < 5; index += 1) {
      await flights.ingestSnapshot(
        snapshot(new Date(atMinutes(600).getTime() + index * 1_000), [
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
    const buckets = await database.query<{ reports: string }>(
      "SELECT sum(reports)::text AS reports FROM daily_range_histogram"
    );
    expect(buckets.rows[0]?.reports).toBe("10");
  });
});
