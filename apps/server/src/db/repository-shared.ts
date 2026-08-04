import type {
  AircraftMetadata,
  AlertEvent,
  CustomAlertRule,
  InsightMetrics,
  LiveAircraft,
  SavedView,
  SavedViewConfiguration,
  TrackResponse,
  TrackSession
} from "@flightmap/shared";
import { savedViewSchema } from "@flightmap/shared";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "./database.js";

export type RepositoryConfig = Pick<
  Config,
  "sessionGapSeconds" | "currentAircraftTtlSeconds" | "historyRetentionDays"
>;

/** Shared connection and configuration for every domain repository. */
export class RepositoryBase {
  constructor(
    protected readonly database: Database,
    protected readonly config: RepositoryConfig
  ) {}
}

export type IngestionResult = {
  upserts: LiveAircraft[];
  alerts: AlertEvent[];
};

export type CurrentContextRow = {
  icao: string;
  session_id: string | null;
  last_position_at: Date | string | null;
  last_altitude_ft: number | null;
  state: LiveAircraft;
};

export type MetadataRow = {
  icao: string;
  registration: string | null;
  type_code: string | null;
  description: string | null;
  operator: string | null;
  owner: string | null;
  country: string | null;
};

export type AlertRow = {
  id: string;
  icao: string;
  session_id: string | null;
  rule: AlertEvent["rule"];
  state: string | null;
  message: string;
  severity: AlertEvent["severity"];
  occurred_at: Date | string;
  dismissed_at: Date | string | null;
  callsign: string | null;
};

export type SavedViewRow = {
  id: string;
  name: string;
  surface: SavedView["surface"];
  configuration: SavedViewConfiguration;
  created_at: Date | string;
  updated_at: Date | string;
};

export type CustomAlertRuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  severity: CustomAlertRule["severity"];
  callsign_prefix: string | null;
  icao: string | null;
  operator: string | null;
  type_code: string | null;
  minimum_altitude_ft: number | null;
  maximum_altitude_ft: number | null;
  minimum_distance_nm: number | null;
  maximum_distance_nm: number | null;
  cooldown_minutes: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SessionRow = {
  id: string;
  icao: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  last_position_at: Date | string;
  callsigns: string[];
  sample_count: number | string;
  minimum_altitude_ft: number | null;
  maximum_altitude_ft: number | null;
  minimum_ground_speed_kt: number | null;
  maximum_ground_speed_kt: number | null;
  closest_range_nm: number | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_altitude_ft: number | null;
  detailed_track_available?: boolean;
  alert_rules?: AlertEvent["rule"][];
  metadata_icao?: string | null;
  registration?: string | null;
  type_code?: string | null;
  description?: string | null;
  operator?: string | null;
  owner?: string | null;
  country?: string | null;
};

/**
 * The one place ICAO addresses are canonicalised. Values reaching this from
 * position_samples are still `char(6)`, so the trim stays; every other table
 * stores `text` (migration 013).
 */
export function normaliseIcao(value: string): string {
  return value.trim().toLowerCase();
}

export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function utcDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}/.test(value)
      ? value.slice(0, 10)
      : new Date(value).toISOString().slice(0, 10);
}

export function number(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : number(value);
}

export type RangeAltitudeBand = "ground" | "low" | "medium" | "high";
export function rangeAltitudeBand(onGround: boolean, altitude: number | null): RangeAltitudeBand {
  if (onGround) return "ground";
  if (altitude === null || altitude < 10_000) return "low";
  if ((altitude ?? 0) < 25_000) return "medium";
  return "high";
}

export type InsightAggregateRow = {
  unique_aircraft: number | string;
  sessions: number | string;
  reports: number | string;
  positioned_reports: number | string;
  maximum_range_nm: number | string | null;
  maximum_altitude_ft: number | string | null;
};

export type InsightSeriesRow = InsightAggregateRow & {
  bucket_start: Date | string;
  bucket_end: Date | string;
};

export type ReceiverInsightRow = {
  bucket_start: Date | string;
  samples: number | string;
  available_samples: number | string;
  message_rate_per_second: number | string | null;
  rejected_records: number | string | null;
};

export function insightMetricsFromRow(row: InsightAggregateRow | undefined): InsightMetrics {
  return {
    uniqueAircraft: row ? number(row.unique_aircraft) : 0,
    sessions: row ? number(row.sessions) : 0,
    reports: row ? number(row.reports) : 0,
    positionedReports: row ? number(row.positioned_reports) : 0,
    maximumRangeNm: row ? nullableNumber(row.maximum_range_nm) : null,
    maximumAltitudeFt: row ? nullableNumber(row.maximum_altitude_ft) : null
  };
}

export function metadataFromRow(row: MetadataRow | SessionRow): AircraftMetadata | null {
  const icao =
    "metadata_icao" in row ? row.metadata_icao : (row as MetadataRow).icao;
  if (!icao) return null;
  return {
    icao: normaliseIcao(icao),
    registration: row.registration ?? null,
    typeCode: row.type_code ?? null,
    description: row.description ?? null,
    operator: row.operator ?? null,
    owner: row.owner ?? null,
    country: row.country ?? null
  };
}

