import type {
  AlertEvent,
  LiveAircraft,
  LiveDelta,
  LiveWebSocketMessage,
  ReceiverRealtimeState
} from "@flightmap/shared";

export type MessageSink = (
  message: LiveWebSocketMessage,
  encoded: string
) => void;

/**
 * Keeps a bounded in-memory replay window. Sequence numbers are process-local;
 * a restart naturally forces clients whose `since` is ahead to resnapshot.
 *
 * The window is bounded by both delta count and total aircraft payloads: a
 * busy receiver can put hundreds of aircraft into every delta, so a count-only
 * bound says nothing useful about heap usage.
 */
export class LiveHub {
  private currentSequence = 0;
  private readonly history: LiveDelta[] = [];
  private historyUpserts = 0;
  private readonly sinks = new Set<MessageSink>();

  constructor(
    private readonly historyLimit = 60,
    private readonly historyUpsertLimit = 5_000
  ) {}

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
    this.historyUpserts += delta.upserts.length;
    this.trimHistory();
    const encoded = JSON.stringify(delta);
    for (const sink of this.sinks) {
      try {
        sink(delta, encoded);
      } catch {
        this.sinks.delete(sink);
      }
    }
    return delta;
  }

  subscribe(sink: MessageSink, since?: number): () => void {
    const send = (message: LiveWebSocketMessage): void => {
      sink(message, JSON.stringify(message));
    };

    if (
      since !== undefined &&
      (!Number.isSafeInteger(since) || since < 0 || since > this.currentSequence)
    ) {
      send({
        type: "resync_required",
        sequence: this.currentSequence,
        generatedAt: new Date().toISOString()
      });
      return () => undefined;
    }

    if (since === undefined) {
      send({
        type: "hello",
        sequence: this.currentSequence,
        generatedAt: new Date().toISOString()
      });
    } else if (since < this.currentSequence) {
      const oldest = this.history[0]?.sequence ?? this.currentSequence + 1;
      if (since + 1 < oldest) {
        send({
          type: "resync_required",
          sequence: this.currentSequence,
          generatedAt: new Date().toISOString()
        });
        return () => undefined;
      }
      for (const delta of this.history) {
        if (delta.sequence > since) send(delta);
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

  private trimHistory(): void {
    while (
      this.history.length > 1 &&
      (this.history.length > this.historyLimit ||
        this.historyUpserts > this.historyUpsertLimit)
    ) {
      const dropped = this.history.shift();
      this.historyUpserts -= dropped?.upserts.length ?? 0;
    }
  }
}
