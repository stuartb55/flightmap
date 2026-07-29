import type { StatusResponse } from "@flightmap/shared";
import type { Config } from "../config.js";
import type { FlightRepository } from "../db/repository.js";
import type { CollectorState } from "../ingestion/collector-state.js";
import { retentionCutoff } from "./maintenance.js";

export class StatusService {
  private readonly startedAt = new Date();
  private cached: { at: number; response: StatusResponse } | null = null;

  constructor(
    private readonly config: Pick<
      Config,
      "version" | "historyRetentionDays"
    > &
      Partial<
        Pick<
          Config,
          | "pollIntervalMs"
          | "metadataCheckIntervalMs"
          | "metadataUpdatesEnabled"
          | "maintenanceEnabled"
          | "databaseVolumeCapacityBytes"
        >
      >,
    private readonly repository: Pick<
      FlightRepository,
      "databaseStatus" | "metadataStatus" | "lastMaintenanceAt"
    >,
    private readonly collector: CollectorState
  ) {}

  async status(now = new Date()): Promise<StatusResponse> {
    if (this.cached && now.getTime() - this.cached.at < 5_000) {
      return this.cached.response;
    }
    let database = await this.repository.databaseStatus();
    let metadata: Awaited<
      ReturnType<FlightRepository["metadataStatus"]>
    > = {
      importedAt: null,
      sourceModifiedAt: null,
      version: null,
      rowCount: 0,
      lastCheckedAt: null,
      lastError: database.healthy ? null : "Database unavailable"
    };
    let lastMaintenanceAt: string | null = null;
    if (database.healthy) {
      const [metadataResult, maintenanceResult] = await Promise.allSettled([
        this.repository.metadataStatus(),
        this.repository.lastMaintenanceAt()
      ]);
      if (
        metadataResult.status === "fulfilled" &&
        maintenanceResult.status === "fulfilled"
      ) {
        metadata = metadataResult.value;
        lastMaintenanceAt = maintenanceResult.value;
      } else {
        database = {
          healthy: false,
          sizeBytes: database.sizeBytes,
          oldestSampleAt: database.oldestSampleAt,
          newestSampleAt: database.newestSampleAt
        };
        metadata = {
          ...metadata,
          lastError: "Database became unavailable during health check"
        };
      }
    }
    const receiver = this.collector.realtime(now);
    const metrics = this.collector.metrics();
    const metadataNextCheckAt = metadata.lastCheckedAt
      ? new Date(
          Date.parse(metadata.lastCheckedAt) +
            (this.config.metadataCheckIntervalMs ?? 7 * 86_400_000)
        ).toISOString()
      : null;
    const metadataStale =
      metadata.importedAt === null ||
      (this.config.metadataUpdatesEnabled !== false &&
        now.getTime() - Date.parse(metadata.importedAt) >
          (this.config.metadataCheckIntervalMs ?? 7 * 86_400_000) * 2);
    const maintenanceStale =
      this.config.maintenanceEnabled !== false &&
      (lastMaintenanceAt === null ||
        now.getTime() - Date.parse(lastMaintenanceAt) > 48 * 60 * 60 * 1000);
    const capacityBytes = this.config.databaseVolumeCapacityBytes ?? null;
    const usePercent =
      capacityBytes && database.sizeBytes != null
        ? Math.min(100, (database.sizeBytes / capacityBytes) * 100)
        : null;
    const status: StatusResponse["status"] = !database.healthy
      ? "unavailable"
      : receiver.health === "offline" ||
          receiver.health === "degraded" ||
          receiver.health === "unknown" ||
          metadata.lastError !== null ||
          metadataStale ||
          maintenanceStale ||
          (usePercent !== null && usePercent >= 90)
        ? "degraded"
        : "ok";
    const response: StatusResponse = {
      status,
      application: {
        version: this.config.version,
        startedAt: this.startedAt.toISOString(),
        uptimeSeconds: Math.max(
          0,
          (now.getTime() - this.startedAt.getTime()) / 1000
        )
      },
      receiver: {
        ...receiver,
        ...metrics,
        configuredPollIntervalMs: this.config.pollIntervalMs ?? 1_000
      },
      database: {
        ...database,
        capacityBytes,
        usePercent
      },
      retention: {
        days: this.config.historyRetentionDays,
        cutoffAt: retentionCutoff(
          now,
          this.config.historyRetentionDays
        ).toISOString(),
        lastMaintenanceAt
      },
      metadata: {
        ...metadata,
        nextCheckAt: metadataNextCheckAt
      }
    };
    this.cached = { at: now.getTime(), response };
    return response;
  }
}
