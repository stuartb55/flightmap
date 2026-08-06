import { createHash } from "node:crypto";
import {
  airportSchema,
  isoDateTimeSchema,
  mapWaypointSchema,
  type Airport
} from "@flightmap/shared";
import { z } from "zod";
import { defaultMapAirports } from "./default-airports.js";
import { defaultMapWaypoints } from "./default-waypoints.js";
import type { Config } from "./config.js";
import type { Database } from "./db/database.js";

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid IANA time zone, such as Europe/London");

/** Zod's `.url()` also accepts file:, gopher: and friends. */
const httpUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Enter an http:// or https:// URL");

const settingsShape = {
  receiverBaseUrl: httpUrlSchema.transform((value) =>
    value.replace(/\/+$/, "")
  ),
  receiverName: z.string().trim().min(1).max(100),
  receiverLatitude: z.number().min(-90).max(90).nullable(),
  receiverLongitude: z.number().min(-180).max(180).nullable(),
  pollIntervalMs: z.number().int().min(200).max(60_000),
  receiverTimeoutMs: z.number().int().min(100).max(30_000),
  receiverInfoIntervalMs: z.number().int().min(10_000).max(86_400_000),
  receiverStatsIntervalMs: z.number().int().min(10_000).max(86_400_000),
  displayTimeZone: timeZoneSchema,
  mapStyleUrl: httpUrlSchema,
  mapStyleUrlLight: httpUrlSchema,
  rangeRingsNm: z
    .array(z.number().positive().max(1_000))
    .min(1)
    .max(20)
    .transform((values) =>
      [...new Set(values)].sort((left, right) => left - right)
    ),
  mapWaypoints: z.array(mapWaypointSchema).max(200),
  /**
   * Written by `npm run airports:build`, not by hand. The ceiling is well above
   * what a 250 nm radius produces and is here so a malformed import cannot put
   * an unbounded blob in the settings row.
   */
  mapAirports: z.array(airportSchema).max(4_000),
  /**
   * Where the airport import downloads its two OurAirports exports from, and
   * how much of them to keep. These are the choices worth an operator's
   * attention; the download's own safety limits are fixed in
   * `services/airports.ts` because nobody should have to reason about them.
   */
  airportDataUrl: httpUrlSchema,
  airportRunwayDataUrl: httpUrlSchema,
  airportRadiusNm: z.number().positive().max(1_000),
  airportMinimumRunwayFt: z.number().int().min(0).max(20_000),
  /** When the dataset was last built, so Settings can say. Null until it is. */
  mapAirportsUpdatedAt: isoDateTimeSchema.nullable(),
  historyRetentionDays: z.number().int().min(1).max(365),
  sessionGapSeconds: z.number().int().min(60).max(3_600),
  currentAircraftTtlSeconds: z.number().int().min(15).max(3_600),
  metadataUrl: httpUrlSchema,
  metadataCheckIntervalMs: z.number().int().min(60_000).max(2_592_000_000),
  metadataTimeoutMs: z.number().int().min(1_000).max(300_000),
  metadataMinRows: z.number().int().min(1).max(10_000_000),
  metadataMaxDownloadBytes: z
    .number()
    .int()
    .min(1_000_000)
    .max(500_000_000),
  metadataMaxUncompressedBytes: z
    .number()
    .int()
    .min(5_000_000)
    .max(1_000_000_000),
  databaseVolumeCapacityBytes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  collectorEnabled: z.boolean(),
  maintenanceEnabled: z.boolean(),
  metadataUpdatesEnabled: z.boolean()
};

/**
 * Settings are handed out as copies so a caller cannot mutate what is stored.
 * Airports nest one level deeper than waypoints, so the runway array has to be
 * copied too or the copy shares it.
 */
function cloneAirports(airports: readonly Airport[]): Airport[] {
  return airports.map((airport) => ({
    ...airport,
    runways: airport.runways.map((runway) => ({ ...runway }))
  }));
}

function coordinatesConfiguredTogether(
  settings: {
    receiverLatitude: number | null;
    receiverLongitude: number | null;
  },
  context: z.RefinementCtx
): void {
  if (
    (settings.receiverLatitude === null) !==
    (settings.receiverLongitude === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receiverLatitude"],
      message: "Receiver latitude and longitude must be configured together"
    });
  }
}

export const appSettingsSchema = z
  .object(settingsShape)
  .strict()
  .superRefine(coordinatesConfiguredTogether);

export const appSettingsPatchSchema = z.object(settingsShape).partial().strict();

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsPatch = z.input<typeof appSettingsPatchSchema>;

export const defaultAppSettings: AppSettings = Object.freeze({
  receiverBaseUrl: "http://192.168.1.118:81/data",
  receiverName: "Home receiver",
  receiverLatitude: null,
  receiverLongitude: null,
  pollIntervalMs: 1_000,
  receiverTimeoutMs: 800,
  receiverInfoIntervalMs: 300_000,
  receiverStatsIntervalMs: 60_000,
  displayTimeZone: "Europe/London",
  mapStyleUrl: "https://tiles.openfreemap.org/styles/dark",
  mapStyleUrlLight: "https://tiles.openfreemap.org/styles/bright",
  rangeRingsNm: [5, 10, 25, 50, 100],
  mapWaypoints: [...defaultMapWaypoints],
  mapAirports: [...defaultMapAirports],
  airportDataUrl:
    "https://davidmegginson.github.io/ourairports-data/airports.csv",
  airportRunwayDataUrl:
    "https://davidmegginson.github.io/ourairports-data/runways.csv",
  airportRadiusNm: 250,
  // 1,000 m: a licensed aerodrome clears it, a farm strip does not.
  airportMinimumRunwayFt: 3_281,
  mapAirportsUpdatedAt: null,
  historyRetentionDays: 30,
  sessionGapSeconds: 300,
  currentAircraftTtlSeconds: 60,
  metadataUrl:
    "https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz",
  metadataCheckIntervalMs: 7 * 24 * 60 * 60 * 1_000,
  metadataTimeoutMs: 30_000,
  metadataMinRows: 100_000,
  metadataMaxDownloadBytes: 50_000_000,
  metadataMaxUncompressedBytes: 250_000_000,
  databaseVolumeCapacityBytes: null,
  collectorEnabled: true,
  maintenanceEnabled: true,
  metadataUpdatesEnabled: true
});

