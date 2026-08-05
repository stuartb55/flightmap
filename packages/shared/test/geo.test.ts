import { describe, expect, it } from "vitest";
import { calculateRangeAndBearing } from "../src/index.js";

/*
 * Both the ingestion path and the browser place things by this function — the
 * range histogram's five-degree buckets and the coverage wedge drawn over
 * them have to agree, so it lives beside the contracts they share.
 */
describe("range and bearing from the receiver", () => {
  it("calculates nautical miles and initial bearing", () => {
    const same = calculateRangeAndBearing(53.61, -2.31, 53.61, -2.31);
    expect(same.distanceNm).toBeCloseTo(0, 8);
    const east = calculateRangeAndBearing(0, 0, 0, 1);
    expect(east.distanceNm).toBeCloseTo(60.04, 1);
    expect(east.bearingDeg).toBeCloseTo(90, 5);
  });

  it("names every quadrant in compass degrees rather than signed radians", () => {
    const from = { latitude: 53.61, longitude: -2.31 };
    const bearing = (latitude: number, longitude: number) =>
      calculateRangeAndBearing(from.latitude, from.longitude, latitude, longitude)
        .bearingDeg;

    expect(bearing(54.61, -2.31)).toBeCloseTo(0, 3);
    expect(bearing(52.61, -2.31)).toBeCloseTo(180, 3);
    /*
     * This is the *initial* bearing of a great circle, which is what an
     * aircraft heading records — due east of a point at 53°N leaves on 89.2°
     * and curves, and only the equator would give a flat 90. The east and
     * west cases are a degree either side of the cardinal for that reason,
     * and 270 rather than -90 because a negative bearing would fall outside
     * every one of the seventy-two sectors the histogram buckets into.
     */
    expect(bearing(53.61, -0.31)).toBeCloseTo(89.19, 2);
    expect(bearing(53.61, -4.31)).toBeCloseTo(270.81, 2);
  });

  it("measures across the antimeridian without wrapping the short way round", () => {
    const acrossTheLine = calculateRangeAndBearing(0, 179.5, 0, -179.5);
    expect(acrossTheLine.distanceNm).toBeCloseTo(60.04, 1);
    expect(acrossTheLine.bearingDeg).toBeCloseTo(90, 3);

    // Half the equator, the longest great-circle distance there is.
    const antipodal = calculateRangeAndBearing(0, 0, 0, 180);
    expect(antipodal.distanceNm).toBeCloseTo(10_807.3, 1);
  });
});
