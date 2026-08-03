import {
  alertQuerySchema,
  aircraftActivityQuerySchema,
  coverageCellDetailQuerySchema,
  customAlertRuleInputSchema,
  customAlertRulePatchSchema,
  dismissAlertsInputSchema,
  icaoSchema,
  insightCoverageQuerySchema,
  insightQuerySchema,
  insightPatternsQuerySchema,
  savedViewInputSchema,
  savedViewPatchSchema,
  rangeProfileQuerySchema,
  sessionExportQuerySchema,
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
import {
  coverageGeoJson,
  exportDateToken,
  insightSeriesCsv,
  sessionTelemetryCsv,
  sessionTrackGeoJson
} from "../domain/exports.js";

const uuidParamsSchema = z.object({ id: z.string().uuid() });
const icaoParamsSchema = z.object({ icao: icaoSchema });

export type ApiDependencies = {
  repository: FlightRepository;
  collector: ReceiverCollector;
  hub: LiveHub;
  status: StatusService;
  settings: AppSettingsService;
  applyRuntimeSettings: () => Promise<void>;
  /** False until boot-time settings have loaded; `/health/ready` reports
   *  `not_ready` rather than the process exiting on a database blip. */
  bootstrapped?: () => boolean;
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
    applyRuntimeSettings,
    bootstrapped = () => true
  } = dependencies;

  app.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString()
  }));

  app.get("/health/ready", async (_request, reply) => {
    const ready = bootstrapped() && (await repository.databaseReady());
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

  app.get("/api/v1/aircraft/:icao/activity", async (request) => {
    const { icao } = icaoParamsSchema.parse(request.params);
    const query = aircraftActivityQuerySchema.parse(request.query);
    return repository.aircraftActivity(icao, query);
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

  app.get("/api/v1/insights/patterns", async (request) => {
    const query = insightPatternsQuerySchema.parse(request.query);
    return repository.insightPatterns(query);
  });

  app.get("/api/v1/insights/range-profile", async (request) => {
    const query = rangeProfileQuerySchema.parse(request.query);
    return repository.rangeProfile(query);
  });

  app.get("/api/v1/insights/coverage-cell", async (request) => {
    const query = coverageCellDetailQuerySchema.parse(request.query);
    return repository.coverageCellDetail(query);
  });

  app.get("/api/v1/exports/insights", async (request, reply) => {
    const query = insightQuerySchema.parse(request.query);
    const overview = await repository.insightsOverview(query);
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="flightmap-insights-${exportDateToken(overview.from)}.csv"`
      )
      .send(insightSeriesCsv(overview));
  });

  app.get("/api/v1/exports/sessions/:id", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const query = sessionExportQuerySchema.parse(request.query);
    const track = await repository.track(id, query.resolution, {
      ...(query.from ? { from: query.from } : {}),
      tail: false,
      limit: 20_000
    });
    if (!track) {
      return reply.code(404).send({
        error: {
          code: "SESSION_NOT_FOUND",
          message: `Session ${id} was not found`
        }
      });
    }
    reply
      .header("X-Flightmap-Truncated", String(track.truncated))
      .header(
        "Content-Disposition",
        `attachment; filename="flightmap-session-${track.session.id}.${query.format === "csv" ? "csv" : "geojson"}"`
      );
    return query.format === "csv"
      ? reply.type("text/csv; charset=utf-8").send(sessionTelemetryCsv(track))
      : reply.type("application/geo+json; charset=utf-8").send(sessionTrackGeoJson(track));
  });

  app.get("/api/v1/exports/coverage", async (request, reply) => {
    const query = insightCoverageQuerySchema.parse(request.query);
    const coverage = await repository.insightsCoverage(query);
    return reply
      .type("application/geo+json; charset=utf-8")
      .header("X-Flightmap-Truncated", String(coverage.truncated))
      .header(
        "Content-Disposition",
        `attachment; filename="flightmap-coverage-${exportDateToken(coverage.from)}.geojson"`
      )
      .send(coverageGeoJson(coverage));
  });

  app.get("/api/v1/alerts", async (request) => {
    const query = alertQuerySchema.parse(request.query);
    return repository.alerts(query);
  });

  app.get("/api/v1/alerts/rules", async () => ({ items: await repository.customAlertRules() }));

  app.post("/api/v1/alerts/rules/preview", async (request) => {
    const input = customAlertRuleInputSchema.parse(request.body ?? {});
    return repository.previewCustomAlertRule(input);
  });

  app.post("/api/v1/alerts/rules", async (request, reply) => {
    const input = customAlertRuleInputSchema.parse(request.body ?? {});
    return reply.code(201).send(await repository.createCustomAlertRule(input));
  });

  app.patch("/api/v1/alerts/rules/:id", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const patch = customAlertRulePatchSchema.parse(request.body ?? {});
    const rule = await repository.updateCustomAlertRule(id, patch);
    return rule ?? reply.code(404).send({ error: { code: "ALERT_RULE_NOT_FOUND", message: `Alert rule ${id} was not found` } });
  });

  app.delete("/api/v1/alerts/rules/:id", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    return await repository.deleteCustomAlertRule(id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: { code: "ALERT_RULE_NOT_FOUND", message: `Alert rule ${id} was not found` } });
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
    const [live] = await repository.liveAircraft(new Date(), [alert.icao]);
    hub.publish({
      alerts: [alert],
      upserts: live ? [live] : []
    });
    return alert;
  });

  app.post("/api/v1/alerts/dismiss", async (request) => {
    const { ids } = dismissAlertsInputSchema.parse(request.body);
    const alerts = await repository.dismissAlerts(ids);
    const affectedIcaos = [...new Set(alerts.map((alert) => alert.icao))];
    const live = await repository.liveAircraft(new Date(), affectedIcaos);
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
    const [live] = await repository.liveAircraft(new Date(), [icao]);
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
    const [live] = await repository.liveAircraft(new Date(), [icao]);
    if (live) hub.publish({ upserts: [live] });
    return reply.code(204).send();
  });

  app.get("/api/v1/saved-views", async () => ({
    items: await repository.savedViews()
  }));

  app.post("/api/v1/saved-views", async (request, reply) => {
    const input = savedViewInputSchema.parse(request.body ?? {});
    const view = await repository.createSavedView(input);
    return reply.code(201).send(view);
  });

  app.patch("/api/v1/saved-views/:id", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const patch = savedViewPatchSchema.parse(request.body ?? {});
    const view = await repository.updateSavedView(id, patch);
    if (!view) {
      return reply.code(404).send({
        error: {
          code: "SAVED_VIEW_NOT_FOUND",
          message: `Saved view ${id} was not found`
        }
      });
    }
    return view;
  });

  app.delete("/api/v1/saved-views/:id", async (request, reply) => {
    const { id } = uuidParamsSchema.parse(request.params);
    const deleted = await repository.deleteSavedView(id);
    if (!deleted) {
      return reply.code(404).send({
        error: {
          code: "SAVED_VIEW_NOT_FOUND",
          message: `Saved view ${id} was not found`
        }
      });
    }
    return reply.code(204).send();
  });
}
