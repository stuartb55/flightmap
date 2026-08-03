import { describe, expect, it, vi } from "vitest";
import {
  MaintenanceService,
  retentionCutoff
} from "../src/services/maintenance.js";
import type { Database } from "../src/db/database.js";

type QueryHandler = (
  text: string,
  values?: unknown[]
) => { rows?: unknown[]; rowCount?: number } | undefined;

function harness(handler: QueryHandler = () => undefined) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push(text.trim());
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0, ...handler(text, values) };
    })
  };
  const database = {
    connect: async (callback: (client: unknown) => Promise<unknown>) =>
      callback(client)
  } as unknown as Database;
  const logger = { info: vi.fn(), error: vi.fn() };
  const service = new MaintenanceService(
    database,
    { historyRetentionDays: 30, sessionGapSeconds: 300 },
    logger
  );
  return { service, statements, logger, client };
}

describe("retention cutoffs", () => {
  it("uses exact UTC durations independent of the display time zone", () => {
    const now = new Date("2026-03-30T00:30:00.000Z");
    expect(retentionCutoff(now, 30).toISOString()).toBe(
      "2026-02-28T00:30:00.000Z"
    );
  });
});

describe("retention maintenance", () => {
  it("commits each step separately rather than in one long transaction", async () => {
    const { service, statements } = harness();
    await service.run(new Date("2026-03-30T00:00:00.000Z"));
    const begins = statements.filter((text) => text === "BEGIN").length;
    const commits = statements.filter((text) => text === "COMMIT").length;
    expect(begins).toBeGreaterThan(1);
    expect(commits).toBe(begins);
  });

  it("drops expired partitions before it deletes rows", async () => {
    const { service, statements } = harness((text) =>
      text.includes("pg_inherits")
        ? {
            rows: [
              { partition_name: "position_samples_20260101" },
              { partition_name: "position_samples_20260329" }
            ]
          }
        : undefined
    );
    const result = await service.run(new Date("2026-03-30T00:00:00.000Z"));
    expect(result.droppedPartitions).toBe(1);
    const dropIndex = statements.findIndex((text) => text.startsWith("DROP TABLE"));
    const deleteIndex = statements.findIndex((text) =>
      text.includes("DELETE FROM track_sessions")
    );
    expect(dropIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeLessThan(deleteIndex);
    expect(statements).toContain(`DROP TABLE IF EXISTS "position_samples_20260101"`);
  });

  it("keeps going and reports the step when a delete fails", async () => {
    const { service } = harness((text) => {
      if (text.includes("DELETE FROM track_sessions")) {
        throw new Error("statement timeout");
      }
      return undefined;
    });
    const result = await service.run(new Date("2026-03-30T00:00:00.000Z"));
    expect(result.failedSteps).toEqual(["delete_sessions"]);
    expect(result.deletedAlerts).toBe(0);
  });

  it("deletes in bounded batches until a short batch comes back", async () => {
    let remaining = 12_000;
    const { service } = harness((text) => {
      if (!text.includes("DELETE FROM alert_events")) return undefined;
      const removed = Math.min(5_000, remaining);
      remaining -= removed;
      return { rowCount: removed };
    });
    const result = await service.run(new Date("2026-03-30T00:00:00.000Z"));
    expect(result.deletedAlerts).toBe(12_000);
  });

  it("skips the run when another process holds the maintenance lock", async () => {
    const { service, client } = harness();
    client.query.mockImplementation(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: false }], rowCount: 1 };
      }
      throw new Error("no other statement should run");
    });
    const result = await service.run(new Date("2026-03-30T00:00:00.000Z"));
    expect(result.failedSteps).toEqual(["lock"]);
  });
});
