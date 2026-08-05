import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AirportImportError, AirportImportService } from "../src/services/airports.js";
import { defaultAppSettings } from "../src/settings.js";

const AIRPORT_HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';
const RUNWAY_HEADER =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';

/** Enough rows to clear the "this is not an OurAirports export" floor. */
function airportsCsv(count = 150): string {
  const rows = [AIRPORT_HEADER];
  for (let index = 0; index < count; index += 1) {
    rows.push(
      [
        String(index),
        `EG${index.toString().padStart(3, "0")}`,
        index === 0 ? "large_airport" : "medium_airport",
        `"Aerodrome ${index}"`,
        String(53.35 + index / 5_000),
        String(-2.28 + index / 5_000),
        "250",
        "EU",
        "GB",
        "GB-ENG",
        "Town",
        "yes",
        `EG${index.toString().padStart(3, "0")}`,
        "",
        "",
        "",
        "",
        "",
        ""
      ].join(",")
    );
  }
  return rows.join("\n");
}

function runwaysCsv(): string {
  return [
    RUNWAY_HEADER,
    ["1", "1", "EG000", "10000", "150", "ASP", "1", "0", "05", "53.34", "-2.29", "250", "50", "0", "23", "53.36", "-2.25", "250", "230", "0"].join(",")
  ].join("\n");
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/csv" } });
}

function settingsDouble(overrides: Record<string, unknown> = {}) {
  const current = { ...defaultAppSettings, ...overrides };
  const update = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(current, patch);
    return { settings: current, updatedAt: new Date().toISOString() };
  });
  return {
    service: {
      get: () => ({ settings: current, updatedAt: null }),
      update
    } as never,
    update,
    current
  };
}

function service(
  fetchImplementation: typeof fetch,
  options: {
    settings?: Record<string, unknown>;
    receiver?: { latitude: number | null; longitude: number | null };
  } = {}
) {
  const settings = settingsDouble(options.settings);
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    settings,
    logger,
    airports: new AirportImportService(
      settings.service,
      loadConfig({ NODE_ENV: "test" }),
      logger,
      () => options.receiver ?? { latitude: 53.61, longitude: -2.31 },
      fetchImplementation
    )
  };
}

describe("the airport import", () => {
  it("downloads both files and applies the result to the running settings", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("runways") ? ok(runwaysCsv()) : ok(airportsCsv())
    ) as unknown as typeof fetch;
    const { airports, settings } = service(fetchImplementation);

    const summary = await airports.refresh();

    expect(summary.airports).toBeGreaterThan(0);
    expect(summary.runways).toBe(1);
    expect(summary.byRank.large).toBe(1);
    expect(summary.centre).toEqual({ latitude: 53.61, longitude: -2.31 });
    /*
     * The whole point of doing this in the server rather than in a CLI: the
     * update goes through the settings service, so the process that is serving
     * the map has the new dataset without being restarted.
     */
    expect(settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ mapAirportsUpdatedAt: summary.updatedAt })
    );
    expect(settings.current.mapAirports).toHaveLength(summary.airports);
  });

  it("falls back to the receiver's advertised position when no override is set", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("runways") ? ok(runwaysCsv()) : ok(airportsCsv())
    ) as unknown as typeof fetch;
    const { airports } = service(fetchImplementation, {
      settings: { receiverLatitude: null, receiverLongitude: null },
      receiver: { latitude: 53.4, longitude: -2.2 }
    });

    expect((await airports.refresh()).centre).toEqual({ latitude: 53.4, longitude: -2.2 });
  });

  it("uses the configured override in preference to the receiver", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("runways") ? ok(runwaysCsv()) : ok(airportsCsv())
    ) as unknown as typeof fetch;
    const { airports } = service(fetchImplementation, {
      settings: { receiverLatitude: 51.5, receiverLongitude: -0.4 },
      receiver: { latitude: 53.4, longitude: -2.2 }
    });

    expect((await airports.refresh()).centre).toEqual({ latitude: 51.5, longitude: -0.4 });
  });

  /*
   * Every failure below leaves the existing dataset alone. A map that keeps
   * showing yesterday's airports is a far better answer to a failed download
   * than a map that has lost them.
   */
  it("explains an unknown centre rather than guessing one", async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const { airports, settings } = service(fetchImplementation, {
      settings: { receiverLatitude: null, receiverLongitude: null },
      receiver: { latitude: null, longitude: null }
    });

    await expect(airports.refresh()).rejects.toMatchObject({
      code: "AIRPORT_CENTRE_UNKNOWN"
    });
    expect(settings.update).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reports an unreachable source by name", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const { airports, settings } = service(fetchImplementation);

    await expect(airports.refresh()).rejects.toMatchObject({
      code: "AIRPORT_DOWNLOAD_FAILED"
    });
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("reports a non-success status", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("nope", { status: 503 })
    ) as unknown as typeof fetch;
    const { airports } = service(fetchImplementation);

    await expect(airports.refresh()).rejects.toThrow(/503/);
  });

  it("refuses a file that is too small to be an OurAirports export", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("runways") ? ok(runwaysCsv()) : ok(airportsCsv(4))
    ) as unknown as typeof fetch;
    const { airports, settings } = service(fetchImplementation);

    await expect(airports.refresh()).rejects.toMatchObject({
      code: "AIRPORT_DATA_UNUSABLE"
    });
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("refuses a download that declares more bytes than the limit", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(512 * 1024 * 1024) }
      })
    ) as unknown as typeof fetch;
    const { airports } = service(fetchImplementation);

    await expect(airports.refresh()).rejects.toMatchObject({
      code: "AIRPORT_DOWNLOAD_FAILED"
    });
  });

  /*
   * The caller is a person who has just pressed a button. Two imports racing to
   * write the same setting is worth refusing outright, and they can press it
   * again.
   */
  it("refuses to run two downloads at once", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      await gate;
      return String(url).includes("runways") ? ok(runwaysCsv()) : ok(airportsCsv());
    }) as unknown as typeof fetch;
    const { airports } = service(fetchImplementation);

    const first = airports.refresh();
    await expect(airports.refresh()).rejects.toMatchObject({
      code: "AIRPORT_IMPORT_RUNNING"
    });
    release?.();
    await first;

    // And the lock is released, so the next press works.
    await expect(airports.refresh()).resolves.toMatchObject({ airports: expect.any(Number) });
  });

  it("carries a readable message on every failure", () => {
    const error = new AirportImportError("Something went wrong", "AIRPORT_DOWNLOAD_FAILED");
    expect(error.message).toBe("Something went wrong");
    expect(error.name).toBe("AirportImportError");
  });
});
