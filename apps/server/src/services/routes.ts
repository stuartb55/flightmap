/**
 * Callsign-to-route lookups.
 *
 * A transponder broadcasts a callsign, never a route, so where an aircraft came
 * from and where it is going cannot be derived from anything the receiver hears.
 * The only way to have it is to ask something else, which is why this is the one
 * part of the application that talks to a third party and why it is off until an
 * operator turns it on.
 *
 * Everything here is best-effort. A lookup that times out, fails, or returns a
 * shape this does not recognise resolves to null, which the detail endpoint
 * reports the same way as "switched off" and "no such route" — the panel simply
 * has no route to show, which is the normal case for most of what a receiver
 * hears.
 */
import type { Database } from "../db/database.js";

type Logger = {
  warn: (object: unknown, message?: string) => void;
};

export type RouteAirport = {
  iata: string | null;
  icao: string | null;
  name: string | null;
  municipality: string | null;
};

export type FlightRoute = {
  callsign: string;
  origin: RouteAirport | null;
  destination: RouteAirport | null;
  resolvedAt: string;
};

export type RouteLookupSettings = {
  routeLookupEnabled: boolean;
  routeLookupUrl: string;
  routeLookupTimeoutMs: number;
  routeLookupTtlHours: number;
  routeLookupNegativeTtlHours: number;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

/**
 * Callsigns arrive from the receiver padded and in mixed case, and the cache is
 * keyed on them, so an unnormalised key would store the same route several
 * times and miss every one of them.
 */
export function normaliseCallsign(callsign: string | null): string | null {
  const trimmed = clean(callsign)?.toUpperCase();
  if (!trimmed) return null;
  // Anything outside this is not a callsign a route service will resolve, and
  // it would go into a URL.
  return /^[A-Z0-9]{3,10}$/.test(trimmed) ? trimmed : null;
}

/**
 * Reads the airport objects out of a provider response.
 *
 * Written against adsbdb's `v0/callsign` shape, which nests the route under
 * `response.flightroute`, but it walks rather than indexes: a provider that
 * returns `origin`/`destination` at the top level works without a code change,
 * which is the point of the URL being a setting.
 */
export function parseRouteResponse(
  callsign: string,
  body: unknown,
  resolvedAt: string
): FlightRoute | null {
  const flightroute = locateRoute(body);
  if (!flightroute) return null;

  const origin = parseAirport(flightroute.origin);
  const destination = parseAirport(flightroute.destination);
  // A route with neither end resolved says nothing the callsign did not.
  if (!origin && !destination) return null;
  return { callsign, origin, destination, resolvedAt };
}

function locateRoute(
  body: unknown
): { origin?: unknown; destination?: unknown } | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if ("origin" in record || "destination" in record) {
    return record as { origin?: unknown; destination?: unknown };
  }
  for (const key of ["response", "flightroute", "data", "result"]) {
    const nested = record[key];
    if (nested !== null && typeof nested === "object") {
      const found = locateRoute(nested);
      if (found) return found;
    }
  }
  return null;
}

function parseAirport(value: unknown): RouteAirport | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const airport: RouteAirport = {
    iata: clean(record.iata_code ?? record.iata),
    icao: clean(record.icao_code ?? record.icao),
    name: clean(record.name),
    municipality: clean(record.municipality ?? record.city)
  };
  return airport.iata ?? airport.icao ?? airport.name ? airport : null;
}

type RouteRow = {
  callsign: string;
  found: boolean;
  origin_iata: string | null;
  origin_icao: string | null;
  origin_name: string | null;
  origin_municipality: string | null;
  destination_iata: string | null;
  destination_icao: string | null;
  destination_name: string | null;
  destination_municipality: string | null;
  resolved_at: Date | string;
};

function rowToRoute(row: RouteRow): FlightRoute | null {
  if (!row.found) return null;
  const resolvedAt = new Date(row.resolved_at).toISOString();
  const origin: RouteAirport = {
    iata: row.origin_iata,
    icao: row.origin_icao,
    name: row.origin_name,
    municipality: row.origin_municipality
  };
  const destination: RouteAirport = {
    iata: row.destination_iata,
    icao: row.destination_icao,
    name: row.destination_name,
    municipality: row.destination_municipality
  };
  return {
    callsign: row.callsign,
    origin: origin.iata ?? origin.icao ?? origin.name ? origin : null,
    destination:
      destination.iata ?? destination.icao ?? destination.name
        ? destination
        : null,
    resolvedAt
  };
}

