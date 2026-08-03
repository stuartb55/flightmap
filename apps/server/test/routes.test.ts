import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { buildApp, validationErrorMessage } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  FlightRepository,
  RepositoryInputError
} from "../src/db/repository.js";
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
      insightsOverview: vi.fn().mockResolvedValue({}),
      insightsCoverage: vi.fn().mockResolvedValue({}),
      insightPatterns: vi.fn().mockResolvedValue({}),
      rangeProfile: vi.fn().mockResolvedValue({}),
      coverageCellDetail: vi.fn().mockResolvedValue({}),
      aircraftActivity: vi.fn().mockResolvedValue({}),
      customAlertRules: vi.fn().mockResolvedValue([]),
      previewCustomAlertRule: vi.fn().mockResolvedValue({ matches: [] }),
      createCustomAlertRule: vi.fn(),
      updateCustomAlertRule: vi.fn(),
      deleteCustomAlertRule: vi.fn(),
      savedViews: vi.fn().mockResolvedValue([]),
      createSavedView: vi.fn(),
      updateSavedView: vi.fn(),
      deleteSavedView: vi.fn(),
      track: vi.fn(),
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
  it("turns root and empty validation issues into readable messages", () => {
    expect(validationErrorMessage(new ZodError([]))).toBe(
      "The request was invalid"
    );
    const result = z.string().min(2).safeParse("");
    if (result.success) throw new Error("Expected validation to fail");
    expect(validationErrorMessage(result.error)).toContain(
      "The request was invalid:"
    );
  });

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

  it("reports not_ready until boot-time settings have loaded", async () => {
    const deps = dependencies();
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: { ...deps, bootstrapped: () => false } as never,
      logger: false
    });
    const response = await server.inject("/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready" });
    await server.close();
  });

  it("returns a stable validation error for an invalid query", async () => {
    const server = await app();
    const response = await server.inject("/api/v1/sessions?limit=999");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: expect.stringContaining("limit") }
    });
    await server.close();
  });

  it("preserves safe repository input error codes", async () => {
    const deps = dependencies();
    deps.repository.sessions.mockRejectedValue(
      new RepositoryInputError("INVALID_CURSOR", "The cursor is invalid")
    );
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const response = await server.inject("/api/v1/sessions");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "INVALID_CURSOR", message: "The cursor is invalid" }
    });
    await server.close();
  });

  it("validates insight date ordering before querying aggregates", async () => {
    const deps = dependencies();
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const response = await server.inject(
      "/api/v1/insights/overview?from=2026-08-02T00%3A00%3A00Z&to=2026-08-01T00%3A00%3A00Z&bucket=day"
    );
    expect(response.statusCode).toBe(400);
    expect(deps.repository.insightsOverview).not.toHaveBeenCalled();
    await server.close();
  });

  it("validates saved views before persistence", async () => {
    const deps = dependencies();
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/saved-views",
      payload: {
        name: "Broken view",
        configuration: { surface: "live", filters: {} }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(deps.repository.createSavedView).not.toHaveBeenCalled();
    await server.close();
  });

  it("validates and previews custom alert rules without persisting them", async () => {
    const deps = dependencies();
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const invalid = await server.inject({
      method: "POST",
      url: "/api/v1/alerts/rules/preview",
      payload: { name: "No predicate" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(deps.repository.previewCustomAlertRule).not.toHaveBeenCalled();

    const valid = await server.inject({
      method: "POST",
      url: "/api/v1/alerts/rules/preview",
      payload: { name: "Nearby", maximumDistanceNm: 20 }
    });
    expect(valid.statusCode).toBe(200);
    expect(deps.repository.previewCustomAlertRule).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Nearby", maximumDistanceNm: 20 })
    );
    await server.close();
  });

  it("returns bounded session exports with download and truncation headers", async () => {
    const deps = dependencies();
    deps.repository.track.mockResolvedValue({
      session: {
        id: "9b7dc991-58bf-4c42-b033-40c637d3f09a",
        icao: "abc123",
        callsigns: ["TEST1"],
        startedAt: "2026-08-01T10:00:00.000Z",
        endedAt: "2026-08-01T10:01:00.000Z",
        metadata: null
      },
      resolution: "5s",
      truncated: true,
      points: [{
        recordedAt: "2026-08-01T10:00:00.000Z",
        latitude: 53.6,
        longitude: -2.3,
        altitudeBarometricFt: 1000,
        groundSpeedKt: 100,
        trackDeg: 90
      }]
    });
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const response = await server.inject(
      "/api/v1/exports/sessions/9b7dc991-58bf-4c42-b033-40c637d3f09a?format=csv&resolution=5s"
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(
      "flightmap-session-9b7dc991-58bf-4c42-b033-40c637d3f09a.csv"
    );
    expect(response.headers["x-flightmap-truncated"]).toBe("true");
    expect(response.body).toContain("recorded_at_utc,icao,session_id");
    expect(deps.repository.track).toHaveBeenCalledWith(
      "9b7dc991-58bf-4c42-b033-40c637d3f09a",
      "5s",
      { tail: false, limit: 20_000 }
    );
    await server.close();
  });

  it("exports session tracks as GeoJSON and returns not found consistently", async () => {
    const deps = dependencies();
    deps.repository.track
      .mockResolvedValueOnce({
        session: {
          id: "9b7dc991-58bf-4c42-b033-40c637d3f09a",
          icao: "abc123",
          callsigns: [],
          startedAt: "2026-08-01T10:00:00.000Z",
          endedAt: null,
          metadata: null
        },
        resolution: "auto",
        truncated: false,
        points: []
      })
      .mockResolvedValueOnce(null);
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const id = "9b7dc991-58bf-4c42-b033-40c637d3f09a";
    const exported = await server.inject(
      `/api/v1/exports/sessions/${id}?format=geojson`
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/geo+json");
    expect(exported.json()).toMatchObject({
      type: "FeatureCollection",
      features: [{ geometry: null }]
    });

    const missing = await server.inject(`/api/v1/exports/sessions/${id}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "SESSION_NOT_FOUND" }
    });
    await server.close();
  });

  it("exports insight series and coverage using the interactive query filters", async () => {
    const deps = dependencies();
    deps.repository.insightsOverview.mockResolvedValue({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      bucket: "day",
      metrics: {
        uniqueAircraft: 1,
        sessions: 1,
        reports: 2,
        positionedReports: 2,
        maximumRangeNm: 30,
        maximumAltitudeFt: 10_000
      },
      series: [],
      aircraftLeaders: [],
      typeLeaders: [],
      operatorLeaders: [],
      availability: {}
    });
    deps.repository.insightsCoverage.mockResolvedValue({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      cells: [],
      truncated: true,
      availability: {}
    });
    const server = await buildApp({
      config: loadConfig({ NODE_ENV: "test", SERVE_WEB: "false" }),
      dependencies: deps as never,
      logger: false
    });
    const range = "from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z";
    const insights = await server.inject(
      `/api/v1/exports/insights?${range}&bucket=day&compare=true`
    );
    expect(insights.statusCode).toBe(200);
    expect(insights.headers["content-disposition"]).toContain(
      "flightmap-insights-2026-08-01T00-00-00-000Z.csv"
    );
    expect(deps.repository.insightsOverview).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "day", compare: true })
    );

    const coverage = await server.inject(`/api/v1/exports/coverage?${range}`);
    expect(coverage.statusCode).toBe(200);
    expect(coverage.headers["x-flightmap-truncated"]).toBe("true");
    expect(coverage.json()).toMatchObject({ type: "FeatureCollection" });
    expect(deps.repository.insightsCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z"
      })
    );
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

describe("request security", () => {
  it("serves the API without authentication and exposes no login route", async () => {
    const server = await app();
    expect((await server.inject("/api/v1/status")).statusCode).toBe(200);
    expect((await server.inject("/api/v1/auth/session")).statusCode).toBe(404);
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

describe("web application delivery", () => {
  it("revalidates PWA metadata while keeping fingerprinted assets immutable", async () => {
    const webDirectory = await mkdtemp(join(tmpdir(), "flightmap-web-"));
    await Promise.all([
      writeFile(join(webDirectory, "index.html"), "<html><head></head><body></body></html>"),
      writeFile(join(webDirectory, "sw.js"), "// service worker"),
      writeFile(join(webDirectory, "manifest.webmanifest"), "{}"),
      writeFile(join(webDirectory, "app-abc123.js"), "// fingerprinted asset")
    ]);

    const server = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        SERVE_WEB: "true",
        WEB_DIST_DIR: webDirectory
      }),
      dependencies: dependencies() as never,
      logger: false
    });

    try {
      const worker = await server.inject("/sw.js");
      const manifest = await server.inject("/manifest.webmanifest");
      const asset = await server.inject("/app-abc123.js");

      expect(worker.headers["cache-control"]).toBe("no-cache");
      expect(manifest.headers["cache-control"]).toBe("no-cache");
      expect(asset.headers["cache-control"]).toContain("max-age=31536000");
      expect(asset.headers["cache-control"]).toContain("immutable");
    } finally {
      await server.close();
      await rm(webDirectory, { recursive: true, force: true });
    }
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
