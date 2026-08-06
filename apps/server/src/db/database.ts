import { readFileSync } from "node:fs";
import pg from "pg";
import type { Config } from "../config.js";

const { Pool } = pg;

export type Queryable = Pick<pg.PoolClient, "query">;

/** Only the level this class emits; `pino` and the CLI loggers both satisfy it. */
export type DatabaseLogger = {
  error: (object: unknown, message?: string) => void;
};

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
      >,
    private readonly logger: DatabaseLogger = {
      error: (object, message) =>
        process.stderr.write(
          `${message ?? "database error"} ${JSON.stringify(object)}\n`
        )
    }
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
    /*
     * `pg` re-emits errors raised by *idle* clients on the pool, and an
     * EventEmitter 'error' with no listener throws — which would take the
     * process down. PostgreSQL restarting, `pg_terminate_backend`, a
     * server-side idle timeout and a network blip all reach here, and none of
     * them is worth exiting over: the pool discards the broken client and the
     * next query opens a new one. Losing this listener re-arms a crash that
     * `index.ts` otherwise goes to some trouble to avoid.
     */
    this.pool.on("error", (error) => {
      this.logger.error({ error }, "Idle PostgreSQL client failed");
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

  /**
   * A failed `ROLLBACK` must not replace the error that caused it. The usual
   * reason rollback fails is that the connection died mid-transaction, so the
   * rejection it produces says nothing the caller wants and hides the one it
   * does — and the client cannot be reused, because there is no way to know
   * whether it is still inside a transaction. It is destroyed rather than
   * returned to the pool.
   */
  async transaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = true;
        this.logger.error(
          { error: rollbackError },
          "Could not roll back a failed transaction; discarding the connection"
        );
      }
      throw error;
    } finally {
      client.release(broken);
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
