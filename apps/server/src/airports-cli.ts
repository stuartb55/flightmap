import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { csvRecords, selectAirports } from "./domain/airports.js";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { AppSettingsService } from "./settings.js";

/**
 * Builds the `mapAirports` setting from local OurAirports CSV files.
 *
 * The normal way to do this is the Airports card on the Settings page, which
 * downloads the same files and applies the result to the running application
 * immediately. This exists for the case that cannot: a receiver with no
 * internet access, where the files have to be carried in by hand.
 *
 * Both paths share `domain/airports.ts`, so they select identically.
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
        : {
            note: "Restart the application to serve this, or use the Settings page instead, which applies immediately"
          })
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
