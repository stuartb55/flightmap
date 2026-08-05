import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import {
  airportSchema,
  calculateRangeAndBearing,
  type Airport,
  type AirportRunway
} from "@flightmap/shared";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { AppSettingsService } from "./settings.js";

/**
 * Builds the `mapAirports` setting from an OurAirports CSV export.
 *
 * Build time, never runtime: the application never fetches airport data while
 * it is serving, exactly as it never fetches aircraft metadata. An operator
 * runs this when they want the dataset refreshed, and the result is a settings
 * row like any other.
 *
 * Determinism is a requirement, not a nicety — the same inputs and options must
 * produce byte-identical output so a regenerated dataset is a reviewable diff
 * rather than a reshuffle. Everything below is therefore sorted explicitly and
 * every number is rounded to a fixed precision.
 *
 * Usage:
 *   npm run airports:build -- --airports ./airports.csv --runways ./runways.csv
 *
 * Options:
 *   --airports PATH    OurAirports `airports.csv` (required)
 *   --runways PATH     OurAirports `runways.csv` (optional; no centrelines
 *                      without it)
 *   --latitude N       Centre of the radius. Defaults to the configured
 *                      receiver position.
 *   --longitude N
 *   --radius-nm N      Default 250.
 *   --min-runway-ft N  Keep a small airport only if it has a runway at least
 *                      this long. Default 3281 (1,000 m).
 *   --dry-run          Print the summary without writing the setting.
 */

interface Options {
  airportsPath: string;
  runwaysPath: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusNm: number;
  minimumRunwayFt: number;
  dryRun: boolean;
}

class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    airportsPath: "",
    runwaysPath: null,
    latitude: null,
    longitude: null,
    radiusNm: 250,
    minimumRunwayFt: 3_281,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const requireValue = (): string => {
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return value;
    };
    const requireNumber = (): number => {
      const parsed = Number(requireValue());
      if (!Number.isFinite(parsed)) throw new UsageError(`${flag} needs a number`);
      return parsed;
    };
    switch (flag) {
      case "--airports":
        options.airportsPath = requireValue();
        break;
      case "--runways":
        options.runwaysPath = requireValue();
        break;
      case "--latitude":
        options.latitude = requireNumber();
        break;
      case "--longitude":
        options.longitude = requireNumber();
        break;
      case "--radius-nm":
        options.radiusNm = requireNumber();
        break;
      case "--min-runway-ft":
        options.minimumRunwayFt = requireNumber();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new UsageError(`Unrecognised option ${flag}`);
    }
  }
  if (!options.airportsPath) throw new UsageError("--airports is required");
  if (options.radiusNm <= 0 || options.radiusNm > 3_000) {
    throw new UsageError("--radius-nm must be between 0 and 3000");
  }
  if ((options.latitude === null) !== (options.longitude === null)) {
    throw new UsageError("--latitude and --longitude go together");
  }
  return options;
}

/**
 * RFC 4180 enough for OurAirports, which quotes any field containing a comma
 * and escapes a quote by doubling it. A general CSV library would be a
 * dependency for one file read at build time.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A trailing newline keeps the final row from needing a special case.
  const input = text.endsWith("\n") ? text : `${text}\n`;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      field = "";
      // Ignore the blank row a trailing newline would otherwise produce.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (character !== "\r") {
      field += character;
    }
  }
  return rows;
}

/** Header-keyed records, so a column order change upstream cannot silently shift fields. */
export function csvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Six decimal places is about 10 cm — far finer than a threshold coordinate is
 * surveyed to, and enough that the value is stable across runs rather than
 * carrying float noise into the diff.
 */
function coordinate(value: number): number {
  return Number(value.toFixed(6));
}

const RANK_BY_TYPE: Record<string, number> = {
  large_airport: 3,
  medium_airport: 2,
  small_airport: 1
};

/**
 * Which airports are worth drawing.
 *
 * Radius alone pulls in every grass strip and private helipad in the area,
 * which is noise on the map and most of the payload. Large and medium airports
 * are kept unconditionally — those are the ones traffic is going to — and a
 * small airport only earns its place if it has a runway long enough to be
 * somewhere an aircraft this receiver hears would actually land. Heliports,
 * seaplane bases and closed fields are always excluded.
 */
