import { describe, expect, it } from "vitest";
import {
  aircraftActivityQuerySchema,
  icaoSchema,
  coverageCellDetailQuerySchema,
  dismissAlertsInputSchema,
  customAlertRuleInputSchema,
  customAlertRulePatchSchema,
  insightCoverageQuerySchema,
  insightPatternsQuerySchema,
  insightQuerySchema,
  rangeProfileQuerySchema,
  receiverAircraftSchema,
  alertQuerySchema,
  savedViewInputSchema,
  savedViewPatchSchema,
  sessionExportQuerySchema,
  sessionQuerySchema,
  summaryQuerySchema,
  trackQuerySchema
} from "../src/index.js";

describe("shared contracts", () => {
  it("canonicalises valid ICAO identifiers", () => {
    expect(icaoSchema.parse(" A0B1C2 ")).toBe("a0b1c2");
    expect(() => icaoSchema.parse("~abc12")).toThrow();
  });

  it("accepts sparse and forward-compatible receiver records", () => {
    const parsed = receiverAircraftSchema.parse({
      hex: "ABC123",
      alt_baro: "ground",
      future_receiver_field: { value: 1 }
    });
    expect(parsed.alt_baro).toBe("ground");
    expect(parsed.future_receiver_field).toEqual({ value: 1 });
  });

  it("caps searches and rejects reversed ranges", () => {
    expect(() => sessionQuerySchema.parse({ limit: "201" })).toThrow();
    expect(() =>
      sessionQuerySchema.parse({
        from: "2026-01-02T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z"
      })
    ).toThrow();
    expect(() => sessionQuerySchema.parse({ alert: "first_seen" })).toThrow();
  });

  it("takes a weekday-hour window only as a complete pair in a real zone", () => {
    expect(
      sessionQuerySchema.parse({
        weekday: "2",
        hour: "0",
        timeZone: "Europe/London"
      })
    ).toMatchObject({ weekday: 2, hour: 0, timeZone: "Europe/London" });

    // Half a window would filter on a weekday across every hour, or an hour
    // across every day — neither is a cell the pattern grid can produce.
    expect(() => sessionQuerySchema.parse({ weekday: "2" })).toThrow();
    expect(() => sessionQuerySchema.parse({ hour: "9" })).toThrow();
    expect(() => sessionQuerySchema.parse({ weekday: "7", hour: "9" })).toThrow();
    expect(() => sessionQuerySchema.parse({ weekday: "0", hour: "24" })).toThrow();
    // An unrecognised zone raises inside PostgreSQL rather than returning
    // nothing, so it is refused here as bad input.
    expect(() =>
      sessionQuerySchema.parse({ weekday: "0", hour: "9", timeZone: "Mars/Olympus" })
    ).toThrow();

    // An absent window is the ordinary case and stays absent.
    const unfiltered = sessionQuerySchema.parse({});
    expect(unfiltered.weekday).toBeUndefined();
    expect(unfiltered.hour).toBeUndefined();
  });

  it("bounds track reads and parses incremental query options", () => {
    expect(
      trackQuerySchema.parse({
        limit: "20000",
        tail: "true",
        from: "2026-07-29T12:00:00.000Z"
      })
    ).toMatchObject({ limit: 20_000, tail: true });
    expect(() => trackQuerySchema.parse({ limit: "20001" })).toThrow();
  });

  it("applies bounded export defaults and accepts explicit export options", () => {
    expect(sessionExportQuerySchema.parse({})).toEqual({
      format: "csv",
      resolution: "auto"
    });
    expect(
      sessionExportQuerySchema.parse({
        format: "geojson",
        resolution: "15s",
        from: "2026-08-01T10:00:00.000Z"
      })
    ).toEqual({
      format: "geojson",
      resolution: "15s",
      from: "2026-08-01T10:00:00.000Z"
    });
    expect(() => sessionExportQuerySchema.parse({ extra: true })).toThrow();
  });

  it("validates ordered summary ranges and tri-state alert dismissal filters", () => {
    expect(() =>
      summaryQuerySchema.parse({ from: "2026-08-02", to: "2026-08-01" })
    ).toThrow();
    expect(alertQuerySchema.parse({ dismissed: "true" }).dismissed).toBe(true);
    expect(alertQuerySchema.parse({ dismissed: "false" }).dismissed).toBe(false);
    expect(alertQuerySchema.parse({}).dismissed).toBeUndefined();
  });

  it("bounds bulk alert dismissals", () => {
    const id = "9b7dc991-58bf-4c42-b033-40c637d3f09a";
    expect(dismissAlertsInputSchema.parse({ ids: [id] }).ids).toEqual([id]);
    expect(() =>
      dismissAlertsInputSchema.parse({ ids: Array(201).fill(id) })
    ).toThrow();
  });

  it("validates custom alert predicates and permits operational patches", () => {
    expect(customAlertRuleInputSchema.parse({
      name: "Nearby cargo",
      operator: "Cargo",
      maximumDistanceNm: 25,
      severity: "warning"
    })).toMatchObject({ operator: "Cargo", maximumDistanceNm: 25, cooldownMinutes: 0 });
    expect(() => customAlertRuleInputSchema.parse({ name: "No conditions" })).toThrow();
    expect(() => customAlertRuleInputSchema.parse({
      name: "Reversed altitude",
      minimumAltitudeFt: 20_000,
      maximumAltitudeFt: 10_000
    })).toThrow();
    expect(customAlertRulePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("requires ordered UTC insight ranges and an explicit bucket", () => {
    expect(
      insightQuerySchema.parse({
        from: "2026-07-31T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        bucket: "hour",
        compare: "true"
      })
    ).toMatchObject({ bucket: "hour", compare: true });
    expect(() =>
      insightQuerySchema.parse({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-07-31T00:00:00.000Z",
        bucket: "day"
      })
    ).toThrow();
    expect(() =>
      insightCoverageQuerySchema.parse({
        from: "2026-08-01",
        to: "2026-08-02"
      })
    ).toThrow();
  });

  it("validates the extended insight and aircraft activity queries", () => {
    const from = "2026-07-31T00:00:00.000Z";
    const to = "2026-08-01T00:00:00.000Z";

    expect(insightPatternsQuerySchema.parse({
      from,
      to,
      timeZone: "Europe/London",
      compare: "true"
    })).toMatchObject({ timeZone: "Europe/London", compare: true });
    expect(rangeProfileQuerySchema.parse({ from, to })).toMatchObject({
      altitudeBand: "all",
      compare: false
    });
    expect(aircraftActivityQuerySchema.parse({ from, to })).toMatchObject({
      bucket: "day"
    });
    expect(coverageCellDetailQuerySchema.parse({
      from,
      to,
      latitude: "53.35",
      longitude: "-2.27"
    })).toMatchObject({ latitude: 53.35, longitude: -2.27 });

    const reversed = { from: to, to: from };
    expect(() => insightPatternsQuerySchema.parse({
      ...reversed,
      timeZone: "Europe/London"
    })).toThrow();
    expect(() => rangeProfileQuerySchema.parse(reversed)).toThrow();
    expect(() => aircraftActivityQuerySchema.parse(reversed)).toThrow();
  });

  it("strictly validates surface-specific saved views", () => {
    const live = {
      name: "Nearby aircraft",
      configuration: {
        surface: "live",
        filters: {
          query: "",
          minimumAltitude: "",
          maximumAltitude: "10000",
          minimumSpeed: "",
          maximumDistance: "30",
          maximumFreshness: "15",
          position: "positioned",
          source: "adsb",
          category: "",
          watchedOnly: false,
          alertsOnly: false
        },
        sort: { key: "distance", direction: "asc" },
        mapLayers: {
          coverage: false,
          rangeRings: true,
          aircraftLabels: true,
          trails: true,
          allTrails: false,
          manchesterWaypoints: true
        },
        viewport: null
      }
    };
    expect(savedViewInputSchema.parse(live)).toEqual(live);
    // A view stored before allTrails existed must still load, taking the
    // default rather than failing this strict object for a missing key.
    const { allTrails, ...legacyLayers } = live.configuration.mapLayers;
    expect(allTrails).toBe(false);
    expect(
      savedViewInputSchema.parse({
        ...live,
        configuration: { ...live.configuration, mapLayers: legacyLayers }
      })
    ).toEqual(live);
    // Every column the live table can sort by must round-trip, or saving a view
    // fails for a sort the interface happily offers.
    for (const key of [
      "identity",
      "altitude",
      "distance",
      "speed",
      "freshness",
      "verticalRate",
      "track",
      "squawk",
      "operator",
      "typeCode"
    ]) {
      const sorted = {
        ...live,
        configuration: { ...live.configuration, sort: { key, direction: "desc" } }
      };
      expect(savedViewInputSchema.parse(sorted)).toEqual(sorted);
    }
    expect(() =>
      savedViewInputSchema.parse({
        ...live,
        configuration: {
          ...live.configuration,
          sort: { key: "not-a-column", direction: "asc" }
        }
      })
    ).toThrow();
    expect(() =>
      savedViewInputSchema.parse({
        ...live,
        configuration: {
          ...live.configuration,
          surface: "history"
        }
      })
    ).toThrow();
    expect(() => savedViewInputSchema.parse({ ...live, unexpected: true })).toThrow();
    expect(() => savedViewPatchSchema.parse({})).toThrow();
    expect(() =>
      savedViewInputSchema.parse({
        name: "Reversed insights",
        configuration: {
          surface: "insights",
          from: "2026-08-02T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
          bucket: "day",
          preset: "custom",
          sort: "reports_desc",
          compare: false,
          mapLayers: live.configuration.mapLayers,
          viewport: null
        }
      })
    ).toThrow();
  });

  it("defaults the history profile axis and pattern window so views saved before them still load", () => {
    const legacy = {
      name: "Two approaches",
      configuration: {
        surface: "history",
        filters: {
          query: "",
          icao: "",
          callsign: "",
          registration: "",
          type: "",
          operator: "",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
          alert: ""
        },
        sort: "started_desc",
        selectedSessionIds: [],
        resolution: "auto",
        replayTime: null,
        mapLayers: {
          coverage: false,
          rangeRings: true,
          aircraftLabels: true,
          trails: true,
          allTrails: false,
          manchesterWaypoints: true
        },
        viewport: null
      }
    };
    const restored = savedViewInputSchema.parse(legacy).configuration;
    expect(restored).toMatchObject({ profileAxis: "absolute" });
    // A view saved before the pattern drill-down existed carries no window,
    // which is exactly what "no weekday-hour filter" means.
    expect(restored).toMatchObject({ filters: { weekday: null, hour: null } });
    const aligned = {
      ...legacy,
      configuration: {
        ...legacy.configuration,
        filters: { ...legacy.configuration.filters, weekday: 2, hour: 14 },
        profileAxis: "aligned"
      }
    };
    expect(savedViewInputSchema.parse(aligned)).toEqual(aligned);
    expect(() =>
      savedViewInputSchema.parse({
        ...legacy,
        configuration: { ...legacy.configuration, profileAxis: "sideways" }
      })
    ).toThrow();
  });
});
