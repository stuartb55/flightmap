import type {
  AlertEvent,
  LiveAircraft,
  LiveDelta,
  LiveWebSocketMessage,
  ReceiverRealtimeState
} from "@flightmap/shared";

export type MessageSink = (message: LiveWebSocketMessage) => void;

/**
 * Keeps a bounded in-memory replay window. Sequence numbers are process-local;
 * a restart naturally forces clients whose `since` is ahead to resnapshot.
 */
export class LiveHub {
  private currentSequence = 0;
  private readonly history: LiveDelta[] = [];
  private readonly sinks = new Set<MessageSink>();

  constructor(private readonly historyLimit = 512) {}

  sequence(): number {
    return this.currentSequence;
  }

  publish(input: {
    upserts?: LiveAircraft[];
    removals?: string[];
    receiver?: ReceiverRealtimeState;
    alerts?: AlertEvent[];
    generatedAt?: Date;
  }): LiveDelta {
    const delta: LiveDelta = {
      type: "delta",
      sequence: ++this.currentSequence,
      generatedAt: (input.generatedAt ?? new Date()).toISOString(),
      upserts: input.upserts ?? [],
      removals: input.removals ?? [],
      alerts: input.alerts ?? [],
      ...(input.receiver ? { receiver: input.receiver } : {})
    };
    this.history.push(delta);
    if (this.history.length > this.historyLimit) this.history.shift();
    for (const sink of this.sinks) {
      try {
        sink(delta);
      } catch {
        this.sinks.delete(sink);
      }
    }
    return delta;
  }

  subscribe(sink: MessageSink, since?: number): () => void {
    if (
      since !== undefined &&
      (!Number.isSafeInteger(since) || since < 0 || since > this.currentSequence)
    ) {
      sink({
        type: "resync_required",
        sequence: this.currentSequence,
        generatedAt: new Date().toISOString()
      });
      return () => undefined;
    }

    if (since === undefined) {
      sink({
        type: "hello",
        sequence: this.currentSequence,
        generatedAt: new Date().toISOString()
      });
    } else if (since < this.currentSequence) {
      const oldest = this.history[0]?.sequence ?? this.currentSequence + 1;
      if (since + 1 < oldest) {
        sink({
          type: "resync_required",
          sequence: this.currentSequence,
          generatedAt: new Date().toISOString()
        });
        return () => undefined;
      }
      for (const delta of this.history) {
        if (delta.sequence > since) sink(delta);
      }
    }

    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  close(): void {
    this.sinks.clear();
  }
}
