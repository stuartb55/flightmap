import { describe, expect, it } from "vitest";
import type { LiveAircraft } from "@flightmap/shared";
import { LiveAircraftDiff } from "../src/realtime/aircraft-diff.js";

function aircraft(
  icao: string,
  overrides: Partial<LiveAircraft> = {}
): LiveAircraft {
  return {
    icao,
    recordedAt: "2026-01-01T00:00:00.000Z",
    callsign: null,
    latitude: 53,
    longitude: -2,
    altitudeBarometricFt: 10_000,
    altitudeGeometricFt: null,
    onGround: false,
    groundSpeedKt: null,
    indicatedAirSpeedKt: null,
    trueAirSpeedKt: null,
    mach: null,
    trackDeg: null,
    trackRateDegPerSec: null,
    rollDeg: null,
    magneticHeadingDeg: null,
    trueHeadingDeg: null,
    barometricRateFpm: null,
    geometricRateFpm: null,
    squawk: null,
    emergency: null,
    category: null,
    rssiDbfs: null,
    messages: 10,
    seenSeconds: 0,
    seenPositionSeconds: null,
    navigation: {
      altitudeMcpFt: null,
      altitudeFmsFt: null,
      headingDeg: null,
      qnhHpa: null,
      modes: []
    },
    quality: {
      nic: null,
      nicBaro: null,
      nacP: null,
      nacV: null,
      sil: null,
      silType: null,
      gva: null,
      sda: null,
      rcMetres: null,
      adsbVersion: null
    },
    source: "adsb",
    distanceNm: null,
    bearingDeg: null,
    sessionId: null,
    stale: false,
    watched: false,
    hasActiveAlert: false,
    firstSeenAt: null,
    metadata: null,
    ...overrides
  };
}

describe("live aircraft diffing", () => {
  it("publishes every aircraft on the first snapshot", () => {
    const diff = new LiveAircraftDiff();
    expect(diff.changed([aircraft("abc001"), aircraft("abc002")])).toHaveLength(
      2
    );
  });

  it("suppresses aircraft whose payload is unchanged", () => {
    const diff = new LiveAircraftDiff();
    diff.changed([aircraft("abc001"), aircraft("abc002")]);
    const changed = diff.changed([
      aircraft("abc001"),
      aircraft("abc002", { altitudeBarometricFt: 11_000 })
    ]);
    expect(changed.map((item) => item.icao)).toEqual(["abc002"]);
  });

  /*
   * `firstSeenAt` is static per airframe, which is the whole reason the client
   * rather than the server decides what counts as a new sighting. Anything
   * relative to now — an `isNew` flag, an age in seconds — would differ between
   * two otherwise identical ticks and push every row onto the wire each second.
   */
  it("suppresses an unchanged aircraft that carries a first-seen time", () => {
    const diff = new LiveAircraftDiff();
    const seen = { firstSeenAt: "2025-06-01T09:30:00.000Z" };
    expect(diff.changed([aircraft("abc001", seen)])).toHaveLength(1);
    expect(diff.changed([aircraft("abc001", seen)])).toEqual([]);
  });

  it("publishes an aircraft whose first-seen time has only just arrived", () => {
    const diff = new LiveAircraftDiff();
    diff.changed([aircraft("abc001")]);
    const changed = diff.changed([
      aircraft("abc001", { firstSeenAt: "2026-01-01T00:00:00.000Z" })
    ]);
    expect(changed.map((item) => item.icao)).toEqual(["abc001"]);
  });

  it("republishes an aircraft that left and returned to the feed", () => {
    const diff = new LiveAircraftDiff();
    diff.changed([aircraft("abc001")]);
    diff.changed([]);
    expect(diff.changed([aircraft("abc001")]).map((item) => item.icao)).toEqual([
      "abc001"
    ]);
  });

  it("republishes everything after a reset", () => {
    const diff = new LiveAircraftDiff();
    diff.changed([aircraft("abc001")]);
    diff.reset();
    expect(diff.changed([aircraft("abc001")])).toHaveLength(1);
  });
});
