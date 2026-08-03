import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import type { FlightRepository } from "../../src/db/repository.js";
import {
  createTestDatabase,
  describeDatabase,
  repository,
  resetDatabase,
  snapshot
} from "./harness.js";

describeDatabase("ingestion against PostgreSQL", () => {
  let database: Database;
  let flights: FlightRepository;

  beforeAll(async () => {
    ({ database } = await createTestDatabase());
    flights = repository(database, { sessionGapSeconds: 300 });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await resetDatabase(database);
  });

  it("writes the live row, the session, and the position sample", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    const result = await flights.ingestSnapshot(snapshot(at, [{}]));

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.sessionId).not.toBeNull();

    const live = await flights.liveAircraft(at);
    expect(live.map((item) => item.icao)).toEqual(["400001"]);
    expect(live[0]?.distanceNm).toBeGreaterThan(0);

    const positions = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM position_samples"
    );
    expect(positions.rows[0]?.count).toBe("1");

    const sessions = await database.query<{ sample_count: string }>(
      "SELECT sample_count FROM track_sessions"
    );
    expect(sessions.rows[0]?.sample_count).toBe("1");
  });

  it("continues a session inside the gap and starts a new one beyond it", async () => {
    const first = new Date("2026-08-01T10:00:00.000Z");
    const inGap = new Date("2026-08-01T10:04:00.000Z");
    const afterGap = new Date("2026-08-01T10:20:00.000Z");

    const one = await flights.ingestSnapshot(snapshot(first, [{}]));
    const two = await flights.ingestSnapshot(snapshot(inGap, [{}]));
    expect(two.upserts[0]?.sessionId).toBe(one.upserts[0]?.sessionId);

    const three = await flights.ingestSnapshot(snapshot(afterGap, [{}]));
    expect(three.upserts[0]?.sessionId).not.toBe(one.upserts[0]?.sessionId);

    const sessions = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM track_sessions"
    );
    expect(sessions.rows[0]?.count).toBe("2");
  });

  it("keeps distinct-aircraft membership out of the aggregate rows", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(snapshot(at, [{ hex: "400001" }]));
    await flights.ingestSnapshot(
      snapshot(new Date(at.getTime() + 1000), [
        { hex: "400001" },
        { hex: "400002" }
      ])
    );

    const cells = await database.query<{ reports: string }>(
      "SELECT reports FROM daily_coverage_cells"
    );
    expect(cells.rows).toHaveLength(1);
    expect(cells.rows[0]?.reports).toBe("3");

    const members = await database.query<{ icao: string }>(
      "SELECT icao FROM daily_coverage_cell_aircraft ORDER BY icao"
    );
    expect(members.rows.map((row) => row.icao)).toEqual(["400001", "400002"]);

    const rangeMembers = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM daily_range_histogram_aircraft"
    );
    expect(Number(rangeMembers.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("reports coverage insights and cell detail from the membership table", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(
      snapshot(at, [{ hex: "400001" }, { hex: "400002" }])
    );

    const coverage = await flights.insightsCoverage({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z"
    });
    expect(coverage.cells).toHaveLength(1);
    expect(coverage.cells[0]?.uniqueAircraft).toBe(2);
    expect(coverage.cells[0]?.reports).toBe(2);

    const detail = await flights.coverageCellDetail({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      latitude: 53.4,
      longitude: -2.3
    });
    expect(detail.cell.uniqueAircraft).toBe(2);
    expect(detail.aircraft.map((item) => item.icao)).toEqual([
      "400001",
      "400002"
    ]);
  });

  it("expires live aircraft past the TTL and reads one aircraft by ICAO", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(
      snapshot(at, [{ hex: "400001" }, { hex: "400002" }])
    );

    const one = await flights.liveAircraft(at, ["400002"]);
    expect(one.map((item) => item.icao)).toEqual(["400002"]);

    const removed = await flights.removeExpiredCurrent(
      new Date(at.getTime() + 10 * 60_000)
    );
    expect(removed.sort()).toEqual(["400001", "400002"]);
    expect(await flights.liveAircraft(at)).toEqual([]);
  });

  it("raises an emergency alert for a squawk and exposes it on the live row", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    const result = await flights.ingestSnapshot(
      snapshot(at, [{ squawk: "7700" }])
    );

    expect(result.alerts.map((alert) => alert.rule)).toContain(
      "emergency_squawk"
    );
    const live = await flights.liveAircraft(at);
    expect(live[0]?.hasActiveAlert).toBe(true);
  });

  it("searches summaries and sessions case-insensitively", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(
      snapshot(at, [{ hex: "400001", flight: "EZY42KD" }])
    );

    const summaries = await flights.summaries({ query: "ezy42", limit: 20 });
    expect(summaries.items.map((item) => item.icao)).toEqual(["400001"]);

    const sessions = await flights.sessions({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      query: "EZY42",
      limit: 20
    });
    expect(sessions.items).toHaveLength(1);

    const noMatch = await flights.summaries({ query: "zzzz", limit: 20 });
    expect(noMatch.items).toEqual([]);
  });

  it("aggregates the daily insights leaderboard", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(
      snapshot(at, [
        { hex: "400001", flight: "EZY42KD" },
        { hex: "400002", flight: "BAW11X" }
      ])
    );

    const overview = await flights.insightsOverview(
      {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        bucket: "day",
        compare: false
      },
      new Date("2026-08-01T12:00:00.000Z")
    );
    expect(overview.metrics.uniqueAircraft).toBe(2);
    expect(overview.leaders.aircraft.length).toBeGreaterThan(0);
    expect(overview.series).toHaveLength(1);
  });

  it("ignores a duplicate snapshot without double counting", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await flights.ingestSnapshot(snapshot(at, [{}]));
    await flights.ingestSnapshot(snapshot(at, [{}]));

    const positions = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM position_samples"
    );
    expect(positions.rows[0]?.count).toBe("1");
  });

  it("previews a custom alert rule with the altitude ingestion uses", async () => {
    // Barometric and geometric altitudes disagree by more than the analytical
    // tolerance, so no altitude may be trusted for rule matching.
    await flights.ingestSnapshot(
      snapshot(new Date(), [
        { hex: "400001", alt_baro: 12_000, alt_geom: 30_000 }
      ])
    );

    const preview = await flights.previewCustomAlertRule({
      name: "Above 10,000 ft",
      severity: "warning",
      enabled: true,
      cooldownMinutes: 0,
      minimumAltitudeFt: 10_000
    } as never);
    expect(preview.matches).toEqual([]);

    const nearby = await flights.previewCustomAlertRule({
      name: "Anything nearby",
      severity: "info",
      enabled: true,
      cooldownMinutes: 0,
      maximumDistanceNm: 500
    } as never);
    expect(nearby.matches.map((match) => match.icao)).toEqual(["400001"]);
  });

  it("creates a partition per UTC day as snapshots roll over midnight", async () => {
    await flights.ingestSnapshot(
      snapshot(new Date("2026-08-01T23:59:59.000Z"), [{}])
    );
    await flights.ingestSnapshot(
      snapshot(new Date("2026-08-02T00:00:01.000Z"), [{}])
    );

    const partitions = await database.query<{ relname: string }>(
      `SELECT child.relname
       FROM pg_inherits
       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
       JOIN pg_class child ON pg_inherits.inhrelid = child.oid
       WHERE parent.oid = 'position_samples'::regclass
       ORDER BY child.relname`
    );
    expect(partitions.rows.map((row) => row.relname)).toEqual(
      expect.arrayContaining([
        "position_samples_20260801",
        "position_samples_20260802"
      ])
    );
  });
});