export type SettingsResponse = {
  settings: AppSettings;
  updatedAt: string | null;
};

/**
 * Raised when a write arrives before the persisted settings have been read.
 *
 * A patch is merged into whatever this process last read, so applying one on
 * top of the defaults would write those defaults over the operator's real
 * stored configuration the moment the database came back. Boot serves defaults
 * so the application can answer at all; it must not save them.
 */
export class SettingsNotLoadedError extends Error {
  readonly code = "SETTINGS_NOT_LOADED";

  constructor() {
    super(
      "Settings have not been read from the database yet, so they cannot be changed. Check that PostgreSQL is reachable and retry."
    );
    this.name = "SettingsNotLoadedError";
  }
}

export class AppSettingsService {
  private current: AppSettings = defaultAppSettings;
  private updatedAt: string | null = null;
  private loaded = false;
  private readonly runtimeConfigs = new Set<Record<string, unknown>>();
  private airports: { body: string; etag: string } | null = null;

  constructor(private readonly database: Database) {}

  /**
   * The airport dataset as it goes on the wire, serialised once per change
   * rather than once per request. It is the largest thing this service holds
   * and the endpoint serving it is meant to be answered from cache, so the
   * common case should be an ETag comparison and nothing else.
   *
   * The ETag is over the body, so a rebuild that happens to produce identical
   * bytes does not invalidate anyone's cached copy.
   */
  airportsPayload(): { body: string; etag: string } {
    this.airports ??= (() => {
      const body = JSON.stringify({ items: this.current.mapAirports });
      const digest = createHash("sha256").update(body).digest("base64url");
      return { body, etag: `"${digest.slice(0, 27)}"` };
    })();
    return this.airports;
  }

  /** False until persisted settings have been read; boot serves defaults. */
  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<SettingsResponse> {
    const result = await this.database.query<{
      settings: unknown;
      updated_at: Date | string;
    }>(
      `INSERT INTO application_settings (id, settings)
       VALUES (true, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING settings, updated_at`,
      [JSON.stringify(defaultAppSettings)]
    );
    const row = result.rows[0];
    this.apply(
      appSettingsSchema.parse({
        ...defaultAppSettings,
        ...(row?.settings && typeof row.settings === "object"
          ? row.settings
          : {})
      })
    );
    this.updatedAt = row
      ? new Date(row.updated_at).toISOString()
      : null;
    this.loaded = true;
    return this.get();
  }

  get(): SettingsResponse {
    return {
      settings: {
        ...this.current,
        rangeRingsNm: [...this.current.rangeRingsNm],
        mapWaypoints: this.current.mapWaypoints.map((waypoint) => ({ ...waypoint })),
        mapAirports: cloneAirports(this.current.mapAirports)
      },
      updatedAt: this.updatedAt
    };
  }

  runtimeConfig(bootConfig: Config): Config {
    const config = {
      ...bootConfig,
      ...this.current,
      rangeRingsNm: [...this.current.rangeRingsNm],
      mapWaypoints: this.current.mapWaypoints.map((waypoint) => ({ ...waypoint })),
      mapAirports: cloneAirports(this.current.mapAirports)
    };
    this.runtimeConfigs.add(config);
    return config;
  }

  async update(input: unknown): Promise<SettingsResponse> {
    if (!this.loaded) throw new SettingsNotLoadedError();
    const patch = appSettingsPatchSchema.parse(input);
    const settings = appSettingsSchema.parse({
      ...this.current,
      ...patch
    });
    /*
     * An upsert, and the returned row is checked. `load()` creates the row, so
     * the insert is unreachable in practice — but a bare UPDATE that matches
     * nothing reports success, and this is the write an operator has just been
     * told took effect. It must not be possible to lose it quietly.
     */
    const result = await this.database.query<{ updated_at: Date | string }>(
      `INSERT INTO application_settings (id, settings)
       VALUES (true, $1::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET settings = EXCLUDED.settings, updated_at = now()
       RETURNING updated_at`,
      [JSON.stringify(settings)]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Settings were not written; the settings row is missing");
    }
    this.apply(settings);
    this.updatedAt = new Date(row.updated_at).toISOString();
    return this.get();
  }

  /** Runtime configs are handed out as live objects and updated in place. */
  private apply(settings: AppSettings): void {
    this.current = settings;
    this.airports = null;
    for (const config of this.runtimeConfigs) {
      Object.assign(config, settings, {
        rangeRingsNm: [...settings.rangeRingsNm],
        mapWaypoints: settings.mapWaypoints.map((waypoint) => ({ ...waypoint })),
        mapAirports: cloneAirports(settings.mapAirports)
      });
    }
  }
}
