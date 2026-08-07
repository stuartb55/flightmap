import { buildApp } from "./app.js";
import pino from "pino";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { FlightRepository } from "./db/repository.js";
import { ReceiverCollector } from "./ingestion/collector.js";
import { LiveHub } from "./realtime/live-hub.js";
import { MaintenanceService } from "./services/maintenance.js";
import { InsightBackfillService } from "./services/insight-backfill.js";
import { MetadataService } from "./services/metadata.js";
import { AirportImportService } from "./services/airports.js";
import { RouteLookup } from "./services/routes.js";
import { StatusService } from "./services/status.js";
import { AppSettingsService } from "./settings.js";

const bootConfig = loadConfig();
// Built before the pool, which needs somewhere to report the failures of idle
// connections. `logLevel` is boot configuration, so this is the same level the
// rest of the application runs at.
const logger = pino({
  level: bootConfig.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "request.headers.authorization",
      "request.headers.cookie"
    ],
    censor: "[Redacted]"
  },
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err
  }
});
const database = new Database(bootConfig, logger);
const settings = new AppSettingsService(database);
// Persisted settings are loaded after the HTTP server binds, so a database
// blip at boot surfaces as /health/ready reporting not_ready rather than as a
// process that never answers at all. Runtime configs are updated in place.
const config = settings.runtimeConfig(bootConfig);
const repository = new FlightRepository(database, config);
const hub = new LiveHub();

const collector = new ReceiverCollector(
  config,
  repository,
  hub,
  logger
);
const maintenance = new MaintenanceService(
  database,
  config,
  logger
);
const insightBackfill = new InsightBackfillService(database, logger);
const metadata = new MetadataService(database, config, logger);
const status = new StatusService(config, repository, collector.state);
/* Reads the settings on every lookup rather than at construction, so turning
   route lookup on or off takes effect on the next selection instead of on the
   next restart. */
const routes = new RouteLookup(database, () => config, logger);
const airportImport = new AirportImportService(
  settings,
  config,
  logger,
  // The configured override wins, but a receiver that advertises its own
  // position means an operator never has to type coordinates to use this.
  () => {
    const receiver = collector.state.realtime();
    return { latitude: receiver.latitude, longitude: receiver.longitude };
  }
);
const applyRuntimeSettings = async (): Promise<void> => {
  collector.applySettings();
  if (config.collectorEnabled) await collector.start();
  else await collector.stop();
  if (config.maintenanceEnabled) maintenance.start();
  else await maintenance.stop();
  if (config.metadataUpdatesEnabled) metadata.start();
  else await metadata.stop();
};
const app = await buildApp({
  config,
  dependencies: {
    repository,
    collector,
    hub,
    status,
    settings,
    airportImport,
    routes,
    applyRuntimeSettings,
    bootstrapped: () => settings.isLoaded()
  },
  loggerInstance: logger
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Graceful shutdown started");
  const forcedExit = setTimeout(() => {
    app.log.fatal("Graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forcedExit.unref();
  await Promise.all([
    maintenance.stop(),
    insightBackfill.stop(),
    metadata.stop(),
    collector.stop()
  ]);
  hub.close();
  await app.close();
  await database.close();
  clearTimeout(forcedExit);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

/**
 * Loads persisted settings and starts the background services, retrying with
 * backoff. Both steps need the database, and neither is worth killing an
 * already-listening process over.
 */
async function bootstrap(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt += 1) {
    try {
      await settings.load();
      insightBackfill.start();
      await applyRuntimeSettings();
      app.log.info({ attempt }, "Application settings loaded");
      return;
    } catch (error) {
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      app.log.error(
        { error, attempt, retryInMs: delay },
        "Could not complete startup; serving defaults and retrying"
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay).unref();
      });
    }
  }
}

try {
  await app.listen({ host: config.host, port: config.port });
  void bootstrap();
} catch (error) {
  app.log.fatal({ error }, "Application startup failed");
  await shutdown("startup_error");
  process.exitCode = 1;
}
