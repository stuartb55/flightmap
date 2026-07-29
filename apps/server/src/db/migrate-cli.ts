import { loadConfig } from "../config.js";
import { Database } from "./database.js";
import { migrate } from "./migrator.js";

const config = loadConfig();
const database = new Database(config);

try {
  await migrate(database);
  process.stdout.write("Database migrations are up to date.\n");
} finally {
  await database.close();
}
