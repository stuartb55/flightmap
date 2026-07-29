import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

export async function migrate(database: Database): Promise<void> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  await database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_907_182_025]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{
      name: string;
      checksum: string;
    }>("SELECT name, checksum FROM schema_migrations");
    const checksums = new Map(
      applied.rows.map((row) => [row.name, row.checksum])
    );

    for (const file of files) {
      const sql = await readFile(join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = checksums.get(file);
      if (existing && existing !== checksum) {
        throw new Error(
          `Migration ${file} changed after it was applied; add a new migration`
        );
      }
      if (existing) continue;
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [file, checksum]
      );
    }
  });
}
