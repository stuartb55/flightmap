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
  routeLookupUrl: httpUrlSchema,
  routeLookupTimeoutMs: z.number().int().min(500).max(30_000),
  routeLookupTtlHours: z.number().int().min(1).max(8_760),
  routeLookupNegativeTtlHours: z.number().int().min(1).max(8_760),
  /**
   * Where aircraft photographs come from, and how long they are kept.
   *
   * Shipped empty, like `metadataUrl` and `airportDataUrl` before it: this
   * application cannot verify anyone's licence terms, so pretending to by
   * naming a vendor in code buys nothing. What it can do is refuse to fetch
   * anything until an operator configures a URL and refuse to ship pointing at
   * a third party by default. Which source a deployment uses, and whether its
   * terms permit redisplay and caching, is recorded by that operator in
   * `docs/photos.md`.
   *
   * Empty is a meaningful value here and not a URL, so this is a union rather
   * than `httpUrlSchema` — validated as http or https only once it is set.
   *
   * The download's own safety limits are fixed in `services/aircraft-photos.ts`
   * for the reason the airport import gives: nobody should have to reason
   * about a byte cap.
   */
  aircraftPhotoSourceUrl: z.union([z.literal(""), httpUrlSchema]),
  aircraftPhotoTtlDays: z.number().int().min(1).max(365),
  aircraftPhotoNegativeTtlDays: z.number().int().min(1).max(365),
  aircraftPhotoCacheEntries: z.number().int().min(0).max(100_000),
  collectorEnabled: z.boolean(),
  maintenanceEnabled: z.boolean(),
  metadataUpdatesEnabled: z.boolean(),
  routeLookupEnabled: z.boolean(),
  aircraftPhotosEnabled: z.boolean()
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
  /*
   * `{callsign}` is substituted. Off by default and left to the operator to
   * turn on, because it is the one part of this application that talks to a
   * third party about what the receiver is hearing, on a box otherwise built to
   * stay on the LAN.
   */
  routeLookupUrl: "https://api.adsbdb.com/v0/callsign/{callsign}",
  routeLookupTimeoutMs: 4_000,
  routeLookupTtlHours: 24 * 14,
  routeLookupNegativeTtlHours: 24 * 3,
  /*
   * Empty, not a vendor. The route lookup above names one because adsbdb
   * publishes terms this project can point at; nothing comparable exists for
   * photographs, where the licence attaches to each image and to the
   * photographer rather than to the API. An operator who wants photographs
   * chooses a source, records its terms in `docs/photos.md`, and puts the URL
   * here — with `{icao}` substituted. Until then nothing is fetched, which is
   * also what the empty string means to the service.
   */
  aircraftPhotoSourceUrl: "",
  aircraftPhotoTtlDays: 30,
  aircraftPhotoNegativeTtlDays: 7,
  /*
   * At the 200 kB per-image cap this is a 400 MB worst case against the 40 GB
   * floor in `docs/disk-sizing.md`, and a realistic case a good deal smaller —
   * a thumbnail from a photo API is tens of kilobytes.
   */
  aircraftPhotoCacheEntries: 2_000,
  collectorEnabled: true,
  maintenanceEnabled: true,
  metadataUpdatesEnabled: true,
  routeLookupEnabled: false,
  aircraftPhotosEnabled: false
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
  /*
   * The live config objects handed out by `runtimeConfig`, updated in place
   * when settings change. There is deliberately no removal path: a runtime
   * config is built once at startup and lives as long as the process, so
   * anything that could unregister one would be dead code. The CLIs build one
   * each and then exit.
   */
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