export class RouteLookup {
  /*
   * Selecting an aircraft on two devices at once, or re-selecting it while the
   * first request is still out, must not produce two calls to a third party for
   * the same callsign. Resolved entries are removed as soon as they settle;
   * this holds requests in flight, not results, which the database holds.
   */
  private readonly inFlight = new Map<string, Promise<FlightRoute | null>>();

  constructor(
    private readonly database: Database,
    private readonly settings: () => RouteLookupSettings,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async lookup(rawCallsign: string | null): Promise<FlightRoute | null> {
    const settings = this.settings();
    if (!settings.routeLookupEnabled) return null;

    const callsign = normaliseCallsign(rawCallsign);
    if (!callsign) return null;

    const cached = await this.readCache(callsign, settings);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(callsign);
    if (existing) return existing;

    const request = this.resolve(callsign, settings).finally(() => {
      this.inFlight.delete(callsign);
    });
    this.inFlight.set(callsign, request);
    return request;
  }

  /**
   * `undefined` means "nothing usable cached, go and ask"; `null` means a
   * lookup has already run and found nothing, which is an answer.
   */
  private async readCache(
    callsign: string,
    settings: RouteLookupSettings
  ): Promise<FlightRoute | null | undefined> {
    const result = await this.database.pool.query<RouteRow>(
      `SELECT * FROM flight_routes
        WHERE callsign = $1
          AND resolved_at >= now() - (
                CASE WHEN found THEN $2::int ELSE $3::int END || ' hours'
              )::interval`,
      [
        callsign,
        settings.routeLookupTtlHours,
        settings.routeLookupNegativeTtlHours
      ]
    );
    const row = result.rows[0];
    return row ? rowToRoute(row) : undefined;
  }

  private async resolve(
    callsign: string,
    settings: RouteLookupSettings
  ): Promise<FlightRoute | null> {
    const route = await this.fetchRoute(callsign, settings);
    await this.writeCache(callsign, route);
    return route;
  }

  private async fetchRoute(
    callsign: string,
    settings: RouteLookupSettings
  ): Promise<FlightRoute | null> {
    const url = settings.routeLookupUrl.replaceAll(
      "{callsign}",
      encodeURIComponent(callsign)
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      settings.routeLookupTimeoutMs
    );
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
      // A provider answers "no such callsign" with 404, which is a real answer
      // and gets cached as one rather than retried.
      if (!response.ok) return null;
      return parseRouteResponse(
        callsign,
        await response.json(),
        new Date().toISOString()
      );
    } catch (error) {
      // Never surfaced: a route is an extra, and the panel it decorates has to
      // open whether or not a third party answered.
      this.logger.warn(
        { callsign, error: String(error) },
        "Route lookup failed"
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async writeCache(
    callsign: string,
    route: FlightRoute | null
  ): Promise<void> {
    try {
      await this.database.pool.query(
        `INSERT INTO flight_routes (
           callsign, found,
           origin_iata, origin_icao, origin_name, origin_municipality,
           destination_iata, destination_icao, destination_name,
           destination_municipality, resolved_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (callsign) DO UPDATE SET
           found = EXCLUDED.found,
           origin_iata = EXCLUDED.origin_iata,
           origin_icao = EXCLUDED.origin_icao,
           origin_name = EXCLUDED.origin_name,
           origin_municipality = EXCLUDED.origin_municipality,
           destination_iata = EXCLUDED.destination_iata,
           destination_icao = EXCLUDED.destination_icao,
           destination_name = EXCLUDED.destination_name,
           destination_municipality = EXCLUDED.destination_municipality,
           resolved_at = EXCLUDED.resolved_at`,
        [
          callsign,
          route !== null,
          route?.origin?.iata ?? null,
          route?.origin?.icao ?? null,
          route?.origin?.name ?? null,
          route?.origin?.municipality ?? null,
          route?.destination?.iata ?? null,
          route?.destination?.icao ?? null,
          route?.destination?.name ?? null,
          route?.destination?.municipality ?? null
        ]
      );
    } catch (error) {
      // Losing the cache write costs another lookup later, which is not worth
      // failing the request the caller is waiting on.
      this.logger.warn(
        { callsign, error: String(error) },
        "Route cache write failed"
      );
    }
  }
}
