import { describe, expect, it, vi } from "vitest";
import {
  RouteLookup,
  normaliseCallsign,
  parseRouteResponse,
  type RouteLookupSettings
} from "../src/services/routes.js";

const settings = (overrides: Partial<RouteLookupSettings> = {}) =>
  (): RouteLookupSettings => ({
    routeLookupEnabled: true,
    routeLookupUrl: "https://routes.test/v0/callsign/{callsign}",
    routeLookupTimeoutMs: 1_000,
    routeLookupTtlHours: 336,
    routeLookupNegativeTtlHours: 72,
    ...overrides
  });

const logger = { warn: vi.fn() };

/** No cached row, and every write accepted. */
function stubDatabase(rows: unknown[] = []) {
  const query = vi.fn(async (sql: string) =>
    sql.startsWith("SELECT") ? { rows } : { rows: [] }
  );
  return { database: { pool: { query } } as never, query };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("normaliseCallsign", () => {
  it("upper-cases and trims what the receiver pads", () => {
    expect(normaliseCallsign("  exs8tz ")).toBe("EXS8TZ");
  });

  /* The callsign is both a cache key and part of a URL. */
  it("rejects anything that is not a callsign", () => {
    expect(normaliseCallsign("")).toBeNull();
    expect(normaliseCallsign("  ")).toBeNull();
    expect(normaliseCallsign("AB")).toBeNull();
    expect(normaliseCallsign("../../etc/passwd")).toBeNull();
    expect(normaliseCallsign("EXS 8TZ")).toBeNull();
  });
});

describe("parseRouteResponse", () => {
  const nested = {
    response: {
      flightroute: {
        callsign: "EXS8TZ",
        origin: {
          iata_code: "NCL",
          icao_code: "EGNT",
          name: "Newcastle Airport",
          municipality: "Newcastle"
        },
        destination: {
          iata_code: "AGP",
          icao_code: "LEMG",
          name: "Malaga Airport",
          municipality: "Malaga"
        }
      }
    }
  };

  it("reads both ends out of a nested provider response", () => {
    const route = parseRouteResponse("EXS8TZ", nested, "2026-08-07T09:00:00.000Z");
    expect(route?.origin).toMatchObject({ iata: "NCL", icao: "EGNT" });
    expect(route?.destination).toMatchObject({ iata: "AGP", municipality: "Malaga" });
  });

  /* The URL is a setting, so the shape behind it is not guaranteed to nest the
     same way — a provider returning the route at the top level still works. */
  it("reads a response that does not nest the route", () => {
    const route = parseRouteResponse(
      "EXS8TZ",
      { origin: { iata: "NCL" }, destination: { iata: "AGP" } },
      "2026-08-07T09:00:00.000Z"
    );
    expect(route?.origin?.iata).toBe("NCL");
  });

  it("treats a route with neither end resolved as no route", () => {
    expect(
      parseRouteResponse("EXS8TZ", { response: { flightroute: {} } }, "2026-08-07T09:00:00.000Z")
    ).toBeNull();
    expect(parseRouteResponse("EXS8TZ", { nothing: true }, "2026-08-07T09:00:00.000Z")).toBeNull();
  });

  it("keeps one end when only one resolved", () => {
    const route = parseRouteResponse(
      "EXS8TZ",
      { origin: { iata: "NCL" }, destination: null },
      "2026-08-07T09:00:00.000Z"
    );
    expect(route?.origin?.iata).toBe("NCL");
    expect(route?.destination).toBeNull();
  });
});

describe("RouteLookup", () => {
  it("asks nothing at all while the setting is off", async () => {
    const { database, query } = stubDatabase();
    const fetchImpl = vi.fn();
    const lookup = new RouteLookup(
      database,
      settings({ routeLookupEnabled: false }),
      logger,
      fetchImpl as never
    );

    expect(await lookup.lookup("EXS8TZ")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("substitutes the callsign into the configured URL", async () => {
    const { database } = stubDatabase();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ origin: { iata: "NCL" }, destination: { iata: "AGP" } })
    );
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    await lookup.lookup("exs8tz");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://routes.test/v0/callsign/EXS8TZ",
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
  });

  /* Two devices selecting the same aircraft at once must not each call out. */
  it("collapses concurrent lookups of one callsign into a single request", async () => {
    const { database } = stubDatabase();
    const fetchImpl = vi.fn(async () => jsonResponse({ origin: { iata: "NCL" } }));
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    const [first, second] = await Promise.all([
      lookup.lookup("EXS8TZ"),
      lookup.lookup("EXS8TZ")
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("caches a miss so a callsign that never resolves is asked once", async () => {
    const { database, query } = stubDatabase();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    expect(await lookup.lookup("GABCD")).toBeNull();

    const write = query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT"));
    expect(write?.[1]?.[0]).toBe("GABCD");
    expect(write?.[1]?.[1]).toBe(false);
  });

  it("returns a cached route without calling out again", async () => {
    const { database } = stubDatabase([
      {
        callsign: "EXS8TZ",
        found: true,
        origin_iata: "NCL",
        origin_icao: "EGNT",
        origin_name: "Newcastle Airport",
        origin_municipality: "Newcastle",
        destination_iata: "AGP",
        destination_icao: "LEMG",
        destination_name: "Malaga Airport",
        destination_municipality: "Malaga",
        resolved_at: "2026-08-07T09:00:00.000Z"
      }
    ]);
    const fetchImpl = vi.fn();
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    const route = await lookup.lookup("EXS8TZ");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(route?.destination?.iata).toBe("AGP");
  });

  /* A route is an extra; the panel it decorates has to open regardless. */
  it("resolves to null when the provider fails", async () => {
    const { database } = stubDatabase();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    await expect(lookup.lookup("EXS8TZ")).resolves.toBeNull();
  });

  it("resolves to null when the cache write fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).startsWith("INSERT")) throw new Error("read only");
      return { rows: [] };
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ origin: { iata: "NCL" } }));
    const lookup = new RouteLookup(
      { pool: { query } } as never,
      settings(),
      logger,
      fetchImpl as never
    );

    await expect(lookup.lookup("EXS8TZ")).resolves.toMatchObject({
      origin: { iata: "NCL" }
    });
  });

  it("does not look up an aircraft with no callsign", async () => {
    const { database } = stubDatabase();
    const fetchImpl = vi.fn();
    const lookup = new RouteLookup(database, settings(), logger, fetchImpl as never);

    expect(await lookup.lookup(null)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
