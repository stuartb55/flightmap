import { describe, expect, it } from "vitest";
import {
  analyticalAltitudeFt,
  type AltitudeReport,
  type PreviousAltitudeReport
} from "../src/domain/altitude.js";

function report(
  overrides: Partial<AltitudeReport> = {}
): AltitudeReport {
  return {
    recordedAt: "2026-08-01T12:00:01.000Z",
    altitudeBarometricFt: 35_000,
    altitudeGeometricFt: 35_500,
    barometricRateFpm: 0,
    geometricRateFpm: 0,
    navigation: { altitudeMcpFt: 35_000, altitudeFmsFt: null },
    ...overrides
  };
}

function previous(
  overrides: Partial<PreviousAltitudeReport> = {}
): PreviousAltitudeReport {
  return {
    ...report({ recordedAt: "2026-08-01T12:00:00.000Z" }),
    analyticalAltitudeFt: 35_000,
    ...overrides
  };
}

describe("analytical altitude validation", () => {
  it("accepts an ordinary first report", () => {
    expect(analyticalAltitudeFt(report(), null)).toBe(35_000);
  });

  it("rejects an isolated altitude jump", () => {
    expect(
      analyticalAltitudeFt(
        report({
          altitudeBarometricFt: 59_000,
          altitudeGeometricFt: 59_400,
          navigation: { altitudeMcpFt: 35_000, altitudeFmsFt: null }
        }),
        previous()
      )
    ).toBeNull();
  });

  it("does not impose a hard ceiling on corroborated high-altitude reports", () => {
    expect(
      analyticalAltitudeFt(
        report({
          altitudeBarometricFt: 72_000,
          altitudeGeometricFt: 72_600,
          navigation: { altitudeMcpFt: 72_000, altitudeFmsFt: null }
        }),
        previous({
          altitudeBarometricFt: 71_900,
          altitudeGeometricFt: 72_500,
          analyticalAltitudeFt: null
        })
      )
    ).toBe(72_000);
  });

  it("rejects uncorroborated or navigation-contradicting extreme reports", () => {
    expect(
      analyticalAltitudeFt(
        report({
          altitudeBarometricFt: 116_600,
          altitudeGeometricFt: null,
          navigation: { altitudeMcpFt: 39_000, altitudeFmsFt: null }
        }),
        previous()
      )
    ).toBeNull();
    expect(
      analyticalAltitudeFt(
        report({
          altitudeBarometricFt: 116_600,
          altitudeGeometricFt: 117_000,
          navigation: { altitudeMcpFt: 39_000, altitudeFmsFt: null }
        }),
        previous({
          altitudeBarometricFt: 116_500,
          altitudeGeometricFt: 116_900,
          analyticalAltitudeFt: null
        })
      )
    ).toBeNull();
  });

  it("rejects barometric and geometric sources that disagree", () => {
    expect(
      analyticalAltitudeFt(
        report({
          altitudeBarometricFt: 116_600,
          altitudeGeometricFt: 40_000
        }),
        previous()
      )
    ).toBeNull();
  });
});
