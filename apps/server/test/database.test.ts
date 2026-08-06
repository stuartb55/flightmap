import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for `pg.Pool` that keeps the one behaviour these tests are about:
 * it is an EventEmitter, so an 'error' with no listener throws the way the real
 * pool does when an idle client fails.
 */
class FakePool extends EventEmitter {
  readonly released: boolean[] = [];
  client = {
    query: vi.fn<(text: string) => Promise<unknown>>().mockResolvedValue({ rows: [] }),
    release: (destroy?: boolean) => this.released.push(destroy === true)
  };

  connect = async () => this.client;
  query = vi.fn().mockResolvedValue({ rows: [] });
  end = vi.fn().mockResolvedValue(undefined);
}

const pool = { current: new FakePool() };

vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor() {
        return pool.current;
      }
    }
  }
}));

const { Database } = await import("../src/db/database.js");

const config = {
  databaseUrl: "postgres://flightmap@localhost:5432/flightmap",
  databasePoolMax: 4,
  databaseSsl: false,
  databaseSslCaFile: null
};

describe("the connection pool", () => {
  beforeEach(() => {
    pool.current = new FakePool();
  });

  /*
   * `pg` re-emits errors from idle clients on the pool. Without a listener an
   * EventEmitter 'error' throws, which takes the process down — so a routine
   * PostgreSQL restart would look like an application crash.
   */
  it("logs an idle client failure instead of letting it crash the process", () => {
    const logger = { error: vi.fn() };
    new Database(config, logger);

    expect(() =>
      pool.current.emit("error", new Error("terminating connection"))
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      expect.stringContaining("Idle PostgreSQL client")
    );
  });
});

describe("transactions", () => {
  beforeEach(() => {
    pool.current = new FakePool();
  });

  it("commits and returns the connection to the pool", async () => {
    const database = new Database(config, { error: vi.fn() });
    await expect(database.transaction(async () => "done")).resolves.toBe("done");

    expect(pool.current.client.query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN",
      "COMMIT"
    ]);
    expect(pool.current.released).toEqual([false]);
  });

  it("rolls back and reports the error the caller raised", async () => {
    const database = new Database(config, { error: vi.fn() });
    await expect(
      database.transaction(async () => {
        throw new Error("duplicate key");
      })
    ).rejects.toThrow("duplicate key");

    expect(pool.current.client.query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN",
      "ROLLBACK"
    ]);
    expect(pool.current.released).toEqual([false]);
  });

  /*
   * Rollback usually fails because the connection died mid-transaction. The
   * rejection it produces says nothing the caller wants and hides the one it
   * does, and the client cannot be reused: there is no way to know whether it
   * is still inside a transaction.
   */
  it("keeps the original error when rollback fails, and discards the connection", async () => {
    const logger = { error: vi.fn() };
    const database = new Database(config, logger);
    pool.current.client.query.mockImplementation(async (text: string) => {
      if (text === "ROLLBACK") throw new Error("connection terminated");
      return { rows: [] };
    });

    await expect(
      database.transaction(async () => {
        throw new Error("statement timeout");
      })
    ).rejects.toThrow("statement timeout");

    expect(pool.current.released).toEqual([true]);
    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      expect.stringContaining("Could not roll back")
    );
  });
});