export function alertFromRow(row: AlertRow): AlertEvent {
  return {
    id: row.id,
    icao: normaliseIcao(row.icao),
    sessionId: row.session_id,
    rule: row.rule,
    state: row.state,
    message: row.message,
    severity: row.severity,
    occurredAt: iso(row.occurred_at),
    dismissedAt: row.dismissed_at ? iso(row.dismissed_at) : null,
    callsign: row.callsign
  };
}

export function customAlertRuleFromRow(row: CustomAlertRuleRow): CustomAlertRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    severity: row.severity,
    callsignPrefix: row.callsign_prefix,
    icao: row.icao ? normaliseIcao(row.icao) : null,
    operator: row.operator,
    typeCode: row.type_code,
    minimumAltitudeFt: row.minimum_altitude_ft,
    maximumAltitudeFt: row.maximum_altitude_ft,
    minimumDistanceNm: row.minimum_distance_nm,
    maximumDistanceNm: row.maximum_distance_nm,
    cooldownMinutes: row.cooldown_minutes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function customRuleMatches(
  rule: CustomAlertRule,
  aircraft: LiveAircraft,
  altitude: number | null
): boolean {
  const callsign = aircraft.callsign?.trim().toLowerCase() ?? "";
  const operator = aircraft.metadata?.operator?.toLowerCase() ?? "";
  const typeCode = aircraft.metadata?.typeCode?.toLowerCase() ?? "";
  return (!rule.callsignPrefix || callsign.startsWith(rule.callsignPrefix.toLowerCase()))
    && (!rule.icao || aircraft.icao === rule.icao)
    && (!rule.operator || operator.includes(rule.operator.toLowerCase()))
    && (!rule.typeCode || typeCode === rule.typeCode.toLowerCase())
    && (rule.minimumAltitudeFt == null || (altitude != null && altitude >= rule.minimumAltitudeFt))
    && (rule.maximumAltitudeFt == null || (altitude != null && altitude <= rule.maximumAltitudeFt))
    && (rule.minimumDistanceNm == null || (aircraft.distanceNm != null && aircraft.distanceNm >= rule.minimumDistanceNm))
    && (rule.maximumDistanceNm == null || (aircraft.distanceNm != null && aircraft.distanceNm <= rule.maximumDistanceNm));
}

export function savedViewFromRow(row: SavedViewRow): SavedView {
  return savedViewSchema.parse({
    id: row.id,
    name: row.name,
    surface: row.surface,
    configuration: row.configuration,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

export function sessionFromRow(row: SessionRow): TrackSession {
  const session: TrackSession = {
    id: row.id,
    icao: normaliseIcao(row.icao),
    startedAt: iso(row.started_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    lastPositionAt: iso(row.last_position_at),
    callsigns: row.callsigns ?? [],
    sampleCount: number(row.sample_count),
    minimumAltitudeFt: row.minimum_altitude_ft,
    maximumAltitudeFt: row.maximum_altitude_ft,
    minimumGroundSpeedKt: row.minimum_ground_speed_kt,
    maximumGroundSpeedKt: row.maximum_ground_speed_kt,
    closestRangeNm: row.closest_range_nm,
    lastLatitude: row.last_latitude,
    lastLongitude: row.last_longitude,
    lastAltitudeFt: row.last_altitude_ft,
    detailedTrackAvailable: row.detailed_track_available ?? true,
    alertRules: row.alert_rules ?? []
  };
  if ("metadata_icao" in row) {
    session.metadata = metadataFromRow(row);
  }
  return session;
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(
  cursor: string | undefined,
  schema: z.ZodType<T>
): T | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    return schema.parse(decoded);
  } catch {
    throw new RepositoryInputError("INVALID_CURSOR", "Cursor is malformed");
  }
}

/**
 * Keyset position in a session page. Time sorts carry the timestamp they
 * ordered by; the numeric sorts carry their own ordering value instead, so
 * every sort paginates by the same "last row seen" rule rather than by offset.
 * A cursor written before the numeric sorts existed still parses.
 */
export const sessionCursorSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }).optional(),
    value: z.number().finite().optional(),
    id: z.string().uuid()
  })
  .strict();
export const summaryCursorSchema = z
  .object({
    date: z.string().date(),
    icao: z.string().regex(/^[0-9a-f]{6}$/)
  })
  .strict();
export const alertCursorSchema = z
  .object({
    occurredAt: z.string().datetime({ offset: true }),
    id: z.string().uuid()
  })
  .strict();

export class RepositoryInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RepositoryInputError";
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function intervalForResolution(resolution: TrackResponse["resolution"]): string {
  switch (resolution) {
    case "1s":
      return "1 second";
    case "5s":
      return "5 seconds";
    case "15s":
      return "15 seconds";
    case "60s":
      return "60 seconds";
    default:
      throw new RepositoryInputError(
        "INVALID_RESOLUTION",
        "Unsupported track resolution"
      );
  }
}

export function hasDetailedTrackAvailable(
  summaryDate: string,
  positionedObservations: number,
  retentionDays: number,
  now = new Date()
): boolean {
  const cutoffDate = new Date(
    now.getTime() - retentionDays * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  return positionedObservations > 0 && summaryDate >= cutoffDate;
}

