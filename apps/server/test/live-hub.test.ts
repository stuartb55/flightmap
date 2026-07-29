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
      expect.objectContaining({ type: "resync_required", sequence: 4 })
    );
  });

  it("rejects a sequence from a previous process", () => {
    const hub = new LiveHub();
    const sink = vi.fn();
    hub.subscribe(sink, 50);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resync_required", sequence: 0 })
    );
  });
});
