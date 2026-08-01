import {
  alertQuerySchema,
  dismissAlertsInputSchema,
  icaoSchema,
  insightCoverageQuerySchema,
  insightQuerySchema,
  sessionQuerySchema,
  summaryQuerySchema,
  trackQuerySchema,
  watchlistInputSchema
} from "@flightmap/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FlightRepository } from "../db/repository.js";
import type { ReceiverCollector } from "../ingestion/collector.js";
import type { LiveHub } from "../realtime/live-hub.js";
import type { StatusService } from "../services/status.js";
import type { AppSettingsService } from "../settings.js";

const uuidParamsSchema = z.object({ id: z.string().uuid() });
const icaoParamsSchema = z.object({ icao: icaoSchema });

export type ApiDependencies = {
  repository: FlightRepository;
  collector: ReceiverCollector;
  hub: LiveHub;
  status: StatusService;
  settings: AppSettingsService;
  applyRuntimeSettings: () => Promise<void>;
};

export async function registerApiRoutes(
  app: FastifyInstance,
  dependencies: ApiDependencies
): Promise<void> {
  const {
    repository,
    collector,
    hub,
    status,
    settings,
    applyRuntimeSettings
  } = dependencies;

  app.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString()
  }));

  app.get("/health/ready", async (_request, reply) => {
    const ready = await repository.databaseReady();
    if (!ready) reply.code(503);
    return {
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString()
    };
  });

  app.get("/api/v1/status", async () => status.status());

  app.get("/api/v1/settings", async () => settings.get());

  app.patch("/api/v1/settings", async (request) => {
    const response = await settings.update(request.body ?? {});
    await applyRuntimeSettings();
    return response;
  });

  app.get("/api/v1/aircraft/live", async () => {
    // Capturing before the DB read can cause a harmless replayed upsert, but
    // cannot cause a client to miss a delta committed during the read.
    const sequence = hub.sequence();
    const aircraft = await repository.liveAircraft();
    return {
      sequence,
      generatedAt: new Date().toISOString(),
      receiver: collector.state.realtime(),
      aircraft
    };
  });

  app.get("/api/v1/aircraft/:icao", async (request, reply) => {
    const { icao } = icaoParamsSchema.parse(request.params);
    const detail = await repository.aircraftDetail(icao);
    if (!detail.aircraft && !detail.metadata && !detail.summary) {
      return reply.code(404).send({
        error: {
          code: "AIRCRAFT_NOT_FOUND",
          message: `Aircraft ${icao} was not found`
        }
      });
    }
    return detail;
  });

  app.get("/api/v1/sessions", async (request) => {
    const query = sessionQuerySchema.parse(request.query);
    return repository.sessions(query);
  });

  app.get("/api/v1/sessions/:id/track", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const { resolution, from, tail, limit } = trackQuerySchema.parse(
      request.query
    );
    const track = await repository.track(id, resolution, {
      ...(from ? { from } : {}),
      tail,
      limit
    });
    if (!track) {
      return reply.code(404).send({
        error: {
          code: "SESSION_NOT_FOUND",
          message: `Session ${id} was not found`
        }
      });
    }
    return track;
  });

  app.get("/api/v1/summaries", async (request) => {
    const query = summaryQuerySchema.parse(request.query);
    return repository.summaries(query);
  });

  app.get("/api/v1/insights/overview", async (request) => {
    const query = insightQuerySchema.parse(request.query);
    return repository.insightsOverview(query);
  });

  app.get("/api/v1/insights/coverage", async (request) => {
    const query = insightCoverageQuerySchema.parse(request.query);
    return repository.insightsCoverage(query);
  });

  app.get("/api/v1/alerts", async (request) => {
    const query = alertQuerySchema.parse(request.query);
    return repository.alerts(query);
  });

  app.post("/api/v1/alerts/:id/dismiss", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const alert = await repository.dismissAlert(id);
    if (!alert) {
      return reply.code(404).send({
        error: {
          code: "ALERT_NOT_FOUND",
          message: `Alert ${id} was not found`
        }
      });
    }
    const live = (await repository.liveAircraft()).find(
      (aircraft) => aircraft.icao === alert.icao
    );
    hub.publish({
      alerts: [alert],
      upserts: live ? [live] : []
    });
    return alert;
  });

  app.post("/api/v1/alerts/dismiss", async (request) => {
    const { ids } = dismissAlertsInputSchema.parse(request.body);
    const alerts = await repository.dismissAlerts(ids);
    const affectedIcaos = new Set(alerts.map((alert) => alert.icao));
    const live = (await repository.liveAircraft()).filter((aircraft) =>
      affectedIcaos.has(aircraft.icao)
    );
    if (alerts.length > 0) hub.publish({ alerts, upserts: live });
    return { items: alerts };
  });

  app.get("/api/v1/watchlist", async () => ({
    items: await repository.watchlist()
  }));

  app.put("/api/v1/watchlist/:icao", async (request) => {
    const { icao } = icaoParamsSchema.parse(request.params);
    const body = watchlistInputSchema.parse(request.body ?? {});
    const entry = await repository.putWatchlist(icao, body);
    const live = (await repository.liveAircraft()).find(
      (aircraft) => aircraft.icao === icao
    );
    if (live) hub.publish({ upserts: [live] });
    return entry;
  });

  app.delete("/api/v1/watchlist/:icao", async (request, reply) => {
    const { icao } = icaoParamsSchema.parse(request.params);
    const deleted = await repository.deleteWatchlist(icao);
    if (!deleted) {
      return reply.code(404).send({
        error: {
          code: "WATCHLIST_ENTRY_NOT_FOUND",
          message: `Watchlist entry ${icao} was not found`
        }
      });
    }
    const live = (await repository.liveAircraft()).find(
      (aircraft) => aircraft.icao === icao
    );
    if (live) hub.publish({ upserts: [live] });
    return reply.code(204).send();
  });
}
