import { describe, expect, it, vi } from "vitest";
import type { LiveWebSocketMessage } from "@flightmap/shared";
import { LiveHub } from "../src/realtime/live-hub.js";

describe("ordered live deltas", () => {
  it("assigns monotonic sequences and replays from a REST snapshot sequence", () => {
    const hub = new LiveHub(4);
    hub.publish({ removals: ["abc001"] });
    const snapshotSequence = hub.sequence();
    hub.publish({ removals: ["abc002"] });
    hub.publish({ removals: ["abc003"] });

    const messages: LiveWebSocketMessage[] = [];
    hub.subscribe((message) => messages.push(message), snapshotSequence);
    expect(messages.map((message) => message.sequence)).toEqual([2, 3]);
    expect(messages.every((message) => message.type === "delta")).toBe(true);
  });

  it("requires a resnapshot after a sequence gap outside the replay window", () => {
    const hub = new LiveHub(2);
    for (let index = 0; index < 4; index += 1) {
      hub.publish({ removals: [] });
    }
    const sink = vi.fn();
    hub.subscribe(sink, 1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resync_required", sequence: 4 }),
      expect.any(String)
    );
  });

  it("rejects a sequence from a previous process", () => {
    const hub = new LiveHub();
    const sink = vi.fn();
    hub.subscribe(sink, 50);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resync_required", sequence: 0 }),
      expect.any(String)
    );
  });

  it("bounds the replay window by aircraft payloads, not just delta count", () => {
    const hub = new LiveHub(100, 5);
    const upserts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        icao: `abc${index}`
      })) as never;
    for (let index = 0; index < 4; index += 1) {
      hub.publish({ upserts: upserts(3) });
    }
    const sink = vi.fn();
    hub.subscribe(sink, 2);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resync_required" }),
      expect.any(String)
    );
  });

  it("serialises each delta once for all subscribers", () => {
    const hub = new LiveHub();
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);
    hub.publish({ removals: ["abc001"] });
    const [, firstEncoded] = first.mock.calls.at(-1) as [unknown, string];
    const [, secondEncoded] = second.mock.calls.at(-1) as [unknown, string];
    expect(firstEncoded).toBe(secondEncoded);
    expect(JSON.parse(firstEncoded)).toMatchObject({
      type: "delta",
      removals: ["abc001"]
    });
  });
});
