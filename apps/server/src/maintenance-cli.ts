import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { MaintenanceService } from "./services/maintenance.js";

const config = loadConfig();
const database = new Database(config);
const logger = {
  info: (object: unknown, message?: string) =>
    process.stdout.write(`${message ?? "info"} ${JSON.stringify(object)}\n`),
  error: (object: unknown, message?: string) =>
    process.stderr.write(`${message ?? "error"} ${JSON.stringify(object)}\n`)
};

try {
  const service = new MaintenanceService(
    database,
    config.historyRetentionDays,
    logger,
    config.sessionGapSeconds
  );
  await service.run();
} finally {
  await database.close();
}