export function selectAirports(
  airportRows: ReadonlyArray<Record<string, string>>,
  runwayRows: ReadonlyArray<Record<string, string>>,
  options: Pick<Options, "radiusNm" | "minimumRunwayFt"> & {
    latitude: number;
    longitude: number;
  }
): Airport[] {
  const runwaysByAirport = new Map<string, AirportRunway[]>();
  const lengthByAirport = new Map<string, number>();
  for (const row of runwayRows) {
    const reference = row.airport_ident?.trim();
    if (!reference) continue;
    const lengthFt = optionalNumber(row.length_ft);
    if (lengthFt !== null && lengthFt > 0) {
      lengthByAirport.set(
        reference,
        Math.max(lengthByAirport.get(reference) ?? 0, lengthFt)
      );
    }
    // A closed runway is still on the chart but is not somewhere anything
    // lands, so it should not be drawn as if it were.
    if (row.closed?.trim() === "1") continue;
    const lowLatitude = optionalNumber(row.le_latitude_deg);
    const lowLongitude = optionalNumber(row.le_longitude_deg);
    const highLatitude = optionalNumber(row.he_latitude_deg);
    const highLongitude = optionalNumber(row.he_longitude_deg);
    // Without both thresholds there is no centreline to draw. The airport
    // itself still counts; it just gets no runway.
    if (
      lowLatitude === null ||
      lowLongitude === null ||
      highLatitude === null ||
      highLongitude === null
    ) {
      continue;
    }
    const low = row.le_ident?.trim() || "?";
    const high = row.he_ident?.trim() || "?";
    const runways = runwaysByAirport.get(reference) ?? [];
    runways.push({
      ident: `${low}/${high}`.slice(0, 16),
      lengthFt: lengthFt !== null && lengthFt > 0 ? Math.round(lengthFt) : null,
      lowLatitude: coordinate(lowLatitude),
      lowLongitude: coordinate(lowLongitude),
      highLatitude: coordinate(highLatitude),
      highLongitude: coordinate(highLongitude)
    });
    runwaysByAirport.set(reference, runways);
  }

  const selected: Airport[] = [];
  for (const row of airportRows) {
    const rank = RANK_BY_TYPE[row.type?.trim() ?? ""];
    if (rank === undefined) continue;
    const latitude = optionalNumber(row.latitude_deg);
    const longitude = optionalNumber(row.longitude_deg);
    if (latitude === null || longitude === null) continue;
    const { distanceNm } = calculateRangeAndBearing(
      options.latitude,
      options.longitude,
      latitude,
      longitude
    );
    if (distanceNm > options.radiusNm) continue;
    const ident = row.ident?.trim();
    if (!ident) continue;
    if (rank === 1 && (lengthByAirport.get(ident) ?? 0) < options.minimumRunwayFt) {
      continue;
    }
    const icao = (row.icao_code?.trim() || ident).slice(0, 8);
    const iata = row.iata_code?.trim() ?? "";
    const runways = (runwaysByAirport.get(ident) ?? []).sort((left, right) =>
      left.ident.localeCompare(right.ident, "en")
    );
    selected.push(
      airportSchema.parse({
        icao,
        iata: iata.length === 3 ? iata.toUpperCase() : null,
        name: (row.name?.trim() || icao).slice(0, 80),
        latitude: coordinate(latitude),
        longitude: coordinate(longitude),
        elevationFt: (() => {
          const elevation = optionalNumber(row.elevation_ft);
          return elevation === null ? null : Math.round(elevation);
        })(),
        rank,
        runways: runways.slice(0, 16)
      })
    );
  }
  // Sorted by ICAO so the same inputs always produce the same bytes. The map
  // decides drawing order from `rank`, not from position in this array.
  return selected.sort((left, right) => left.icao.localeCompare(right.icao, "en"));
}

/**
 * The database is opened only when it is actually needed — to read the receiver
 * position as the centre, or to write the result. A dry run with an explicit
 * centre is then a pure file-in, summary-out operation, which is what makes it
 * usable for checking a radius or a runway threshold before committing to one.
 */
async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const needsDatabase =
    !options.dryRun || options.latitude === null || options.longitude === null;
  const database = needsDatabase ? new Database(loadConfig()) : null;
  try {
    let latitude = options.latitude;
    let longitude = options.longitude;
    let settings: AppSettingsService | null = null;
    if (database) {
      settings = new AppSettingsService(database);
      const current = await settings.load();
      latitude ??= current.settings.receiverLatitude;
      longitude ??= current.settings.receiverLongitude;
    }
    if (latitude === null || longitude === null) {
      throw new UsageError(
        "No centre for the radius: configure the receiver position, or pass --latitude and --longitude"
      );
    }
    const [airportsCsv, runwaysCsv] = await Promise.all([
      readFile(options.airportsPath, "utf8"),
      options.runwaysPath ? readFile(options.runwaysPath, "utf8") : ""
    ]);
    const items = selectAirports(
      csvRecords(airportsCsv),
      runwaysCsv ? csvRecords(runwaysCsv) : [],
      { ...options, latitude, longitude }
    );
    const body = JSON.stringify({ items });
    const summary = {
      airports: items.length,
      runways: items.reduce((total, airport) => total + airport.runways.length, 0),
      byRank: {
        large: items.filter((airport) => airport.rank === 3).length,
        medium: items.filter((airport) => airport.rank === 2).length,
        small: items.filter((airport) => airport.rank === 1).length
      },
      payloadBytes: Buffer.byteLength(body),
      gzippedBytes: gzipSync(Buffer.from(body)).byteLength,
      centre: { latitude, longitude },
      radiusNm: options.radiusNm,
      minimumRunwayFt: options.minimumRunwayFt,
      written: !options.dryRun,
      /*
       * This writes the settings row directly, which is what lets it run while
       * the application is stopped. A running application holds its settings in
       * memory and only reloads them at boot or when it applies a change of its
       * own, so it keeps serving the previous dataset until it is restarted.
       * Saying so here is cheaper than an operator wondering why the map has
       * not changed.
       */
      ...(options.dryRun
        ? {}
        : { note: "Restart the application for a running instance to serve this" })
    };
    if (settings && !options.dryRun) await settings.update({ mapAirports: items });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await database?.close();
  }
}

// Importable for tests; only the direct invocation touches the database.
if (process.argv[1]?.includes("airports-cli")) {
  try {
    await main();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
