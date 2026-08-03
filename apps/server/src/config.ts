import { resolve } from "node:path";
import { z } from "zod";
import {
  defaultAppSettings,
  type AppSettings
} from "./settings.js";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const commaSeparatedSchema = (defaultValue: string) => z
  .string()
  .default(defaultValue)
  .transform((value) =>
    [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))]
  );
const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_HOST: z.string().default("0.0.0.0"),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    APP_VERSION: z.string().default("0.1.0"),
    APP_ALLOWED_HOSTS: commaSeparatedSchema(
      "localhost,127.0.0.1,[::1]"
    ),
    APP_ALLOWED_ORIGINS: commaSeparatedSchema(""),
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
      .default(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
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
    WEB_DIST_DIR: z
      .string()
      .default(resolve(process.cwd(), "../web/dist")),
    SERVE_WEB: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    // Fixed-window request budgets per client address. The defaults are sized
    // for interactive browser use; automated suites that drive the API hard
    // from one address (the end-to-end and load runs in CI share a bucket)
    // raise them rather than measuring the limiter instead of the server.
    RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    API_RATE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(300),
    MUTATION_RATE_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(90),
    WEBSOCKET_RATE_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(30),
    // "false" (default), "true", or a comma-separated list of trusted proxy
    // addresses/CIDRs. Without this every client behind a reverse proxy shares
    // one rate-limit bucket, because request.ip is the proxy's address.
    APP_TRUST_PROXY: z
      .string()
      .default("false")
      .transform((value): boolean | string =>
        value.trim() === "true"
          ? true
          : value.trim() === "false" || value.trim() === ""
            ? false
            : value.trim()
      )
  })
  .superRefine((config, context) => {
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

type BootConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  version: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  databaseConnectionTimeoutMs: number;
  databaseStatementTimeoutMs: number;
  databaseSsl: boolean;
  databaseSslCaFile: string | null;
  webDistDir: string;
  serveWeb: boolean;
  trustProxy: boolean | string;
  rateLimitWindowMs: number;
  apiRateLimit: number;
  mutationRateLimit: number;
  websocketRateLimit: number;
}>;

export type Config = BootConfig & Readonly<AppSettings>;

/**
 * Loads only values required before PostgreSQL and the HTTP server are
 * available. Product behaviour is loaded from application_settings.
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): Config {
  const config = configSchema.parse(environment);
  return {
    nodeEnv: config.NODE_ENV,
    host: config.APP_HOST,
    port: config.APP_PORT,
    version: config.APP_VERSION,
    allowedHosts: config.APP_ALLOWED_HOSTS,
    allowedOrigins: config.APP_ALLOWED_ORIGINS,
    logLevel: config.LOG_LEVEL,
    databaseUrl: config.DATABASE_URL,
    databasePoolMax: config.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: config.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseSsl: config.DATABASE_SSL,
    databaseSslCaFile: config.DATABASE_SSL_CA_FILE
      ? resolve(config.DATABASE_SSL_CA_FILE)
      : null,
    webDistDir: resolve(config.WEB_DIST_DIR),
    serveWeb: config.SERVE_WEB,
    trustProxy: config.APP_TRUST_PROXY,
    rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS,
    apiRateLimit: config.API_RATE_LIMIT,
    mutationRateLimit: config.MUTATION_RATE_LIMIT,
    websocketRateLimit: config.WEBSOCKET_RATE_LIMIT,
    ...defaultAppSettings,
    rangeRingsNm: [...defaultAppSettings.rangeRingsNm],
    mapWaypoints: defaultAppSettings.mapWaypoints.map((waypoint) => ({
      ...waypoint
    }))
  };
}
