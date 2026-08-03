import { describe, expect, it } from "vitest";
import {
  icaoSchema,
  dismissAlertsInputSchema,
  customAlertRuleInputSchema,
  customAlertRulePatchSchema,
  insightCoverageQuerySchema,
  insightQuerySchema,
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
          manchesterWaypoints: true
        },
        viewport: null
      }
    };
    expect(savedViewInputSchema.parse(live)).toEqual(live);
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
});
