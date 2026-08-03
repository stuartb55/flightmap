import {
  receiverInfoSchema,
  receiverStatsSchema,
  type ReceiverStats
} from "@flightmap/shared";
import type { Config } from "../config.js";
import type { FlightRepository } from "../db/repository.js";
import { normaliseSnapshot } from "../domain/normalise.js";
import { SnapshotCursor } from "../domain/snapshot-cursor.js";
import { LiveAircraftDiff } from "../realtime/aircraft-diff.js";
import type { LiveHub } from "../realtime/live-hub.js";
import { CollectorState } from "./collector-state.js";

type Logger = {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
  error: (object: unknown, message?: string) => void;
  debug: (object: unknown, message?: string) => void;
};

type Fetch = typeof globalThis.fetch;

function sum(values: number[] | undefined): number | null {
  if (!values || values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0);
}

function addAvailable(
  ...values: Array<number | null | undefined>
): number | null {
  const available = values.filter(
    (value): value is number => value !== null && value !== undefined
  );
  return available.length === 0
    ? null
    : available.reduce((total, value) => total + value, 0);
}

export function normaliseReceiverStats(
  stats: ReceiverStats,
  health: string,
  now = new Date()
): Parameters<FlightRepository["saveReceiverSample"]>[0] {
  const minute = stats.last1min;
  const localAccepted = sum(minute?.local?.accepted);
  const remoteAccepted = sum(minute?.remote?.accepted);
  const accepted =
    localAccepted === null && remoteAccepted === null
      ? null
      : (localAccepted ?? 0) + (remoteAccepted ?? 0);
  const messages = minute?.messages ?? accepted;
  const minuteBad = addAvailable(
    minute?.local?.bad,
    minute?.remote?.bad
  );
  const totalBad = addAvailable(
    stats.total?.local?.bad,
    stats.total?.remote?.bad
  );
  return {
    recordedAt: now,
    messageRatePerSecond: messages === undefined || messages === null
      ? null
      : messages / 60,
    acceptedMessages: accepted,
    badMessages: minuteBad ?? totalBad ?? stats.total?.bad ?? null,
    strongSignals:
      minute?.local?.strong_signals ?? stats.total?.strong_signals ?? null,
    signalDbfs: minute?.local?.signal ?? minute?.remote?.signal ?? null,
    noiseDbfs: minute?.local?.noise ?? minute?.remote?.noise ?? null,
    peakSignalDbfs: minute?.local?.peak_signal ?? null,
    cpuDemodMs: stats.total?.cpu?.demod ?? null,
    cpuReaderMs: stats.total?.cpu?.reader ?? null,
    cpuBackgroundMs: stats.total?.cpu?.background ?? null,
    health,
    raw: stats
  };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class ReceiverCollector {
  readonly state = new CollectorState();
  private readonly diff = new LiveAircraftDiff();
  private cursor = new SnapshotCursor();
  private abortController = new AbortController();
  private loops: Promise<void>[] = [];
  private started = false;
  private lastPublishedHealth = "unknown";
  private lastSessionSweepAt = 0;

  constructor(
    private readonly config: Pick<
      Config,
      | "receiverBaseUrl"
      | "pollIntervalMs"
      | "receiverInfoIntervalMs"
      | "receiverStatsIntervalMs"
      | "receiverTimeoutMs"
      | "receiverLatitude"
      | "receiverLongitude"
    >,
    private readonly repository: FlightRepository,
    private readonly hub: LiveHub,
    private readonly logger: Logger,
    private readonly fetchImplementation: Fetch = globalThis.fetch
  ) {
    this.state.setCoordinates(
      config.receiverLatitude,
      config.receiverLongitude
    );
  }

  applySettings(): void {
    this.state.setCoordinates(
      this.config.receiverLatitude,
      this.config.receiverLongitude
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    this.started = true;
    this.diff.reset();
    try {
      const [checkpoint, persistedReceiver] = await Promise.all([
        this.repository.checkpoint(),
        this.repository.receiverInfo()
      ]);
      this.cursor = new SnapshotCursor(checkpoint ?? undefined);
      if (persistedReceiver) {
        this.state.setReceiverInfo({
          latitude:
            this.config.receiverLatitude ?? persistedReceiver.latitude,
          longitude:
            this.config.receiverLongitude ?? persistedReceiver.longitude,
          version: persistedReceiver.version,
          advertisedRefreshMs: persistedReceiver.advertisedRefreshMs
        });
      }

      this.loops = [
        this.aircraftLoop(),
        this.receiverInfoLoop(),
        this.statsLoop(),
        this.healthLoop()
      ];
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async fetchJson(path: string): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.receiverTimeoutMs);
    const signal = AbortSignal.any([
      this.abortController.signal,
      timeout
    ]);
    const response = await this.fetchImplementation(
      `${this.config.receiverBaseUrl}/${path}`,
      {
        signal,
        headers: { accept: "application/json" }
      }
    );
    if (!response.ok) {
      throw new Error(`Receiver returned HTTP ${response.status} for ${path}`);
    }
    return response.json();
  }

  private async aircraftLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.abortController.signal.aborted) {
      const startedAt = Date.now();
      try {
        const payload = await this.fetchJson("aircraft.json");
        const coordinates = this.state.coordinates();
        const snapshot = normaliseSnapshot(payload, {
          receiverLatitude: coordinates.latitude,
          receiverLongitude: coordinates.longitude
        });
        const decision = this.cursor.inspect({
          recordedAt: snapshot.recordedAt,
          messages: snapshot.receiverMessages
        });
        if (!decision.accepted) {
          this.state.recordDuplicate();
          this.logger.debug(
            { reason: decision.reason, recordedAt: snapshot.recordedAt },
            "Rejected duplicate or out-of-order receiver snapshot"
          );
        } else {
          const result = await this.repository.ingestSnapshot(snapshot);
          this.cursor.commit({
            recordedAt: snapshot.recordedAt,
            messages: snapshot.receiverMessages
          });
          this.state.recordSnapshot(
            snapshot.recordedAt,
            snapshot.rejectedRecords
          );
          let removals: string[] = [];
          try {
            removals = await this.repository.removeExpiredCurrent(
              snapshot.recordedAt
            );
          } catch (error) {
            this.logger.warn(
              { error },
              "Snapshot committed but stale-aircraft cleanup failed"
            );
          }
          this.hub.publish({
            upserts: this.diff.changed(result.upserts),
            removals,
            alerts: result.alerts,
            receiver: this.state.realtime(),
            generatedAt: snapshot.recordedAt
          });
          if (decision.receiverRestarted) {
            this.logger.info(
              { recordedAt: snapshot.recordedAt },
              "Receiver message counter restarted"
            );
          }
        }
        consecutiveFailures = 0;
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        consecutiveFailures += 1;
        this.state.recordFailure(error);
        this.logger.warn(
          { error, consecutiveFailures },
          "Receiver aircraft poll failed"
        );
      }

      const elapsed = Date.now() - startedAt;
      const delay =
        consecutiveFailures === 0
          ? Math.max(0, this.config.pollIntervalMs - elapsed)
          : Math.min(
              30_000,
              this.config.pollIntervalMs *
                2 ** Math.min(consecutiveFailures - 1, 5)
            );
      await wait(delay, this.abortController.signal);
    }
  }

  private async receiverInfoLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const payload = await this.fetchJson("receiver.json");
        const parsed = receiverInfoSchema.parse(payload);
        const advertisedRefreshMs =
          parsed.refresh === undefined || parsed.refresh === null
            ? null
            : parsed.refresh < 100
              ? parsed.refresh * 1000
              : parsed.refresh;
        const receiver = {
          latitude: this.config.receiverLatitude ?? parsed.lat ?? null,
          longitude: this.config.receiverLongitude ?? parsed.lon ?? null,
          version: parsed.version ?? null,
          advertisedRefreshMs
        };
        this.state.setReceiverInfo(receiver);
        await this.repository.saveReceiverInfo(receiver);
      } catch (error) {
        if (!this.abortController.signal.aborted) {
          this.logger.warn({ error }, "Receiver metadata poll failed");
        }
      }
      await wait(
        this.config.receiverInfoIntervalMs,
        this.abortController.signal
      );
    }
  }

  private async statsLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const payload = await this.fetchJson("stats.json");
        const parsed = receiverStatsSchema.parse(payload);
        const sample = normaliseReceiverStats(
          parsed,
          this.state.health()
        );
        this.state.recordStats(sample.messageRatePerSecond);
        await this.repository.saveReceiverSample(sample);
      } catch (error) {
        if (!this.abortController.signal.aborted) {
          this.logger.warn({ error }, "Receiver statistics poll failed");
        }
      }
      await wait(
        this.config.receiverStatsIntervalMs,
        this.abortController.signal
      );
    }
  }

  private async healthLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      const health = this.state.health();
      let removals: string[] = [];
      try {
        removals = await this.repository.removeExpiredCurrent();
        if (Date.now() - this.lastSessionSweepAt >= 60_000) {
          await this.repository.closeInactiveSessions();
          this.lastSessionSweepAt = Date.now();
        }
      } catch (error) {
        this.logger.warn({ error }, "Failed to expire stale live aircraft");
      }
      if (health !== this.lastPublishedHealth || removals.length > 0) {
        this.lastPublishedHealth = health;
        this.hub.publish({
          removals,
          receiver: this.state.realtime()
        });
      }
      await wait(1000, this.abortController.signal);
    }
  }
}
