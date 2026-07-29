import { resolve } from "node:path";
import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalNumber = z.preprocess(
  emptyToUndefined,
  z.coerce.number().finite().optional()
);
const rangeRingsSchema = z
  .string()
  .default("5,10,25,50,100")
  .transform((value, context) => {
    const rings = value.split(",").map((part) => Number(part.trim()));
    if (
      rings.length === 0 ||
      rings.some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 1000
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RANGE_RINGS_NM must contain positive values up to 1000"
      });
      return z.NEVER;
    }
    return [...new Set(rings)].sort((left, right) => left - right);
  });
const commaSeparatedSchema = z
  .string()
  .transform((value) =>
    [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))]
  );
const optionalSecret = z.preprocess(
  emptyToUndefined,
  z.string().min(16).max(1024).optional()
);
const optionalPositiveInteger = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().positive().optional()
);

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_HOST: z.string().default("0.0.0.0"),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    APP_VERSION: z.string().default("0.1.0"),
    APP_ALLOWED_HOSTS: commaSeparatedSchema.default(
      "localhost,127.0.0.1,[::1]"
    ),
    APP_ALLOWED_ORIGINS: commaSeparatedSchema.default(""),
    APP_ACCESS_TOKEN: optionalSecret,
    APP_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://flightmap:flightmap@localhost:5432/flightmap"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .default(60_000),
    DATABASE_SSL: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DATABASE_SSL_CA_FILE: z.preprocess(
      emptyToUndefined,
      z.string().optional()
    ),
    DATABASE_VOLUME_CAPACITY_BYTES: optionalPositiveInteger,
    RECEIVER_BASE_URL: z
      .string()
      .url()
      .default("http://192.168.1.118:81/data"),
    POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1000),
    RECEIVER_INFO_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .default(300_000),
    RECEIVER_STATS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .default(60_000),
    RECEIVER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(1500),
    RECEIVER_LAT: optionalNumber.pipe(
      z.number().min(-90).max(90).optional()
    ),
    RECEIVER_LON: optionalNumber.pipe(
      z.number().min(-180).max(180).optional()
    ),
    HISTORY_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    DISPLAY_TIME_ZONE: z.string().default("Europe/London"),
    MAP_STYLE_URL: z
      .string()
      .url()
      .default("https://tiles.openfreemap.org/styles/dark"),
    RECEIVER_NAME: z.string().trim().min(1).max(100).default("Home receiver"),
    RANGE_RINGS_NM: rangeRingsSchema,
    CURRENT_AIRCRAFT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(15)
      .max(3600)
      .default(60),
    SESSION_GAP_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(300),
    METADATA_URL: z
      .string()
      .url()
      .default(
        "https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz"
      ),
    METADATA_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(7 * 24 * 60 * 60 * 1000),
    METADATA_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(60_000),
    METADATA_MIN_ROWS: z.coerce.number().int().min(1).default(100_000),
    METADATA_MAX_DOWNLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(500_000_000)
      .default(50_000_000),
    METADATA_MAX_UNCOMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .min(5_000_000)
      .max(1_000_000_000)
      .default(250_000_000),
    FIRST_SEEN_ALERTS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    FIRST_SEEN_ALERT_BASELINE_HOURS: z.coerce
      .number()
      .int()
      .min(0)
      .max(720)
      .default(24),
    WEB_DIST_DIR: z
      .string()
      .default(resolve(process.cwd(), "../web/dist")),
    SERVE_WEB: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    COLLECTOR_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    MAINTENANCE_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    METADATA_UPDATES_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true")
  })
  .superRefine((config, context) => {
    const oneCoordinate =
      (config.RECEIVER_LAT === undefined) !==
      (config.RECEIVER_LON === undefined);
    if (oneCoordinate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RECEIVER_LAT"],
        message: "RECEIVER_LAT and RECEIVER_LON must be configured together"
      });
    }
    if (
      config.NODE_ENV === "production" &&
      config.DATABASE_URL.includes("replace-with-a-long-random-password")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message:
          "DATABASE_URL still contains the placeholder password; configure a unique production password"
      });
    }
    if (
      config.NODE_ENV === "production" &&
      (!config.APP_ACCESS_TOKEN ||
        config.APP_ACCESS_TOKEN.includes("replace-with"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_ACCESS_TOKEN"],
        message:
          "APP_ACCESS_TOKEN must be set to a unique secret in production"
      });
    }
    if (
      config.APP_ALLOWED_HOSTS.includes("*") &&
      config.NODE_ENV === "production"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_ALLOWED_HOSTS"],
        message: "APP_ALLOWED_HOSTS cannot contain * in production"
      });
    }
  });

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  version: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  accessToken: string | null;
  sessionHours: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  databaseConnectionTimeoutMs: number;
  databaseStatementTimeoutMs: number;
  databaseSsl: boolean;
  databaseSslCaFile: string | null;
  databaseVolumeCapacityBytes: number | null;
  receiverBaseUrl: string;
  pollIntervalMs: number;
  receiverInfoIntervalMs: number;
  receiverStatsIntervalMs: number;
  receiverTimeoutMs: number;
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  historyRetentionDays: number;
  displayTimeZone: string;
  mapStyleUrl: string;
  receiverName: string;
  rangeRingsNm: readonly number[];
  currentAircraftTtlSeconds: number;
  sessionGapSeconds: number;
  metadataUrl: string;
  metadataCheckIntervalMs: number;
  metadataTimeoutMs: number;
  metadataMinRows: number;
  metadataMaxDownloadBytes: number;
  metadataMaxUncompressedBytes: number;
  firstSeenAlertsEnabled: boolean;
  firstSeenAlertBaselineHours: number;
  webDistDir: string;
  serveWeb: boolean;
  collectorEnabled: boolean;
  maintenanceEnabled: boolean;
  metadataUpdatesEnabled: boolean;
}>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): Config {
  const config = configSchema.parse(environment);
  return Object.freeze({
    nodeEnv: config.NODE_ENV,
    host: config.APP_HOST,
    port: config.APP_PORT,
    version: config.APP_VERSION,
    allowedHosts: config.APP_ALLOWED_HOSTS,
    allowedOrigins: config.APP_ALLOWED_ORIGINS,
    accessToken: config.APP_ACCESS_TOKEN ?? null,
    sessionHours: config.APP_SESSION_HOURS,
    logLevel: config.LOG_LEVEL,
    databaseUrl: config.DATABASE_URL,
    databasePoolMax: config.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: config.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseSsl: config.DATABASE_SSL,
    databaseSslCaFile: config.DATABASE_SSL_CA_FILE
      ? resolve(config.DATABASE_SSL_CA_FILE)
      : null,
    databaseVolumeCapacityBytes:
      config.DATABASE_VOLUME_CAPACITY_BYTES ?? null,
    receiverBaseUrl: config.RECEIVER_BASE_URL.replace(/\/+$/, ""),
    pollIntervalMs: config.POLL_INTERVAL_MS,
    receiverInfoIntervalMs: config.RECEIVER_INFO_INTERVAL_MS,
    receiverStatsIntervalMs: config.RECEIVER_STATS_INTERVAL_MS,
    receiverTimeoutMs: config.RECEIVER_TIMEOUT_MS,
    receiverLatitude: config.RECEIVER_LAT ?? null,
    receiverLongitude: config.RECEIVER_LON ?? null,
    historyRetentionDays: config.HISTORY_RETENTION_DAYS,
    displayTimeZone: config.DISPLAY_TIME_ZONE,
    mapStyleUrl: config.MAP_STYLE_URL,
    receiverName: config.RECEIVER_NAME,
    rangeRingsNm: config.RANGE_RINGS_NM,
    currentAircraftTtlSeconds: config.CURRENT_AIRCRAFT_TTL_SECONDS,
    sessionGapSeconds: config.SESSION_GAP_SECONDS,
    metadataUrl: config.METADATA_URL,
    metadataCheckIntervalMs: config.METADATA_CHECK_INTERVAL_MS,
    metadataTimeoutMs: config.METADATA_TIMEOUT_MS,
    metadataMinRows: config.METADATA_MIN_ROWS,
    metadataMaxDownloadBytes: config.METADATA_MAX_DOWNLOAD_BYTES,
    metadataMaxUncompressedBytes: config.METADATA_MAX_UNCOMPRESSED_BYTES,
    firstSeenAlertsEnabled: config.FIRST_SEEN_ALERTS_ENABLED,
    firstSeenAlertBaselineHours: config.FIRST_SEEN_ALERT_BASELINE_HOURS,
    webDistDir: resolve(config.WEB_DIST_DIR),
    serveWeb: config.SERVE_WEB,
    collectorEnabled: config.COLLECTOR_ENABLED,
    maintenanceEnabled: config.MAINTENANCE_ENABLED,
    metadataUpdatesEnabled: config.METADATA_UPDATES_ENABLED
  });
}
