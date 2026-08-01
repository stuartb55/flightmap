import { describe, expect, it } from "vitest";
import type {
  InsightCoverageResponse,
  InsightOverview,
  TrackResponse
} from "@flightmap/shared";
import {
  coverageGeoJson,
  csvCell,
  exportDateToken,
  insightSeriesCsv,
  sessionTelemetryCsv,
  sessionTrackGeoJson
} from "../src/domain/exports.js";

const track: TrackResponse = {
  session: {
    id: "9b7dc991-58bf-4c42-b033-40c637d3f09a",
    icao: "abc123",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: "2026-08-01T10:01:00.000Z",
    lastPositionAt: "2026-08-01T10:01:00.000Z",
    callsigns: ["=TEST,1"],
    sampleCount: 2,
    minimumAltitudeFt: 1000,
    maximumAltitudeFt: 2000,
    minimumGroundSpeedKt: 100,
    maximumGroundSpeedKt: 120,
    closestRangeNm: 5,
    lastLatitude: 53.6,
    lastLongitude: -2.3,
    lastAltitudeFt: 2000,
    detailedTrackAvailable: true,
    alertRules: []
  },
  resolution: "1s",
  truncated: false,
  points: [
    {
      recordedAt: "2026-08-01T10:00:00.000Z",
      latitude: 53.6,
      longitude: -2.3,
      altitudeBarometricFt: 1000,
      altitudeGeometricFt: 1050,
      onGround: false,
      groundSpeedKt: 100,
      trackDeg: 90,
      verticalRateFpm: 500,
      distanceNm: 5,
      bearingDeg: 180
    },
    {
      recordedAt: "2026-08-01T10:01:00.000Z",
      latitude: 53.61,
      longitude: -2.29,
      altitudeBarometricFt: 2000,
      altitudeGeometricFt: 2050,
      onGround: false,
      groundSpeedKt: 120,
      trackDeg: 95,
      verticalRateFpm: 600,
      distanceNm: 6,
      bearingDeg: 181
    }
  ]
};

describe("bounded export formatting", () => {
  it("escapes CSV delimiters, quotes, newlines, and spreadsheet formulas", () => {
    expect(csvCell('value,"quoted"\nnext')).toBe('"value,""quoted""\nnext"');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell(" safe ")).toBe('" safe "');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(exportDateToken("2026-08-01T10:11:12.345Z")).toBe(
      "2026-08-01T10-11-12-345Z"
    );
  });

  it("emits stable UTC session telemetry columns", () => {
    const csv = sessionTelemetryCsv(track);
    expect(csv.split("\r\n")[0]).toBe(
      "recorded_at_utc,icao,session_id,callsign,latitude,longitude,altitude_ft,ground_speed_kt,track_degrees"
    );
    expect(csv).toContain("2026-08-01T10:00:00.000Z");
    expect(csv).toContain('"\'=TEST,1"');
  });

  it("creates a GeoJSON track with bounded exported point metadata", () => {
    expect(sessionTrackGeoJson(track)).toMatchObject({
      type: "FeatureCollection",
      features: [
        {
          properties: { point_count: 2, truncated: false },
          geometry: { type: "LineString" }
        }
      ]
    });

    expect(
      sessionTrackGeoJson({
        ...track,
        points: [{ ...track.points[0], altitudeBarometricFt: null }]
      })
    ).toMatchObject({
      features: [{ geometry: { type: "Point" } }]
    });
    expect(sessionTrackGeoJson({ ...track, points: [] })).toMatchObject({
      features: [{ geometry: null }]
    });
  });

  it("exports insight series and coverage cells with stable analytical fields", () => {
    const overview = {
      from: "2026-08-01T10:00:00.000Z",
      to: "2026-08-01T11:00:00.000Z",
      bucket: "hour",
      series: [
        {
          bucketStart: "2026-08-01T10:00:00.000Z",
          bucketEnd: "2026-08-01T11:00:00.000Z",
          uniqueAircraft: 2,
          sessions: 2,
          reports: 100,
          positionedReports: 90,
          maximumRangeNm: 50,
          maximumAltitudeFt: 30000,
          messageRatePerSecond: 120,
          receiverAvailabilityPercent: 98,
          rejectedRecords: 1,
          dataGapMinutes: 2
        }
      ]
    } as InsightOverview;
    expect(insightSeriesCsv(overview)).toContain(
      "2026-08-01T10:00:00.000Z,2026-08-01T11:00:00.000Z,2,2,100,90,50,30000,120,98,1,2"
    );

    const coverage = {
      from: overview.from,
      to: overview.to,
      cells: [{ south: 53.6, west: -2.3, north: 53.65, east: -2.25, reports: 20, uniqueAircraft: 3, maximumAltitudeFt: 20000 }],
      truncated: false
    } as InsightCoverageResponse;
    expect(coverageGeoJson(coverage)).toMatchObject({
      type: "FeatureCollection",
      features: [{ geometry: { type: "Polygon" }, properties: { reports: 20 } }]
    });
  });
});
