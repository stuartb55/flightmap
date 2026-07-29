import { describe, expect, it } from "vitest";
import { CollectorState } from "../src/ingestion/collector-state.js";

describe("collector operational metrics", () => {
  it("reports actual aircraft poll time/rate and clears the latest error", () => {
    const state = new CollectorState();
    state.recordFailure(
      new Error("receiver timeout"),
      new Date("2026-07-29T12:00:00.000Z")
    );
    expect(state.metrics()).toMatchObject({
      lastAircraftPollAt: "2026-07-29T12:00:00.000Z",
      lastError: "receiver timeout",
      failedPolls: 1
    });
    state.recordSnapshot(
      new Date(),
      2,
      new Date(Date.now() - 1_000)
    );
    state.recordSnapshot(new Date(), 0, new Date());
    expect(state.metrics().snapshotRatePerSecond).toBeCloseTo(1, 1);
    expect(state.metrics().lastError).toBeNull();
  });
});
