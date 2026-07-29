import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FlightRepository } from "../src/db/repository.js";
import { LiveHub } from "../src/realtime/live-hub.js";

function dependencies() {
  const receiver = {
    health: "unknown" as const,
    latitude: null,
    longitude: null,
    version: null,
    advertisedRefreshMs: null,
    lastSnapshotAt: null,
    snapshotAgeSeconds: null,
    messageRatePerSecond: null
  };
  return {
    repository: {
      sessions: vi.fn(),
      liveAircraft: vi.fn().mockResolvedValue([]),
      databaseReady: vi.fn().mockResolvedValue(true)
    },
    collector: {
      state: { realtime: () => receiver },
      applySettings: vi.fn()
    },
    hub: new LiveHub(),
    status: {
      status: vi.fn().mockResolvedValue({ database: { healthy: true } })
    },
    settings: {
      get: vi.fn().mockReturnValue({
        settings: { receiverName: "Home receiver" },
        updatedAt: null
      }),
      update: vi.fn().mockResolvedValue({
        settings: { receiverName: "Roof receiver" },
        updatedAt: "2026-07-29T12:00:00.000Z"
      })
    },
    applyRuntimeSettings: vi.fn().mockResolvedValue(undefined)
  };
}

async function app(): Promise<FastifyInstance> {
  return buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      SERVE_WEB: "false",
      COLLECTOR_ENABLED: "false",
      MAINTENANCE_ENABLED: "false",
      METADATA_UPDATES_ENABLED: "false"
    }),
    // The invalid requests below are rejected before unrelated repository
    // methods can run; minimal mocks make that boundary explicit.
    dependencies: dependencies() as never,
    logger: false
  });
}

describe("structured route errors", () => {
  it("reads and updates persisted settings", async () => {
    const deps = dependencies();
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const read = await server.inject("/api/v1/settings");
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      settings: { receiverName: "Home receiver" }
    });

    const update = await server.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { receiverName: "Roof receiver" }
    });
    expect(update.statusCode).toBe(200);
    expect(deps.settings.update).toHaveBeenCalledWith({
      receiverName: "Roof receiver"
    });
    expect(deps.applyRuntimeSettings).toHaveBeenCalled();
    await server.close();
  });

  it("uses the cheap database probe for readiness", async () => {
    const server = await app();
    const response = await server.inject("/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
    await server.close();
  });

  it("returns a stable validation error for an invalid query", async () => {
    const server = await app();
    const response = await server.inject("/api/v1/sessions?limit=999");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
    await server.close();
  });

  it("returns a stable validation error for an invalid ICAO", async () => {
    const server = await app();
    const response = await server.inject("/api/v1/aircraft/not-an-icao");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
    await server.close();
  });

  it("returns a stable parse error for malformed JSON", async () => {
    const server = await app();
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/watchlist/abc123",
      headers: { "content-type": "application/json" },
      payload: '{"label":'
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_JSON" }
    });
    await server.close();
  });
});

describe("browser authentication", () => {
  it("requires a valid access token and accepts the resulting session cookie", async () => {
    const server = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        APP_ACCESS_TOKEN: "flightmap-route-test-token",
        SERVE_WEB: "false"
      }),
      dependencies: dependencies() as never,
      logger: false
    });
    expect((await server.inject("/api/v1/status")).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { host: "localhost", origin: "http://localhost" },
          payload: { token: "wrong-token-value" }
        })
      ).statusCode
    ).toBe(401);
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { token: "flightmap-route-test-token" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"]?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    expect(
      (
        await server.inject({
          url: "/api/v1/status",
          headers: { cookie: cookie! }
        })
      ).statusCode
    ).toBe(200);
    await server.close();
  });

  it("rejects a cross-origin mutation before calling the repository", async () => {
    const server = await app();
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/watchlist/abc123",
      headers: { origin: "https://evil.example" },
      payload: {}
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "ORIGIN_NOT_ALLOWED" }
    });
    await server.close();
  });
});

describe("cursor validation", () => {
  it.each([
    ["sessions", { startedAt: "not-a-time", id: "not-a-uuid" }],
    ["summaries", { date: "2026-99-99", icao: "wrong" }],
    ["alerts", { occurredAt: "2026-01-01T00:00:00Z" }]
  ] as const)("rejects malformed %s cursor payloads before querying PostgreSQL", async (method, payload) => {
    const database = { query: vi.fn() };
    const repository = new FlightRepository(database as never, {
      sessionGapSeconds: 300,
      currentAircraftTtlSeconds: 60,
      historyRetentionDays: 30
    });
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const promise =
      method === "sessions"
        ? repository.sessions({ limit: 50, cursor })
        : method === "summaries"
          ? repository.summaries({ limit: 50, cursor })
          : repository.alerts({ limit: 50, cursor });
    await expect(promise).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(database.query).not.toHaveBeenCalled();
  });
});
