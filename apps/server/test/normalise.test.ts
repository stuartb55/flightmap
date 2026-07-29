import { describe, expect, it } from "vitest";
import {
  normaliseAircraft,
  normaliseSnapshot,
  SnapshotValidationError
} from "../src/domain/normalise.js";

const at = new Date("2026-07-29T12:34:56.000Z");

describe("receiver aircraft normalisation", () => {
  it("normalises a full ADS-B record and calculates receiver-relative values", () => {
    const aircraft = normaliseAircraft(
      {
        hex: "ABC123",
        flight: " EZY123 ",
        lat: 53.7,
        lon: -2.2,
        alt_baro: 12_000,
        alt_geom: 12_250,
        gs: 320,
        ias: 280,
        tas: 330,
        mach: 0.61,
        track: 91,
        mag_heading: 89,
        true_heading: 90,
        baro_rate: 640,
        squawk: "0421",
        emergency: "none",
        category: "A3",
        rssi: -18.4,
        messages: 42,
        seen: 0.2,
        seen_pos: 0.4,
        nav_altitude_mcp: 15_000,
        nav_qnh: 1013.2,
        nic: 8,
        nac_p: 9,
        sil: 3,
        type: "adsb_icao"
      },
      at,
      { receiverLatitude: 53.61, receiverLongitude: -2.31 }
    );

    expect(aircraft).toMatchObject({
      icao: "abc123",
      recordedAt: "2026-07-29T12:34:56.000Z",
      callsign: "EZY123",
      altitudeBarometricFt: 12_000,
      source: "adsb",
      squawk: "0421",
      stale: false
    });
    expect(aircraft.distanceNm).toBeGreaterThan(6);
    expect(aircraft.bearingDeg).toBeGreaterThan(0);
  });

  it.each([
    {
      name: "sparse",
      record: { hex: "000001" },
      expected: {
        latitude: null,
        longitude: null,
        source: "unknown"
      }
    },
    {
      name: "MLAT",
      record: {
        hex: "000002",
        lat: 53,
        lon: -2,
        type: "mlat",
        mlat: ["lat", "lon"]
      },
      expected: { source: "mlat" }
    },
    {
      name: "stale",
      record: { hex: "000003", seen: 18 },
      expected: { stale: true }
    },
    {
      name: "ground",
      record: { hex: "000004", alt_baro: "ground" },
      expected: { onGround: true, altitudeBarometricFt: null }
    }
  ])("handles $name records", ({ record, expected }) => {
    expect(
      normaliseAircraft(record, at, {
        receiverLatitude: null,
        receiverLongitude: null
      })
    ).toMatchObject(expected);
  });

  it("rejects only malformed records and preserves valid unknown-field records", () => {
    const snapshot = normaliseSnapshot(
      {
        now: 1_775_000_000,
        messages: 100,
        aircraft: [
          { hex: "abc001", future: "accepted" },
          { hex: "bad" },
          { hex: "abc002", lat: 91, lon: 0 },
          { hex: "abc003", lat: 53.5 }
        ]
      },
      { receiverLatitude: null, receiverLongitude: null }
    );
    expect(snapshot.aircraft.map((item) => item.icao)).toEqual([
      "abc001",
      "abc003"
    ]);
    expect(snapshot.rejectedRecords).toBe(2);
    expect(snapshot.aircraft[1]?.longitude).toBeNull();
  });

  it("accepts explicit nulls in ground and MLAT receiver records", () => {
    const snapshot = normaliseSnapshot(
      {
        now: 1_775_000_001,
        messages: 101,
        aircraft: [
          {
            hex: "400002",
            type: "mlat",
            flight: "GROUND1 ",
            lat: 53.61,
            lon: -2.31,
            alt_baro: "ground",
            alt_geom: null,
            gs: 14.2,
            ias: null,
            tas: null,
            mach: null,
            track: 91.5,
            track_rate: null,
            roll: null,
            mag_heading: null,
            true_heading: null,
            baro_rate: null,
            geom_rate: null,
            squawk: null,
            emergency: null,
            category: null,
            rssi: null,
            messages: null,
            seen: 0.4,
            seen_pos: 0.5,
            nav_altitude_mcp: null,
            nav_altitude_fms: null,
            nav_heading: null,
            nav_qnh: null,
            nav_modes: null,
            nic: null,
            nic_baro: null,
            nac_p: null,
            nac_v: null,
            sil: null,
            sil_type: null,
            gva: null,
            sda: null,
            rc: null,
            version: null,
            mlat: ["lat", "lon", "track", "gs"],
            tisb: null
          }
        ]
      },
      { receiverLatitude: 53.61, receiverLongitude: -2.31 }
    );
    expect(snapshot.rejectedRecords).toBe(0);
    expect(snapshot.aircraft[0]).toMatchObject({
      icao: "400002",
      source: "mlat",
      onGround: true,
      altitudeBarometricFt: null,
      altitudeGeometricFt: null,
      barometricRateFpm: null,
      geometricRateFpm: null
    });
  });

  it("rejects a malformed snapshot without terminating record parsing code", () => {
    expect(() =>
      normaliseSnapshot(
        { now: "yesterday", messages: 1, aircraft: [] },
        { receiverLatitude: null, receiverLongitude: null }
      )
    ).toThrow(SnapshotValidationError);
  });
});
