import { readFileSync } from "node:fs";
import pg from "pg";
import type { Config } from "../config.js";

const { Pool } = pg;

export type Queryable = Pick<pg.PoolClient, "query">;

export class Database {
  readonly pool: pg.Pool;

  constructor(
    config: Pick<
      Config,
      | "databaseUrl"
      | "databasePoolMax"
      | "databaseSsl"
      | "databaseSslCaFile"
    > &
      Partial<
        Pick<
          Config,
          "databaseConnectionTimeoutMs" | "databaseStatementTimeoutMs"
        >
      >
  ) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      application_name: "flightmap",
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs ?? 5000,
      statement_timeout: config.databaseStatementTimeoutMs ?? 60_000,
      query_timeout: config.databaseStatementTimeoutMs ?? 60_000,
      ssl: config.databaseSsl
        ? {
            rejectUnauthorized: true,
            ...(config.databaseSslCaFile
              ? { ca: readFileSync(config.databaseSslCaFile, "utf8") }
              : {})
          }
        : undefined
    });
  }

  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[] | undefined);
  }

  /**
   * Runs `callback` on a dedicated pooled connection without an implicit
   * transaction, for work that needs session state (advisory locks) to span
   * several independently committed statements.
   */
  async connect<T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  async transaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
