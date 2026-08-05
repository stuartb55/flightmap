import { gzipSync } from "node:zlib";
import type { Airport } from "@flightmap/shared";
import { csvRecords, selectAirports } from "../domain/airports.js";
import type { Config } from "../config.js";
import type { AppSettingsService } from "../settings.js";

/**
 * Building the airport dataset from the Settings page.
 *
 * The map still never fetches airport data while it renders — the layer reads
 * `GET /api/v1/airports`, which is served from the `mapAirports` setting. This
 * is the same shape as the aircraft registry: an operator asks for a refresh,
 * the server downloads a CSV, validates it, and writes the result. The one
 * difference from the CLI is that the update happens in this process, so the
 * running application serves the new dataset immediately.
 */

type Logger = {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
};

export type AirportImportSummary = {
  airports: number;
  runways: number;
  byRank: { large: number; medium: number; small: number };
  payloadBytes: number;
  gzippedBytes: number;
  centre: { latitude: number; longitude: number };
  radiusNm: number;
  minimumRunwayFt: number;
  updatedAt: string;
};

export class AirportImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "AIRPORT_IMPORT_RUNNING"
      | "AIRPORT_CENTRE_UNKNOWN"
      | "AIRPORT_DOWNLOAD_FAILED"
      | "AIRPORT_DATA_UNUSABLE"
  ) {
    super(message);
    this.name = "AirportImportError";
  }
}

/*
 * Fixed rather than configurable. An operator has no way to judge a sensible
 * byte cap, and the only thing a wrong one can do is turn a hostile or broken
 * URL into a memory problem. The airports export is a few megabytes; this is
 * generous enough to survive years of growth and small enough to be a limit.
 */
const MAXIMUM_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Below this the file is not an OurAirports export, whatever it is. */
const MINIMUM_CSV_ROWS = 100;

export class AirportImportService {
  private running = false;

  constructor(
    private readonly settings: AppSettingsService,
    private readonly config: Config,
    private readonly logger: Logger,
    /** The receiver's advertised position, used when no override is set. */
    private readonly receiverPosition: () => {
      latitude: number | null;
      longitude: number | null;
    },
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  /**
   * Reads both exports, selects what is in range, and writes `mapAirports`.
   *
   * Rejects rather than queues when one is already in flight: two concurrent
   * imports would race to write the same setting, and the caller is a person
   * who has just pressed a button and can press it again.
   */
  async refresh(): Promise<AirportImportSummary> {
    if (this.running) {
      throw new AirportImportError(
        "An airport download is already running",
        "AIRPORT_IMPORT_RUNNING"
      );
    }
    this.running = true;
    try {
      const current = this.settings.get().settings;
      const receiver = this.receiverPosition();
      const latitude = current.receiverLatitude ?? receiver.latitude;
      const longitude = current.receiverLongitude ?? receiver.longitude;
      if (latitude === null || longitude === null) {
        throw new AirportImportError(
          "The receiver position is not known yet, so there is no centre to measure from. Set the receiver latitude and longitude, or wait for the receiver to report its position.",
          "AIRPORT_CENTRE_UNKNOWN"
        );
      }

      const [airportsCsv, runwaysCsv] = await Promise.all([
        this.download(current.airportDataUrl, "airports"),
        this.download(current.airportRunwayDataUrl, "runways")
      ]);

      const airportRows = csvRecords(airportsCsv);
      if (airportRows.length < MINIMUM_CSV_ROWS) {
        throw new AirportImportError(
          `The airports file held ${airportRows.length} rows, which is too few to be an OurAirports export. The dataset has been left as it was.`,
          "AIRPORT_DATA_UNUSABLE"
        );
      }

      const items = selectAirports(airportRows, csvRecords(runwaysCsv), {
        latitude,
        longitude,
        radiusNm: current.airportRadiusNm,
        minimumRunwayFt: current.airportMinimumRunwayFt
      });

      const updatedAt = new Date().toISOString();
      await this.settings.update({
        mapAirports: items,
        mapAirportsUpdatedAt: updatedAt
      });

      const summary = this.summarise(items, {
        latitude,
        longitude,
        radiusNm: current.airportRadiusNm,
        minimumRunwayFt: current.airportMinimumRunwayFt,
        updatedAt
      });
      this.logger.info({ ...summary }, "Airport dataset rebuilt");
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * A bounded read rather than `response.text()`: the server is asking a URL an
   * operator typed for an unknown number of bytes, and the answer has to be
   * allowed to be "too many" without taking the process down with it.
   */
  private async download(url: string, what: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: { accept: "text/csv, text/plain" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
    } catch (error) {
      throw new AirportImportError(
        `Could not reach the ${what} file at ${url}: ${
          error instanceof Error ? error.message : "the request failed"
        }`,
        "AIRPORT_DOWNLOAD_FAILED"
      );
    }
    if (!response.ok) {
      throw new AirportImportError(
        `The ${what} file at ${url} returned ${response.status}`,
        "AIRPORT_DOWNLOAD_FAILED"
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAXIMUM_DOWNLOAD_BYTES) {
      throw new AirportImportError(
        `The ${what} file is ${Math.round(declared / 1_000_000)} MB, over the ${
          MAXIMUM_DOWNLOAD_BYTES / 1_000_000
        } MB limit`,
        "AIRPORT_DOWNLOAD_FAILED"
      );
    }
    if (!response.body) {
      throw new AirportImportError(
        `The ${what} file returned no content`,
        "AIRPORT_DOWNLOAD_FAILED"
      );
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAXIMUM_DOWNLOAD_BYTES) {
        throw new AirportImportError(
          `The ${what} file exceeded the ${
            MAXIMUM_DOWNLOAD_BYTES / 1_000_000
          } MB download limit`,
          "AIRPORT_DOWNLOAD_FAILED"
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private summarise(
    items: readonly Airport[],
    context: {
      latitude: number;
      longitude: number;
      radiusNm: number;
      minimumRunwayFt: number;
      updatedAt: string;
    }
  ): AirportImportSummary {
    const body = JSON.stringify({ items });
    return {
      airports: items.length,
      runways: items.reduce((total, airport) => total + airport.runways.length, 0),
      byRank: {
        large: items.filter((airport) => airport.rank === 3).length,
        medium: items.filter((airport) => airport.rank === 2).length,
        small: items.filter((airport) => airport.rank === 1).length
      },
      payloadBytes: Buffer.byteLength(body),
      gzippedBytes: gzipSync(Buffer.from(body)).byteLength,
      centre: { latitude: context.latitude, longitude: context.longitude },
      radiusNm: context.radiusNm,
      minimumRunwayFt: context.minimumRunwayFt,
      updatedAt: context.updatedAt
    };
  }
}
