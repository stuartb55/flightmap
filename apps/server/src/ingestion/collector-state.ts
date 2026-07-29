import type {
  ReceiverHealth,
  ReceiverRealtimeState
} from "./collector-types.js";

export type CollectorMetrics = {
  lastAircraftPollAt: string | null;
  lastReceiverPollAt: string | null;
  lastStatsPollAt: string | null;
  snapshotRatePerSecond: number | null;
  lastError: string | null;
  rejectedRecords: number;
  acceptedSnapshots: number;
  duplicateSnapshots: number;
  failedPolls: number;
};

export class CollectorState {
  private lastSnapshot: Date | null = null;
  private lastAircraftPoll: Date | null = null;
  private lastReceiverPoll: Date | null = null;
  private lastStatsPoll: Date | null = null;
  private receiverLatitude: number | null = null;
  private receiverLongitude: number | null = null;
  private receiverVersion: string | null = null;
  private advertisedRefreshMs: number | null = null;
  private messageRatePerSecond: number | null = null;
  private rejectedRecords = 0;
  private acceptedSnapshots = 0;
  private duplicateSnapshots = 0;
  private failedPolls = 0;
  private lastError: string | null = null;
  private snapshotTimes: number[] = [];

  setReceiverInfo(info: {
    latitude: number | null;
    longitude: number | null;
    version: string | null;
    advertisedRefreshMs: number | null;
  }): void {
    this.receiverLatitude = info.latitude ?? this.receiverLatitude;
    this.receiverLongitude = info.longitude ?? this.receiverLongitude;
    this.receiverVersion = info.version ?? this.receiverVersion;
    this.advertisedRefreshMs =
      info.advertisedRefreshMs ?? this.advertisedRefreshMs;
    this.lastReceiverPoll = new Date();
  }

  setCoordinates(latitude: number | null, longitude: number | null): void {
    this.receiverLatitude = latitude;
    this.receiverLongitude = longitude;
  }

  coordinates(): { latitude: number | null; longitude: number | null } {
    return {
      latitude: this.receiverLatitude,
      longitude: this.receiverLongitude
    };
  }

  recordSnapshot(
    recordedAt: Date,
    rejectedRecords: number,
    observedAt = new Date()
  ): void {
    this.lastSnapshot = recordedAt;
    this.lastAircraftPoll = observedAt;
    this.lastError = null;
    this.snapshotTimes.push(observedAt.getTime());
    this.pruneSnapshotTimes(observedAt.getTime());
    this.acceptedSnapshots += 1;
    this.rejectedRecords += rejectedRecords;
  }

  recordDuplicate(observedAt = new Date()): void {
    this.lastAircraftPoll = observedAt;
    this.lastError = null;
    this.duplicateSnapshots += 1;
  }

  recordFailure(error?: unknown, observedAt = new Date()): void {
    this.lastAircraftPoll = observedAt;
    this.lastError =
      error instanceof Error
        ? error.message
        : error == null
          ? "Receiver aircraft poll failed"
          : String(error);
    this.failedPolls += 1;
  }

  recordStats(messageRatePerSecond: number | null): void {
    this.messageRatePerSecond = messageRatePerSecond;
    this.lastStatsPoll = new Date();
  }

  health(now = new Date()): ReceiverHealth {
    if (!this.lastSnapshot) return "unknown";
    const ageSeconds =
      (now.getTime() - this.lastSnapshot.getTime()) / 1000;
    if (ageSeconds >= 15) return "offline";
    if (ageSeconds >= 5) return "degraded";
    return "online";
  }

  realtime(now = new Date()): ReceiverRealtimeState {
    const snapshotAgeSeconds = this.lastSnapshot
      ? Math.max(0, (now.getTime() - this.lastSnapshot.getTime()) / 1000)
      : null;
    return {
      health: this.health(now),
      latitude: this.receiverLatitude,
      longitude: this.receiverLongitude,
      version: this.receiverVersion,
      advertisedRefreshMs: this.advertisedRefreshMs,
      lastSnapshotAt: this.lastSnapshot?.toISOString() ?? null,
      snapshotAgeSeconds,
      messageRatePerSecond: this.messageRatePerSecond
    };
  }

  metrics(): CollectorMetrics {
    this.pruneSnapshotTimes(Date.now());
    const snapshotRatePerSecond =
      this.snapshotTimes.length < 2
        ? null
        : (this.snapshotTimes.length - 1) /
          ((this.snapshotTimes.at(-1)! - this.snapshotTimes[0]!) / 1000);
    return {
      lastAircraftPollAt: this.lastAircraftPoll?.toISOString() ?? null,
      lastReceiverPollAt: this.lastReceiverPoll?.toISOString() ?? null,
      lastStatsPollAt: this.lastStatsPoll?.toISOString() ?? null,
      snapshotRatePerSecond:
        snapshotRatePerSecond != null && Number.isFinite(snapshotRatePerSecond)
          ? snapshotRatePerSecond
          : null,
      lastError: this.lastError,
      rejectedRecords: this.rejectedRecords,
      acceptedSnapshots: this.acceptedSnapshots,
      duplicateSnapshots: this.duplicateSnapshots,
      failedPolls: this.failedPolls
    };
  }

  private pruneSnapshotTimes(now: number): void {
    const cutoff = now - 60_000;
    this.snapshotTimes = this.snapshotTimes.filter((time) => time >= cutoff);
  }
}
