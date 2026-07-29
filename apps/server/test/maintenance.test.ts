import { describe, expect, it } from "vitest";
import { retentionCutoff } from "../src/services/maintenance.js";

describe("retention cutoffs", () => {
  it("uses exact UTC durations independent of the display time zone", () => {
    const now = new Date("2026-03-30T00:30:00.000Z");
    expect(retentionCutoff(now, 30).toISOString()).toBe(
      "2026-02-28T00:30:00.000Z"
    );
  });
});
