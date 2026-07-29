import { describe, expect, it, vi } from "vitest";
import {
  ReceiverCollector,
  normaliseReceiverStats
} from "../src/ingestion/collector.js";
import { LiveHub } from "../src/realtime/live-hub.js";

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

  it("can retry startup after repository initialization fails", async () => {
    const repository = {
      checkpoint: vi.fn().mockRejectedValue(new Error("database unavailable")),
      receiverInfo: vi.fn().mockResolvedValue(null)
    };
    const collector = new ReceiverCollector(
      {
        receiverBaseUrl: "http://receiver.local/data",
        pollIntervalMs: 1_000,
        receiverInfoIntervalMs: 300_000,
        receiverStatsIntervalMs: 60_000,
        receiverTimeoutMs: 800,
        receiverLatitude: null,
        receiverLongitude: null
      },
      repository as never,
      new LiveHub(),
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      }
    );

    await expect(collector.start()).rejects.toThrow("database unavailable");
    await expect(collector.start()).rejects.toThrow("database unavailable");
    expect(repository.checkpoint).toHaveBeenCalledTimes(2);
  });
});
