import { describe, expect, it, vi } from "vitest";
import { FlightRepository } from "../src/db/repository.js";
import { airlineOperatorFromCallsign } from "../src/domain/airline-operators.js";
import {
  COVERAGE_GRID_DEGREES,
  coverageGridCell,
  coverageGridCellFromIndices,
  insightMetricChanges,
  receiverPerformanceForBucket,
  utcDay,
  utcHour
} from "../src/domain/insights.js";
import {
  InsightBackfillService,
  nextUtcDate
} from "../src/services/insight-backfill.js";

describe("insight rollup boundaries", () => {
  it("infers operating airlines only from valid known ICAO callsigns", () => {
    expect(airlineOperatorFromCallsign(" EZY42KD ")).toEqual({
      designator: "EZY",
      operator: "easyJet"
    });
    expect(airlineOperatorFromCallsign("baw123")).toEqual({
      designator: "BAW",
      operator: "British Airways"
    });
    expect(airlineOperatorFromCallsign("G-TEST")).toBeNull();
    expect(airlineOperatorFromCallsign("XYZ123")).toBeNull();
    expect(airlineOperatorFromCallsign("EZYABC")).toBeNull();
  });

  it("supplies the offline operator reference to identity-ranked insights", async () => {
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => ({
      rows: sql.includes("FROM ranked WHERE rank")
        ? [{
            kind: "operators",
            key: "easyjet",
            label: "easyJet",
            secondary: "Inferred from EZY callsign",
            reports: "12",
            positioned_reports: "10",
            sessions: "1"
          }]
        : []
    }));
    const repository = new FlightRepository({ query } as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });

    const result = await repository.insightsOverview(
      {
        from: "2026-08-01T10:00:00.000Z",
        to: "2026-08-01T11:00:00.000Z",
        bucket: "hour",
        compare: false
      },
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(result.leaders.operators).toEqual([{
      key: "easyjet",
      label: "easyJet",
      secondary: "Inferred from EZY callsign",
      reports: 12,
      positionedReports: 10,
      sessions: 1
    }]);
    const leaderCall = query.mock.calls.find(([sql]) =>
      sql.includes("reference_designators")
    );
    expect(leaderCall?.[0]).toContain("activity_callsigns");
    // A correlated subquery per ICAO made this the slowest query in the app.
    expect(leaderCall?.[0]).not.toContain("WHERE f2.icao = f.icao");
    expect(JSON.parse(String(leaderCall?.[1]?.[2]))).toContainEqual({
      designator: "EZY",
      operator: "easyJet"
    });
  });

  it("bins positions into stable 0.05 degree cells", () => {
    expect(COVERAGE_GRID_DEGREES).toBe(0.05);
    expect(coverageGridCell(53.3499, -2.2795)).toMatchObject({
      latitudeIndex: 2866,
      longitudeIndex: 3554,
      south: 53.30000000000001,
      west: -2.299999999999983
    });
    expect(coverageGridCell(90, 180)).toMatchObject({
      latitudeIndex: 3599,
      longitudeIndex: 7199
    });
    expect(() => coverageGridCell(Number.NaN, 0)).toThrow(RangeError);
    expect(() => coverageGridCell(0, 181)).toThrow(RangeError);
  });

  it("reconstructs adjacent stored grid indexes without collapsing them", () => {
    const lower = coverageGridCellFromIndices(2866, 3553);
    const upper = coverageGridCellFromIndices(2867, 3553);

    expect(lower.latitude).toBeCloseTo(53.325);
    expect(upper.latitude).toBeCloseTo(53.375);
    expect(upper.latitudeIndex).toBe(2867);
    expect(upper.latitude).not.toBe(lower.latitude);
    expect(() => coverageGridCellFromIndices(3600, 0)).toThrow(RangeError);
  });

  it("uses UTC hour and day arithmetic across daylight-saving changes", () => {
    expect(utcHour(new Date("2026-03-29T01:45:00+01:00"))).toBe(
      "2026-03-29T00:00:00.000Z"
    );
    expect(nextUtcDate("2026-03-29")).toBe("2026-03-30");
    expect(nextUtcDate("2024-02-28")).toBe("2024-02-29");
  });

  it("normalises PostgreSQL date objects before starting the insight backfill", async () => {
    expect(utcDay(new Date("2026-07-29T00:00:00.000Z"))).toBe("2026-07-29");

    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          oldest_date: new Date("2026-07-29T00:00:00.000Z"),
          newest_date: new Date("2026-07-30T00:00:00.000Z")
        }]
      })
      .mockResolvedValueOnce({
        rows: [{
          status: "pending",
          next_date: new Date("2026-07-29T00:00:00.000Z")
        }]
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = new InsightBackfillService(
      { query } as never,
      { info: vi.fn(), error: vi.fn() }
    );

    await service.run();

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SET status = 'running'"),
      ["2026-07-29", "2026-07-30", "2026-07-29", 0, 2]
    );
  });

  it("rebuilds altitude extrema from corroborated position samples", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = {
      transaction: async (callback: (client: { query: typeof query }) => Promise<void>) =>
        callback({ query })
    };
    const service = new InsightBackfillService(
      database as never,
      { info: vi.fn(), error: vi.fn() }
    );

    await (service as unknown as { backfillDay: (day: string) => Promise<void> })
      .backfillDay("2026-08-01");

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const hourly = statements.find((sql) =>
      sql.includes("INSERT INTO hourly_aircraft_activity")
    );
    const coverage = statements.find((sql) =>
      sql.includes("INSERT INTO daily_coverage_cells")
    );
    const repairedSummaries = statements.find((sql) =>
      sql.includes("UPDATE track_sessions")
    );
    expect(hourly).toContain("altitude_sources_agree");
    expect(hourly).toContain("max(trusted_altitude_ft)");
    expect(coverage).toContain("FROM validated_positions");
    expect(repairedSummaries).toContain("UPDATE daily_aircraft_summary");
    expect(repairedSummaries).toContain("last_altitude_ft");
  });

  it("rebuilds distinct-aircraft membership rows instead of array columns", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = {
      transaction: async (callback: (client: { query: typeof query }) => Promise<void>) =>
        callback({ query })
    };
    const service = new InsightBackfillService(
      database as never,
      { info: vi.fn(), error: vi.fn() }
    );

    await (service as unknown as { backfillDay: (day: string) => Promise<void> })
      .backfillDay("2026-08-01");

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("aircraft_icaos"))).toBe(false);
    for (const table of [
      "daily_coverage_cell_aircraft",
      "daily_range_histogram_aircraft"
    ]) {
      expect(
        statements.some((sql) => sql.includes(`DELETE FROM ${table}`))
      ).toBe(true);
      expect(
        statements.some((sql) => sql.includes(`INSERT INTO ${table}`))
      ).toBe(true);
    }
  });

  it("calculates absolute and percentage comparison changes", () => {
    expect(
      insightMetricChanges(
        {
          uniqueAircraft: 12,
          sessions: 8,
          reports: 150,
          positionedReports: 120,
          maximumRangeNm: 90,
          maximumAltitudeFt: null
        },
        {
          uniqueAircraft: 10,
          sessions: 10,
          reports: 100,
          positionedReports: 80,
          maximumRangeNm: 0,
          maximumAltitudeFt: null
        }
      )
    ).toMatchObject({
      uniqueAircraft: { absolute: 2, percent: 20 },
      sessions: { absolute: -2, percent: -20 },
      reports: { absolute: 50, percent: 50 },
      maximumRangeNm: { absolute: 90, percent: null },
      maximumAltitudeFt: { absolute: null, percent: null }
    });
  });

  it("measures receiver availability and missing sample time within retained detail", () => {
    expect(
      receiverPerformanceForBucket(
        new Date("2026-08-01T10:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-08-01T10:15:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-07-01T00:00:00.000Z"),
        60_000,
        {
          samples: 40,
          availableSamples: 36,
          messageRatePerSecond: 125.5,
          rejectedRecords: 7
        }
      )
    ).toEqual({
      messageRatePerSecond: 125.5,
      receiverAvailabilityPercent: 80,
      rejectedRecords: 7,
      dataGapMinutes: 5
    });
  });

  it("distinguishes unavailable receiver history from a retained data gap", () => {
    expect(
      receiverPerformanceForBucket(
        new Date("2026-08-01T10:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-08-01T10:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        60_000
      )
    ).toEqual({
      messageRatePerSecond: null,
      receiverAvailabilityPercent: null,
      rejectedRecords: null,
      dataGapMinutes: null
    });
    expect(
      receiverPerformanceForBucket(
        new Date("2026-08-01T10:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-08-01T10:00:00.000Z"),
        new Date("2026-08-01T11:00:00.000Z"),
        new Date("2026-07-01T00:00:00.000Z"),
        60_000
      )
    ).toEqual({
      messageRatePerSecond: null,
      receiverAvailabilityPercent: 0,
      rejectedRecords: null,
      dataGapMinutes: 60
    });
  });

  it("rejects expired hourly queries before touching PostgreSQL", async () => {
    const database = { query: vi.fn() };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });
    await expect(
      repository.insightsOverview(
        {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-05-02T00:00:00.000Z",
          bucket: "hour",
          compare: false
        },
        new Date("2026-08-01T12:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "HOURLY_DETAIL_EXPIRED" });
    expect(database.query).not.toHaveBeenCalled();
  });

  it("serialises PostgreSQL date values as ISO calendar dates", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          hourly_from: new Date("2026-07-01T00:00:00.000Z"),
          daily_from: new Date("2026-06-01T00:00:00.000Z"),
          coverage_from: new Date("2026-06-02T00:00:00.000Z"),
          status: "running",
          processed_days: 2,
          total_days: 4,
          next_date: new Date("2026-06-03T00:00:00.000Z"),
          last_error: null
        }]
      })
    };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });
    await expect(repository.insightAvailability()).resolves.toMatchObject({
      dailyFrom: "2026-06-01",
      coverageFrom: "2026-06-02",
      backfill: { nextDate: "2026-06-03" }
    });
  });

  it("rejects hourly comparisons whose preceding period has expired", async () => {
    const database = { query: vi.fn() };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });
    await expect(
      repository.insightsOverview(
        {
          from: "2026-07-02T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
          bucket: "hour",
          compare: true
        },
        new Date("2026-08-01T12:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "HOURLY_DETAIL_EXPIRED" });
    expect(database.query).not.toHaveBeenCalled();
  });
});
