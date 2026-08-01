import { describe, expect, it, vi } from "vitest";
import { FlightRepository } from "../src/db/repository.js";
import {
  COVERAGE_GRID_DEGREES,
  coverageGridCell,
  utcHour
} from "../src/domain/insights.js";
import { nextUtcDate } from "../src/services/insight-backfill.js";

describe("insight rollup boundaries", () => {
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
  });

  it("uses UTC hour and day arithmetic across daylight-saving changes", () => {
    expect(utcHour(new Date("2026-03-29T01:45:00+01:00"))).toBe(
      "2026-03-29T00:00:00.000Z"
    );
    expect(nextUtcDate("2026-03-29")).toBe("2026-03-30");
    expect(nextUtcDate("2024-02-28")).toBe("2024-02-29");
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
});
