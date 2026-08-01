import { describe, expect, it } from "vitest";
import type { LiveAircraft } from "@flightmap/shared";
import {
  evaluateAlerts,
  isActiveAircraftAlert
} from "../src/domain/alerts.js";
import { calculateRangeAndBearing } from "../src/domain/geo.js";
import {
  aggregateSessionSample,
  decideSession,
  type SessionAggregate
} from "../src/domain/session.js";
import { SnapshotCursor } from "../src/domain/snapshot-cursor.js";

function aircraft(overrides: Partial<LiveAircraft> = {}): LiveAircraft {
  return {
    icao: "abc123",
    recordedAt: "2026-07-29T12:00:00.000Z",
    callsign: "TEST1",
    latitude: 53,
    longitude: -2,
    altitudeBarometricFt: 10_000,
    altitudeGeometricFt: null,
    onGround: false,
    groundSpeedKt: 200,
    indicatedAirSpeedKt: null,
    trueAirSpeedKt: null,
    mach: null,
    trackDeg: 90,
    trackRateDegPerSec: null,
    rollDeg: null,
    magneticHeadingDeg: null,
    trueHeadingDeg: null,
    barometricRateFpm: null,
    geometricRateFpm: null,
    squawk: null,
    emergency: "none",
    category: null,
    rssiDbfs: null,
    messages: null,
    seenSeconds: 0,
    seenPositionSeconds: 0,
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
    distanceNm: 12,
    bearingDeg: 180,
    sessionId: null,
    stale: false,
    watched: false,
    hasActiveAlert: false,
    metadata: null,
    ...overrides
  };
}

describe("snapshot ordering", () => {
  it("rejects duplicates and older snapshots while accepting a counter restart", () => {
    const cursor = new SnapshotCursor();
    const first = {
      recordedAt: new Date("2026-01-01T00:00:01Z"),
      messages: 100
    };
    expect(cursor.inspect(first)).toEqual({
      accepted: true,
      receiverRestarted: false
    });
    cursor.commit(first);
    expect(
      cursor.inspect({
        recordedAt: new Date("2026-01-01T00:00:01Z"),
        messages: 101
      })
    ).toEqual({ accepted: false, reason: "duplicate" });
    expect(
      cursor.inspect({
        recordedAt: new Date("2025-12-31T23:59:59Z"),
        messages: 99
      })
    ).toEqual({ accepted: false, reason: "out_of_order" });
    const restarted = {
      recordedAt: new Date("2026-01-01T00:00:02Z"),
      messages: 2
    };
    expect(cursor.inspect(restarted)).toEqual({
      accepted: true,
      receiverRestarted: true
    });
    cursor.commit(restarted);
  });
});

describe("geospatial calculations", () => {
  it("calculates nautical miles and initial bearing", () => {
    const same = calculateRangeAndBearing(53.61, -2.31, 53.61, -2.31);
    expect(same.distanceNm).toBeCloseTo(0, 8);
    const east = calculateRangeAndBearing(0, 0, 0, 1);
    expect(east.distanceNm).toBeCloseTo(60.04, 1);
    expect(east.bearingDeg).toBeCloseTo(90, 5);
  });
});

describe("track sessions", () => {
  it("continues at five minutes and starts a new session after the threshold", () => {
    const previous = {
      id: "7e850fb2-46f7-4e2b-bb9e-41f15344531d",
      lastPositionAt: new Date("2026-01-01T12:00:00Z")
    };
    expect(
      decideSession(
        aircraft(),
        new Date("2026-01-01T12:05:00Z"),
        previous,
        300
      )
    ).toEqual({ kind: "continue", sessionId: previous.id });
    expect(
      decideSession(
        aircraft(),
        new Date("2026-01-01T12:05:01Z"),
        previous,
        300
      )
    ).toEqual({ kind: "start", closeSessionId: previous.id });
    expect(
      decideSession(
        aircraft({ latitude: null, longitude: null }),
        new Date("2026-01-01T12:10:00Z"),
        previous
      )
    ).toEqual({ kind: "none" });
  });

  it("aggregates extrema and callsign changes without splitting", () => {
    const initial: SessionAggregate = {
      callsigns: ["OLD1"],
      sampleCount: 1,
      minimumAltitudeFt: 9000,
      maximumAltitudeFt: 9000,
      minimumGroundSpeedKt: 190,
      maximumGroundSpeedKt: 190,
      closestRangeNm: 15
    };
    expect(
      aggregateSessionSample(
        initial,
        aircraft({ callsign: "NEW1", distanceNm: 12 })
      )
    ).toMatchObject({
      callsigns: ["OLD1", "NEW1"],
      sampleCount: 2,
      maximumAltitudeFt: 10_000,
      maximumGroundSpeedKt: 200,
      closestRangeNm: 12
    });
  });
});

describe("alert rules", () => {
  it("does not treat an informational first sighting as an active aircraft alert", () => {
    expect(isActiveAircraftAlert("first_seen")).toBe(false);
    expect(isActiveAircraftAlert("emergency_squawk")).toBe(true);
    expect(isActiveAircraftAlert("emergency_state")).toBe(true);
    expect(isActiveAircraftAlert("watchlist")).toBe(true);
  });

  it("creates first-ever, watchlist, squawk, and state alerts with stable keys", () => {
    const alerts = evaluateAlerts(
      aircraft({ squawk: "7700", emergency: "general" }),
      {
        firstEver: true,
        watched: true,
        encounterKey: "session-1"
      }
    );
    expect(alerts.map((alert) => alert.rule)).toEqual([
      "emergency_squawk",
      "emergency_state",
      "first_seen",
      "watchlist"
    ]);
    expect(alerts.map((alert) => alert.dedupeKey)).toContain(
      "session-1:emergency_state:general"
    );
  });

  it("allows a changed emergency state but deduplicates the rule state", () => {
    const first = evaluateAlerts(aircraft({ emergency: "general" }), {
      firstEver: false,
      watched: false,
      encounterKey: "session"
    });
    const changed = evaluateAlerts(aircraft({ emergency: "lifeguard" }), {
      firstEver: false,
      watched: false,
      encounterKey: "session"
    });
    expect(first[0]?.dedupeKey).not.toBe(changed[0]?.dedupeKey);
  });
});
