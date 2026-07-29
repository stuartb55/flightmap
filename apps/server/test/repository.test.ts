import { describe, expect, it } from "vitest";
import { hasDetailedTrackAvailable } from "../src/db/repository.js";

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
