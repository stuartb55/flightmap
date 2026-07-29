import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { MetadataService } from "./services/metadata.js";

const config = loadConfig();
const database = new Database(config);
const logger = {
  info: (object: unknown, message?: string) =>
    process.stdout.write(`${message ?? "info"} ${JSON.stringify(object)}\n`),
  warn: (object: unknown, message?: string) =>
    process.stderr.write(`${message ?? "warn"} ${JSON.stringify(object)}\n`)
};

try {
  const service = new MetadataService(database, config, logger);
  const result = await service.refresh(true);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.close();
}
