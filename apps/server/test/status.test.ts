import { describe, expect, it, vi } from "vitest";
import { CollectorState } from "../src/ingestion/collector-state.js";
import { StatusService } from "../src/services/status.js";

const config = { version: "test", historyRetentionDays: 30 };

describe("system status resilience", () => {
  it("degrades when required metadata or maintenance has never completed", async () => {
    const service = new StatusService(
      {
        ...config,
        maintenanceEnabled: true,
        metadataUpdatesEnabled: true,
        metadataCheckIntervalMs: 60_000
      },
      {
        databaseStatus: vi.fn().mockResolvedValue({
          healthy: true,
          sizeBytes: 1,
          oldestSampleAt: null,
          newestSampleAt: null
        }),
        metadataStatus: vi.fn().mockResolvedValue({
          importedAt: null,
          sourceModifiedAt: null,
          version: null,
          rowCount: 0,
          lastCheckedAt: null,
          lastError: null
        }),
        lastMaintenanceAt: vi.fn().mockResolvedValue(null)
      },
      new CollectorState()
    );
    expect((await service.status()).status).toBe("degraded");
  });

  it("returns unavailable without making follow-up queries when the database is down", async () => {
    const repository = {
      databaseStatus: vi.fn().mockResolvedValue({
        healthy: false,
        sizeBytes: null,
        oldestSampleAt: null,
        newestSampleAt: null
      }),
      metadataStatus: vi.fn().mockRejectedValue(new Error("offline")),
      lastMaintenanceAt: vi.fn().mockRejectedValue(new Error("offline"))
    };
    const service = new StatusService(
      config,
      repository,
      new CollectorState()
    );
    const result = await service.status(
      new Date("2026-07-29T12:00:00.000Z")
    );
    expect(result.status).toBe("unavailable");
    expect(result.metadata.lastError).toBe("Database unavailable");
    expect(repository.metadataStatus).not.toHaveBeenCalled();
    expect(repository.lastMaintenanceAt).not.toHaveBeenCalled();
  });

  it("degrades safely if the database fails between status queries", async () => {
    const service = new StatusService(
      config,
      {
        databaseStatus: vi.fn().mockResolvedValue({
          healthy: true,
          sizeBytes: 1,
          oldestSampleAt: null,
          newestSampleAt: null
        }),
        metadataStatus: vi.fn().mockRejectedValue(new Error("connection lost")),
        lastMaintenanceAt: vi.fn().mockResolvedValue(null)
      },
      new CollectorState()
    );
    expect((await service.status()).status).toBe("unavailable");
  });
});
