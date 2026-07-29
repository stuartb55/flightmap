import { describe, expect, it } from "vitest";
import { normaliseReceiverStats } from "../src/ingestion/collector.js";

describe("receiver statistics", () => {
  it("normalises minute message rate, RF, and CPU metrics", () => {
    const sample = normaliseReceiverStats(
      {
        last1min: {
          messages: 6000,
          local: {
            accepted: [100, 200, 300],
            bad: 3,
            signal: -19,
            noise: -31,
            peak_signal: -2,
            strong_signals: 4
          },
          remote: { accepted: [50], bad: 2 }
        },
        total: {
          local: { bad: 12, accepted: [1000, 2000, 3000] },
          remote: { bad: 2, accepted: [400] },
          cpu: { demod: 1, reader: 2, background: 3 }
        }
      },
      "online",
      new Date("2026-01-01T00:00:00Z")
    );
    expect(sample).toMatchObject({
      messageRatePerSecond: 100,
      acceptedMessages: 650,
      badMessages: 5,
      signalDbfs: -19,
      noiseDbfs: -31,
      health: "online"
    });
  });
});
