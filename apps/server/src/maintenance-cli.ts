import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { MaintenanceService } from "./services/maintenance.js";
import { AppSettingsService } from "./settings.js";

const bootConfig = loadConfig();
const database = new Database(bootConfig);
const logger = {
  info: (object: unknown, message?: string) =>
    process.stdout.write(`${message ?? "info"} ${JSON.stringify(object)}\n`),
  error: (object: unknown, message?: string) =>
    process.stderr.write(`${message ?? "error"} ${JSON.stringify(object)}\n`)
};

try {
  const settings = new AppSettingsService(database);
  await settings.load();
  const config = settings.runtimeConfig(bootConfig);
  const service = new MaintenanceService(database, config, logger);
  await service.run();
} finally {
  await database.close();
}
