import { buildApp } from "./app.js";
import pino from "pino";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { FlightRepository } from "./db/repository.js";
import { ReceiverCollector } from "./ingestion/collector.js";
import { LiveHub } from "./realtime/live-hub.js";
import { MaintenanceService } from "./services/maintenance.js";
import { MetadataService } from "./services/metadata.js";
import { StatusService } from "./services/status.js";

const config = loadConfig();
const database = new Database(config);
const repository = new FlightRepository(database, config);
const hub = new LiveHub();
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "request.headers.authorization",
      "request.headers.cookie",
      "token",
      "accessToken",
      "config.accessToken"
    ],
    censor: "[Redacted]"
  },
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err
  }
});

const collector = new ReceiverCollector(
  config,
  repository,
  hub,
  logger
);
const maintenance = new MaintenanceService(
  database,
  config.historyRetentionDays,
  logger,
  config.sessionGapSeconds
);
const metadata = new MetadataService(database, config, logger);
const status = new StatusService(config, repository, collector.state);
const app = await buildApp({
  config,
  dependencies: { repository, collector, hub, status },
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

try {
  await app.listen({ host: config.host, port: config.port });
  if (config.collectorEnabled) await collector.start();
  if (config.maintenanceEnabled) maintenance.start();
  if (config.metadataUpdatesEnabled) metadata.start();
} catch (error) {
  app.log.fatal({ error }, "Application startup failed");
  await shutdown("startup_error");
  process.exitCode = 1;
}
