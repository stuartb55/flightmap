import { describe, expect, it, vi } from "vitest";
import {
  FlightRepository,
  hasDetailedTrackAvailable
} from "../src/db/repository.js";

describe("daily summary track availability", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");

  it("does not claim a track for a recent unpositioned-only sighting", () => {
    expect(hasDetailedTrackAvailable("2026-07-29", 0, 30, now)).toBe(false);
  });

  it("requires both positioned observations and retained detail", () => {
    expect(hasDetailedTrackAvailable("2026-07-29", 1, 30, now)).toBe(true);
    expect(hasDetailedTrackAvailable("2026-06-01", 100, 30, now)).toBe(false);
  });
});

describe("live aircraft alerts", () => {
  it("queries only alert rules that require an aircraft warning", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });

    await repository.liveAircraft(new Date("2026-08-01T12:00:00.000Z"));

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("a.rule = ANY($2::text[])"),
      [
        expect.any(Date),
        ["emergency_squawk", "emergency_state", "watchlist", "custom"]
      ]
    );
  });
});

describe("saved-view persistence", () => {
  it("serialises concurrent creates and enforces the installation-wide limit", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "20" }] })
    };
    const database = {
      transaction: vi.fn(async (callback: (value: typeof client) => Promise<unknown>) =>
        callback(client)
      )
    };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });

    await expect(
      repository.createSavedView({
        name: "Twenty-first view",
        configuration: {
          surface: "insights",
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
          bucket: "day",
          preset: "30d",
          sort: "reports_desc",
          compare: false,
          mapLayers: {
            coverage: true,
            rangeRings: true,
            aircraftLabels: true,
            trails: true,
            manchesterWaypoints: true
          },
          viewport: null
        }
      })
    ).rejects.toMatchObject({ code: "SAVED_VIEW_LIMIT" });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
  });
});
