import { describe, expect, it } from "vitest";
import { airlineOperatorFromCallsign } from "../src/index.js";

describe("airline operator callsign inference", () => {
  it("maps valid known ICAO airline callsigns", () => {
    expect(airlineOperatorFromCallsign(" EZY42KD ")).toEqual({
      designator: "EZY",
      operator: "easyJet"
    });
    expect(airlineOperatorFromCallsign("baw123")).toEqual({
      designator: "BAW",
      operator: "British Airways"
    });
  });

  it("does not infer operators from registrations or invalid callsigns", () => {
    expect(airlineOperatorFromCallsign("G-TEST")).toBeNull();
    expect(airlineOperatorFromCallsign("XYZ123")).toBeNull();
    expect(airlineOperatorFromCallsign("EZYABC")).toBeNull();
    expect(airlineOperatorFromCallsign(null)).toBeNull();
  });
});
