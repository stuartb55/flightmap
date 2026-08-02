import { z } from "zod";
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

const settingsShape = {
  receiverBaseUrl: z
    .string()
    .url()
    .max(2_000)
    .transform((value) => value.replace(/\/+$/, "")),
  receiverName: z.string().trim().min(1).max(100),
  receiverLatitude: z.number().min(-90).max(90).nullable(),
  receiverLongitude: z.number().min(-180).max(180).nullable(),
  pollIntervalMs: z.number().int().min(200).max(60_000),
  receiverTimeoutMs: z.number().int().min(100).max(30_000),
  receiverInfoIntervalMs: z.number().int().min(10_000).max(86_400_000),
  receiverStatsIntervalMs: z.number().int().min(10_000).max(86_400_000),
  displayTimeZone: timeZoneSchema,
  mapStyleUrl: z.string().url().max(2_000),
  rangeRingsNm: z
    .array(z.number().positive().max(1_000))
    .min(1)
    .max(20)
    .transform((values) =>
      [...new Set(values)].sort((left, right) => left - right)
    ),
  historyRetentionDays: z.number().int().min(1).max(365),
  sessionGapSeconds: z.number().int().min(60).max(3_600),
  currentAircraftTtlSeconds: z.number().int().min(15).max(3_600),
  metadataUrl: z.string().url().max(2_000),
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
  rangeRingsNm: [5, 10, 25, 50, 100],
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

export class AppSettingsService {
  private current: AppSettings = defaultAppSettings;
  private updatedAt: string | null = null;
  private readonly runtimeConfigs = new Set<Record<string, unknown>>();

  constructor(private readonly database: Database) {}

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
    this.current = appSettingsSchema.parse({
      ...defaultAppSettings,
      ...(row?.settings && typeof row.settings === "object"
        ? row.settings
        : {})
    });
    this.updatedAt = row
      ? new Date(row.updated_at).toISOString()
      : null;
    return this.get();
  }

  get(): SettingsResponse {
    return {
      settings: { ...this.current, rangeRingsNm: [...this.current.rangeRingsNm] },
      updatedAt: this.updatedAt
    };
  }

  runtimeConfig(bootConfig: Config): Config {
    const config = {
      ...bootConfig,
      ...this.current,
      rangeRingsNm: [...this.current.rangeRingsNm]
    };
    this.runtimeConfigs.add(config);
    return config;
  }

  async update(input: unknown): Promise<SettingsResponse> {
    const patch = appSettingsPatchSchema.parse(input);
    const settings = appSettingsSchema.parse({
      ...this.current,
      ...patch
    });
    const result = await this.database.query<{ updated_at: Date | string }>(
      `UPDATE application_settings
       SET settings = $1::jsonb, updated_at = now()
       WHERE id = true
       RETURNING updated_at`,
      [JSON.stringify(settings)]
    );
    this.current = settings;
    this.updatedAt = result.rows[0]
      ? new Date(result.rows[0].updated_at).toISOString()
      : new Date().toISOString();
    for (const config of this.runtimeConfigs) {
      Object.assign(config, settings, {
        rangeRingsNm: [...settings.rangeRingsNm]
      });
    }
    return this.get();
  }
}
