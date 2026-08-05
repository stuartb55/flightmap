import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { SessionSort } from "@flightmap/shared";
import type { Database } from "../../src/db/database.js";
import type { FlightRepository } from "../../src/db/repository.js";
import {
  atMinutes,
  createTestDatabase,
  dayBoundary,
  describeDatabase,
  repository,
  resetDatabase,
  snapshot,
  testDay
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
    const at = atMinutes(600);
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
    const first = atMinutes(600);
    const inGap = atMinutes(604);
    const afterGap = atMinutes(620);

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
    const at = atMinutes(600);
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
    const at = atMinutes(600);
    await flights.ingestSnapshot(
      snapshot(at, [{ hex: "400001" }, { hex: "400002" }])
    );

    const coverage = await flights.insightsCoverage({
      from: dayBoundary(0),
      to: dayBoundary(1)
    });
    expect(coverage.cells).toHaveLength(1);
    expect(coverage.cells[0]?.uniqueAircraft).toBe(2);
    expect(coverage.cells[0]?.reports).toBe(2);

    const detail = await flights.coverageCellDetail({
      from: dayBoundary(0),
      to: dayBoundary(1),
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
    const at = atMinutes(600);
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
    const at = atMinutes(600);
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
    const at = atMinutes(600);
    await flights.ingestSnapshot(
      snapshot(at, [{ hex: "400001", flight: "EZY42KD" }])
    );

    const summaries = await flights.summaries({ query: "ezy42", limit: 20 });
    expect(summaries.items.map((item) => item.icao)).toEqual(["400001"]);

    const sessions = await flights.sessions({
      from: dayBoundary(0),
      to: dayBoundary(1),
      query: "EZY42",
      limit: 20
    });
    expect(sessions.items).toHaveLength(1);

    const noMatch = await flights.summaries({ query: "zzzz", limit: 20 });
    expect(noMatch.items).toEqual([]);
  });

  it("aggregates the daily insights leaderboard", async () => {
    const at = atMinutes(600);
    await flights.ingestSnapshot(
      snapshot(at, [
        { hex: "400001", flight: "EZY42KD" },
        { hex: "400002", flight: "BAW11X" }
      ])
    );

    const overview = await flights.insightsOverview(
      {
        from: dayBoundary(0),
        to: dayBoundary(1),
        bucket: "day",
        compare: false
      },
      atMinutes(720)
    );
    expect(overview.metrics.uniqueAircraft).toBe(2);
    expect(overview.leaders.aircraft.length).toBeGreaterThan(0);
    expect(overview.series).toHaveLength(1);
  });

  it("orders sessions by every supported sort, and pages each one", async () => {
    // Three aircraft, deliberately ranked differently by each measure: the
    // long flight is not the closest, and the closest is not the highest.
    // Both altitude sources must agree, or `analyticalAltitudeFt` discards the
    // reading and every session records a NULL maximum.
    const fleet = [
      { hex: "400001", lat: 53.61, lon: -2.31, altitude: 5_000, minutes: [600, 601, 602, 603] },
      { hex: "400002", lat: 54.6, lon: -2.31, altitude: 38_000, minutes: [601, 602] },
      { hex: "400003", lat: 55.6, lon: -2.31, altitude: 20_000, minutes: [602] }
    ];
    for (const aircraft of fleet) {
      for (const minute of aircraft.minutes) {
        await flights.ingestSnapshot(
          snapshot(atMinutes(minute), [
            {
              hex: aircraft.hex,
              lat: aircraft.lat,
              lon: aircraft.lon,
              alt_baro: aircraft.altitude,
              alt_geom: aircraft.altitude + 200
            }
          ])
        );
      }
    }
    const search = async (sort: SessionSort, cursor?: string) =>
      flights.sessions({
        from: dayBoundary(0),
        to: dayBoundary(1),
        limit: cursor === undefined ? 20 : 2,
        sort,
        ...(cursor ? { cursor } : {})
      });

    expect((await search("started_desc")).items.map((item) => item.icao)).toEqual([
      "400003",
      "400002",
      "400001"
    ]);
    expect((await search("started_asc")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002",
      "400003"
    ]);
    // 400001 reported over three minutes, 400002 over one, 400003 not at all.
    expect((await search("duration_desc")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002",
      "400003"
    ]);
    expect((await search("closest_asc")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002",
      "400003"
    ]);
    expect((await search("altitude_desc")).items.map((item) => item.icao)).toEqual([
      "400002",
      "400003",
      "400001"
    ]);
    expect((await search("samples_desc")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002",
      "400003"
    ]);

    // Each sort pages by its own ordering value, so the second page continues
    // where the first stopped rather than starting again.
    for (const sort of [
      "started_desc",
      "started_asc",
      "duration_desc",
      "closest_asc",
      "altitude_desc",
      "samples_desc"
    ] as const) {
      const whole = await search(sort);
      const firstPage = await flights.sessions({
        from: dayBoundary(0),
        to: dayBoundary(1),
        limit: 2,
        sort
      });
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await search(sort, firstPage.nextCursor ?? undefined);
      expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).toEqual(
        whole.items.map((item) => item.id)
      );
    }
  });

  it("filters sessions to a weekday-hour window in the zone it is asked for", async () => {
    /*
     * The Insights pattern grid names a weekday and an hour in the viewer's
     * zone, so the drill-down has to return exactly the sessions that started
     * inside that window — no more, and no fewer once the zone shifts it.
     */
    const fleet = [
      { hex: "400001", minute: 9 * 60 + 15 },
      { hex: "400002", minute: 9 * 60 + 50 },
      { hex: "400003", minute: 13 * 60 + 20 }
    ];
    for (const aircraft of fleet) {
      await flights.ingestSnapshot(
        snapshot(atMinutes(aircraft.minute), [{ hex: aircraft.hex }])
      );
    }
    // testDay is a UTC midnight, so its ISO weekday is the one every session
    // on that day falls on in UTC.
    const weekday = ((testDay.getUTCDay() + 6) % 7);
    const window = async (hour: number, timeZone: string) =>
      flights.sessions({
        from: dayBoundary(0),
        to: dayBoundary(1),
        sort: "started_asc",
        limit: 20,
        weekday,
        hour,
        timeZone
      });

    expect((await window(9, "UTC")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002"
    ]);
    expect((await window(13, "UTC")).items.map((item) => item.icao)).toEqual([
      "400003"
    ]);
    expect((await window(11, "UTC")).items).toEqual([]);

    // Etc/GMT-3 is UTC+3 and never observes summer time, so 09:15 UTC is
    // always 12:15 there and the window moves with the zone, not the clock.
    expect((await window(12, "Etc/GMT-3")).items.map((item) => item.icao)).toEqual([
      "400001",
      "400002"
    ]);
    expect((await window(9, "Etc/GMT-3")).items).toEqual([]);

    // Without the window the whole day comes back, so the filter is doing the
    // narrowing rather than the range.
    const unfiltered = await flights.sessions({
      from: dayBoundary(0),
      to: dayBoundary(1),
      sort: "started_asc",
      limit: 20
    });
    expect(unfiltered.items).toHaveLength(3);
  });

  it("finds a weekday-hour window through the started_at index", async () => {
    const weekday = (testDay.getUTCDay() + 6) % 7;
    const plan = await database.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT s.id FROM track_sessions s
       WHERE s.started_at >= $1 AND s.started_at <= $2
         AND extract(isodow FROM s.started_at AT TIME ZONE 'UTC')::int - 1 = $3
         AND extract(hour FROM s.started_at AT TIME ZONE 'UTC')::int = 9`,
      [dayBoundary(0), dayBoundary(1), weekday]
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    // The window is a residual filter on rows the range predicate has already
    // found; it must not turn the range scan into a sequential one.
    expect(text).not.toMatch(/Seq Scan/);
  });

  it("ignores a duplicate snapshot without double counting", async () => {
    const at = atMinutes(600);
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
    const lastSecond = new Date(atMinutes(1439).getTime() + 59_000);
    const firstSecond = new Date(atMinutes(1440).getTime() + 1_000);
    await flights.ingestSnapshot(snapshot(lastSecond, [{}]));
    await flights.ingestSnapshot(snapshot(firstSecond, [{}]));
    const partitionName = (at: Date) =>
      `position_samples_${at.toISOString().slice(0, 10).replaceAll("-", "")}`;

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
        partitionName(lastSecond),
        partitionName(firstSecond)
      ])
    );
  });
});
