import { randomUUID } from "node:crypto";
import type {
  AircraftDetailResponse,
  AircraftMetadata,
  AircraftSummary,
  AlertEvent,
  AlertQuery,
  AlertsResponse,
  DailyAircraftSummary,
  InsightAvailability,
  InsightCoverageQuery,
  InsightCoverageResponse,
  InsightLeader,
  InsightMetrics,
  InsightOverview,
  InsightQuery,
  LiveAircraft,
  SavedView,
  SavedViewConfiguration,
  SavedViewInput,
  SavedViewPatch,
  SessionQuery,
  SessionsResponse,
  SummariesResponse,
  SummaryQuery,
  TrackPoint,
  TrackResponse,
  TrackSession,
  WatchlistEntry,
  WatchlistInput
} from "@flightmap/shared";
import { savedViewSchema } from "@flightmap/shared";
import type { Config } from "../config.js";
import { z } from "zod";
import { evaluateAlerts } from "../domain/alerts.js";
import {
  coverageGridCell,
  insightMetricChanges,
  receiverPerformanceForBucket,
  utcDay,
  utcHour
} from "../domain/insights.js";
import { decideSession } from "../domain/session.js";
import type { NormalisedSnapshot } from "../domain/normalise.js";
import type { Database, Queryable } from "./database.js";

type IngestionResult = {
  upserts: LiveAircraft[];
  alerts: AlertEvent[];
};

type CurrentContextRow = {
  icao: string;
  session_id: string | null;
  last_position_at: Date | string | null;
};

type SummaryContextRow = {
  icao: string;
  first_seen_at: Date | string;
};

type MetadataRow = {
  icao: string;
  registration: string | null;
  type_code: string | null;
  description: string | null;
  operator: string | null;
  owner: string | null;
  country: string | null;
};

type AlertRow = {
  id: string;
  icao: string;
  session_id: string | null;
  rule: AlertEvent["rule"];
  state: string | null;
  message: string;
  occurred_at: Date | string;
  dismissed_at: Date | string | null;
  callsign: string | null;
};

type SavedViewRow = {
  id: string;
  name: string;
  surface: SavedView["surface"];
  configuration: SavedViewConfiguration;
  created_at: Date | string;
  updated_at: Date | string;
};

type SessionRow = {
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

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function utcDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}/.test(value)
      ? value.slice(0, 10)
      : new Date(value).toISOString().slice(0, 10);
}

function number(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : number(value);
}

type InsightAggregateRow = {
  unique_aircraft: number | string;
  sessions: number | string;
  reports: number | string;
  positioned_reports: number | string;
  maximum_range_nm: number | string | null;
  maximum_altitude_ft: number | string | null;
};

type InsightSeriesRow = InsightAggregateRow & {
  bucket_start: Date | string;
  bucket_end: Date | string;
};

type ReceiverInsightRow = {
  bucket_start: Date | string;
  samples: number | string;
  available_samples: number | string;
  message_rate_per_second: number | string | null;
  rejected_records: number | string | null;
};

function insightMetricsFromRow(row: InsightAggregateRow | undefined): InsightMetrics {
  return {
    uniqueAircraft: row ? number(row.unique_aircraft) : 0,
    sessions: row ? number(row.sessions) : 0,
    reports: row ? number(row.reports) : 0,
    positionedReports: row ? number(row.positioned_reports) : 0,
    maximumRangeNm: row ? nullableNumber(row.maximum_range_nm) : null,
    maximumAltitudeFt: row ? nullableNumber(row.maximum_altitude_ft) : null
  };
}

function metadataFromRow(row: MetadataRow | SessionRow): AircraftMetadata | null {
  const icao =
    "metadata_icao" in row ? row.metadata_icao : (row as MetadataRow).icao;
  if (!icao) return null;
  return {
    icao: icao.trim().toLowerCase(),
    registration: row.registration ?? null,
    typeCode: row.type_code ?? null,
    description: row.description ?? null,
    operator: row.operator ?? null,
    owner: row.owner ?? null,
    country: row.country ?? null
  };
}

function alertFromRow(row: AlertRow): AlertEvent {
  return {
    id: row.id,
    icao: row.icao.trim().toLowerCase(),
    sessionId: row.session_id,
    rule: row.rule,
    state: row.state,
    message: row.message,
    occurredAt: iso(row.occurred_at),
    dismissedAt: row.dismissed_at ? iso(row.dismissed_at) : null,
    callsign: row.callsign
  };
}

function savedViewFromRow(row: SavedViewRow): SavedView {
  return savedViewSchema.parse({
    id: row.id,
    name: row.name,
    surface: row.surface,
    configuration: row.configuration,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function sessionFromRow(row: SessionRow): TrackSession {
  const session: TrackSession = {
    id: row.id,
    icao: row.icao.trim().toLowerCase(),
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

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(
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

const sessionCursorSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }),
    id: z.string().uuid()
  })
  .strict();
const summaryCursorSchema = z
  .object({
    date: z.string().date(),
    icao: z.string().regex(/^[0-9a-f]{6}$/)
  })
  .strict();
const alertCursorSchema = z
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function intervalForResolution(resolution: TrackResponse["resolution"]): string {
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

export class FlightRepository {
  private installedAt: Date | null = null;

  constructor(
    private readonly database: Database,
    private readonly config: Pick<
      Config,
      "sessionGapSeconds" | "currentAircraftTtlSeconds" | "historyRetentionDays"
    > &
      Partial<
        Pick<
          Config,
          "firstSeenAlertsEnabled" | "firstSeenAlertBaselineHours"
        >
      >
  ) {}

  async databaseReady(): Promise<boolean> {
    return this.database.healthy();
  }

  async checkpoint(): Promise<{
    recordedAt: Date;
    messages: number;
  } | null> {
    const result = await this.database.query<{
      recorded_at: Date | string;
      messages: string | number;
    }>(
      "SELECT recorded_at, messages FROM collector_checkpoint WHERE id = true"
    );
    const row = result.rows[0];
    return row
      ? { recordedAt: new Date(row.recorded_at), messages: number(row.messages) }
      : null;
  }

  async ingestSnapshot(snapshot: NormalisedSnapshot): Promise<IngestionResult> {
    const uniqueAircraft = [
      ...new Map(
        snapshot.aircraft.map((aircraft) => [aircraft.icao, aircraft])
      ).values()
    ];
    if (uniqueAircraft.length === 0) {
      await this.database.query(
        `INSERT INTO collector_checkpoint (id, recorded_at, messages)
         VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE
         SET recorded_at = EXCLUDED.recorded_at,
             messages = EXCLUDED.messages,
             updated_at = now()`,
        [snapshot.recordedAt, snapshot.receiverMessages]
      );
      return { upserts: [], alerts: [] };
    }

    return this.database.transaction(async (client) => {
      const cutoff = new Date(
        snapshot.recordedAt.getTime() - this.config.sessionGapSeconds * 1000
      );
      await client.query(
        `UPDATE track_sessions
         SET ended_at = last_position_at, updated_at = now()
         WHERE ended_at IS NULL AND last_position_at < $1`,
        [cutoff]
      );
      await client.query(
        `UPDATE current_aircraft c
         SET session_id = NULL
         FROM track_sessions s
         WHERE c.session_id = s.id AND s.ended_at IS NOT NULL`
      );

      const icaos = uniqueAircraft.map((aircraft) => aircraft.icao);
      const currentResult = await client.query<CurrentContextRow>(
        `SELECT c.icao, c.session_id, c.last_position_at
         FROM current_aircraft c
         LEFT JOIN track_sessions s ON s.id = c.session_id
         WHERE c.icao = ANY($1::text[])
           AND (c.session_id IS NULL OR s.ended_at IS NULL)`,
        [icaos]
      );
      const summaryResult = await client.query<SummaryContextRow>(
        "SELECT icao, first_seen_at FROM aircraft_summary WHERE icao = ANY($1::text[])",
        [icaos]
      );
      const watchlistResult = await client.query<{ icao: string }>(
        "SELECT icao FROM watchlist WHERE icao = ANY($1::text[])",
        [icaos]
      );
      const metadataResult = await client.query<MetadataRow>(
        "SELECT * FROM aircraft_metadata WHERE icao = ANY($1::text[])",
        [icaos]
      );
      const activeAlertResult = await client.query<{ icao: string }>(
        `SELECT DISTINCT icao FROM alert_events
         WHERE icao = ANY($1::text[]) AND dismissed_at IS NULL`,
        [icaos]
      );

      const currentByIcao = new Map(
        currentResult.rows.map((row) => [row.icao.trim(), row])
      );
      const previouslySeen = new Set(
        summaryResult.rows.map((row) => row.icao.trim())
      );
      const watched = new Set(
        watchlistResult.rows.map((row) => row.icao.trim())
      );
      const metadata = new Map(
        metadataResult.rows.map((row) => [row.icao.trim(), metadataFromRow(row)])
      );
      const activeAlerts = new Set(
        activeAlertResult.rows.map((row) => row.icao.trim())
      );
      const firstSeenAlertsActive = await this.firstSeenAlertsActive(
        client,
        snapshot.recordedAt
      );

      const sessionSamples: Array<Record<string, unknown>> = [];
      const positionSamples: Array<Record<string, unknown>> = [];
      const sessionIdentityUpdates: Array<Record<string, unknown>> = [];
      const summarySamples: Array<Record<string, unknown>> = [];
      const dailySamples: Array<Record<string, unknown>> = [];
      const hourlySamples: Array<Record<string, unknown>> = [];
      const coverageByCell = new Map<
        string,
        {
          coverageDate: string;
          latitudeIndex: number;
          longitudeIndex: number;
          reports: number;
          aircraftIcaos: Set<string>;
          maximumAltitudeFt: number | null;
        }
      >();
      const alertSamples: Array<Record<string, unknown>> = [];

      for (const aircraft of uniqueAircraft) {
        const previous = currentByIcao.get(aircraft.icao);
        const previousSession =
          previous?.session_id && previous.last_position_at
            ? {
                id: previous.session_id,
                lastPositionAt: new Date(previous.last_position_at)
              }
            : null;
        const decision = decideSession(
          aircraft,
          snapshot.recordedAt,
          previousSession,
          this.config.sessionGapSeconds
        );
        let sessionId: string | null = previousSession?.id ?? null;
        let newSession = false;

        if (decision.kind === "start") {
          sessionId = randomUUID();
          newSession = true;
        } else if (decision.kind === "continue") {
          sessionId = decision.sessionId;
        }
        aircraft.sessionId = sessionId;
        aircraft.watched = watched.has(aircraft.icao);
        aircraft.metadata = metadata.get(aircraft.icao) ?? null;

        const firstEver =
          firstSeenAlertsActive && !previouslySeen.has(aircraft.icao);
        const encounterKey =
          sessionId ?? `unpositioned:${aircraft.icao}:${iso(snapshot.recordedAt).slice(0, 10)}`;
        const candidates = evaluateAlerts(aircraft, {
          firstEver,
          watched: aircraft.watched,
          encounterKey
        });
        aircraft.hasActiveAlert = activeAlerts.has(aircraft.icao);

        if (
          sessionId &&
          aircraft.latitude !== null &&
          aircraft.longitude !== null
        ) {
          const altitude =
            aircraft.altitudeBarometricFt ?? aircraft.altitudeGeometricFt;
          sessionSamples.push({
            id: sessionId,
            icao: aircraft.icao,
            recorded_at: aircraft.recordedAt,
            callsigns: aircraft.callsign ? [aircraft.callsign] : [],
            altitude,
            speed: aircraft.groundSpeedKt,
            distance: aircraft.distanceNm,
            latitude: aircraft.latitude,
            longitude: aircraft.longitude
          });
          positionSamples.push({
            ...aircraft,
            sessionId
          });
        } else if (sessionId && aircraft.callsign) {
          sessionIdentityUpdates.push({
            id: sessionId,
            callsign: aircraft.callsign
          });
        }

        summarySamples.push({
          icao: aircraft.icao,
          recordedAt: aircraft.recordedAt,
          distance: aircraft.distanceNm,
          callsign: aircraft.callsign,
          registration: aircraft.metadata?.registration ?? null,
          typeCode: aircraft.metadata?.typeCode ?? null,
          operator: aircraft.metadata?.operator ?? null,
          newSession: newSession ? 1 : 0
        });
        dailySamples.push({
          icao: aircraft.icao,
          recordedAt: aircraft.recordedAt,
          positioned:
            aircraft.latitude !== null && aircraft.longitude !== null ? 1 : 0,
          newSession: newSession ? 1 : 0,
          altitude:
            aircraft.altitudeBarometricFt ?? aircraft.altitudeGeometricFt,
          speed: aircraft.groundSpeedKt,
          distance: aircraft.distanceNm,
          callsigns: aircraft.callsign ? [aircraft.callsign] : []
        });
        const altitude =
          aircraft.altitudeBarometricFt ?? aircraft.altitudeGeometricFt;
        const positioned =
          aircraft.latitude !== null && aircraft.longitude !== null;
        hourlySamples.push({
          bucketHour: utcHour(snapshot.recordedAt),
          icao: aircraft.icao,
          recordedAt: aircraft.recordedAt,
          reports: 1,
          positionedReports: positioned ? 1 : 0,
          sessionIds: sessionId ? [sessionId] : [],
          maximumRangeNm: aircraft.distanceNm,
          maximumAltitudeFt: altitude
        });
        if (positioned) {
          const cell = coverageGridCell(aircraft.latitude!, aircraft.longitude!);
          const key = `${cell.latitudeIndex}:${cell.longitudeIndex}`;
          const existing = coverageByCell.get(key);
          if (existing) {
            existing.reports += 1;
            existing.aircraftIcaos.add(aircraft.icao);
            if (
              altitude !== null &&
              (existing.maximumAltitudeFt === null ||
                altitude > existing.maximumAltitudeFt)
            ) {
              existing.maximumAltitudeFt = altitude;
            }
          } else {
            coverageByCell.set(key, {
              coverageDate: utcDay(snapshot.recordedAt),
              latitudeIndex: cell.latitudeIndex,
              longitudeIndex: cell.longitudeIndex,
              reports: 1,
              aircraftIcaos: new Set([aircraft.icao]),
              maximumAltitudeFt: altitude
            });
          }
        }

        for (const candidate of candidates) {
          alertSamples.push({
            id: randomUUID(),
            icao: aircraft.icao,
            sessionId,
            rule: candidate.rule,
            state: candidate.state,
            message: candidate.message,
            callsign: aircraft.callsign,
            occurredAt: aircraft.recordedAt,
            dedupeKey: candidate.dedupeKey
          });
        }
      }

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('flightmap:insights:' || $1)::bigint)",
        [utcDay(snapshot.recordedAt)]
      );
      if (sessionSamples.length > 0) {
        await this.upsertSessions(client, sessionSamples);
        await client.query("SELECT ensure_position_partition($1)", [
          snapshot.recordedAt
        ]);
        await this.insertPositions(client, positionSamples);
      }
      if (sessionIdentityUpdates.length > 0) {
        await client.query(
          `UPDATE track_sessions s
           SET callsigns = CASE
                 WHEN u.callsign = ANY(s.callsigns) THEN s.callsigns
                 ELSE array_append(s.callsigns, u.callsign)
               END,
               updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS u(id uuid, callsign text)
           WHERE s.id = u.id`,
          [json(sessionIdentityUpdates)]
        );
      }
      await this.upsertAircraftSummaries(client, summarySamples);
      await this.upsertDailySummaries(client, dailySamples);
      await this.upsertHourlyActivity(client, hourlySamples);
      await this.upsertCoverageCells(
        client,
        [...coverageByCell.values()].map((cell) => ({
          ...cell,
          aircraftIcaos: [...cell.aircraftIcaos]
        }))
      );
      const insertedAlerts = await this.insertAlerts(client, alertSamples);
      const newlyAlertedIcaos = new Set(
        insertedAlerts.map((alert) => alert.icao.trim().toLowerCase())
      );
      for (const aircraft of uniqueAircraft) {
        aircraft.hasActiveAlert =
          aircraft.hasActiveAlert || newlyAlertedIcaos.has(aircraft.icao);
      }
      await this.upsertCurrent(client, uniqueAircraft);
      await client.query(
        `INSERT INTO collector_checkpoint (id, recorded_at, messages)
         VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE
         SET recorded_at = EXCLUDED.recorded_at,
             messages = EXCLUDED.messages,
             updated_at = now()`,
        [snapshot.recordedAt, snapshot.receiverMessages]
      );
      return {
        upserts: uniqueAircraft,
        alerts: insertedAlerts.map(alertFromRow)
      };
    });
  }

  private async firstSeenAlertsActive(
    client: Queryable,
    at: Date
  ): Promise<boolean> {
    if (this.config.firstSeenAlertsEnabled !== true) return false;
    if (this.installedAt === null) {
      const result = await client.query<{ installed_at: Date | string }>(
        "SELECT installed_at FROM application_state WHERE id = true"
      );
      const installedAt = result.rows[0]?.installed_at;
      this.installedAt = installedAt ? new Date(installedAt) : new Date();
    }
    const baselineMs =
      (this.config.firstSeenAlertBaselineHours ?? 24) * 60 * 60 * 1000;
    return at.getTime() >= this.installedAt.getTime() + baselineMs;
  }

  private async upsertSessions(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    await client.query(
      `INSERT INTO track_sessions (
         id, icao, started_at, last_position_at, callsigns, sample_count,
         minimum_altitude_ft, maximum_altitude_ft,
         minimum_ground_speed_kt, maximum_ground_speed_kt,
         closest_range_nm, last_latitude, last_longitude, last_altitude_ft
       )
       SELECT
         x.id, x.icao, x.recorded_at, x.recorded_at, x.callsigns, 1,
         x.altitude, x.altitude, x.speed, x.speed, x.distance,
         x.latitude, x.longitude, x.altitude
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, icao text, recorded_at timestamptz, callsigns text[],
         altitude double precision, speed double precision,
         distance double precision, latitude double precision,
         longitude double precision
       )
       ON CONFLICT (id) DO UPDATE SET
         last_position_at = EXCLUDED.last_position_at,
         callsigns = ARRAY(
           SELECT DISTINCT value
           FROM unnest(track_sessions.callsigns || EXCLUDED.callsigns) AS value
         ),
         sample_count = track_sessions.sample_count + 1,
         minimum_altitude_ft = CASE
           WHEN EXCLUDED.minimum_altitude_ft IS NULL THEN track_sessions.minimum_altitude_ft
           WHEN track_sessions.minimum_altitude_ft IS NULL THEN EXCLUDED.minimum_altitude_ft
           ELSE least(track_sessions.minimum_altitude_ft, EXCLUDED.minimum_altitude_ft)
         END,
         maximum_altitude_ft = CASE
           WHEN EXCLUDED.maximum_altitude_ft IS NULL THEN track_sessions.maximum_altitude_ft
           WHEN track_sessions.maximum_altitude_ft IS NULL THEN EXCLUDED.maximum_altitude_ft
           ELSE greatest(track_sessions.maximum_altitude_ft, EXCLUDED.maximum_altitude_ft)
         END,
         minimum_ground_speed_kt = CASE
           WHEN EXCLUDED.minimum_ground_speed_kt IS NULL THEN track_sessions.minimum_ground_speed_kt
           WHEN track_sessions.minimum_ground_speed_kt IS NULL THEN EXCLUDED.minimum_ground_speed_kt
           ELSE least(track_sessions.minimum_ground_speed_kt, EXCLUDED.minimum_ground_speed_kt)
         END,
         maximum_ground_speed_kt = CASE
           WHEN EXCLUDED.maximum_ground_speed_kt IS NULL THEN track_sessions.maximum_ground_speed_kt
           WHEN track_sessions.maximum_ground_speed_kt IS NULL THEN EXCLUDED.maximum_ground_speed_kt
           ELSE greatest(track_sessions.maximum_ground_speed_kt, EXCLUDED.maximum_ground_speed_kt)
         END,
         closest_range_nm = CASE
           WHEN EXCLUDED.closest_range_nm IS NULL THEN track_sessions.closest_range_nm
           WHEN track_sessions.closest_range_nm IS NULL THEN EXCLUDED.closest_range_nm
           ELSE least(track_sessions.closest_range_nm, EXCLUDED.closest_range_nm)
         END,
         last_latitude = EXCLUDED.last_latitude,
         last_longitude = EXCLUDED.last_longitude,
         last_altitude_ft = EXCLUDED.last_altitude_ft,
         updated_at = now()`,
      [json(rows)]
    );
  }

  private async insertPositions(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    await client.query(
      `INSERT INTO position_samples (
         recorded_at, icao, session_id, callsign, latitude, longitude,
         altitude_barometric_ft, altitude_geometric_ft, on_ground,
         ground_speed_kt, indicated_air_speed_kt, true_air_speed_kt, mach,
         track_deg, track_rate_deg_per_sec, roll_deg, magnetic_heading_deg,
         true_heading_deg, barometric_rate_fpm, geometric_rate_fpm,
         squawk, emergency, category, rssi_dbfs, messages, seen_seconds,
         seen_position_seconds, nav_altitude_mcp_ft, nav_altitude_fms_ft,
         nav_heading_deg, nav_qnh_hpa, nav_modes, source, quality,
         distance_nm, bearing_deg
       )
       SELECT
         x.recorded_at, x.icao, x.session_id, x.callsign, x.latitude, x.longitude,
         x.altitude_barometric_ft, x.altitude_geometric_ft, x.on_ground,
         x.ground_speed_kt, x.indicated_air_speed_kt, x.true_air_speed_kt, x.mach,
         x.track_deg, x.track_rate_deg_per_sec, x.roll_deg, x.magnetic_heading_deg,
         x.true_heading_deg, x.barometric_rate_fpm, x.geometric_rate_fpm,
         x.squawk, x.emergency, x.category, x.rssi_dbfs, x.messages, x.seen_seconds,
         x.seen_position_seconds, x.nav_altitude_mcp_ft, x.nav_altitude_fms_ft,
         x.nav_heading_deg, x.nav_qnh_hpa, x.nav_modes, x.source, x.quality,
         x.distance_nm, x.bearing_deg
       FROM jsonb_to_recordset($1::jsonb) AS x(
         recorded_at timestamptz, icao text, session_id uuid, callsign text,
         latitude double precision, longitude double precision,
         altitude_barometric_ft double precision,
         altitude_geometric_ft double precision, on_ground boolean,
         ground_speed_kt double precision, indicated_air_speed_kt double precision,
         true_air_speed_kt double precision, mach double precision,
         track_deg double precision, track_rate_deg_per_sec double precision,
         roll_deg double precision, magnetic_heading_deg double precision,
         true_heading_deg double precision, barometric_rate_fpm double precision,
         geometric_rate_fpm double precision, squawk text, emergency text,
         category text, rssi_dbfs double precision, messages bigint,
         seen_seconds double precision, seen_position_seconds double precision,
         nav_altitude_mcp_ft double precision, nav_altitude_fms_ft double precision,
         nav_heading_deg double precision, nav_qnh_hpa double precision,
         nav_modes text[], source text, quality jsonb,
         distance_nm double precision, bearing_deg double precision
       )
       ON CONFLICT (recorded_at, icao) DO NOTHING`,
      [
        json(
          rows.map((row) => {
            const aircraft = row as unknown as LiveAircraft;
            return {
              recorded_at: aircraft.recordedAt,
              icao: aircraft.icao,
              session_id: row.sessionId,
              callsign: aircraft.callsign,
              latitude: aircraft.latitude,
              longitude: aircraft.longitude,
              altitude_barometric_ft: aircraft.altitudeBarometricFt,
              altitude_geometric_ft: aircraft.altitudeGeometricFt,
              on_ground: aircraft.onGround,
              ground_speed_kt: aircraft.groundSpeedKt,
              indicated_air_speed_kt: aircraft.indicatedAirSpeedKt,
              true_air_speed_kt: aircraft.trueAirSpeedKt,
              mach: aircraft.mach,
              track_deg: aircraft.trackDeg,
              track_rate_deg_per_sec: aircraft.trackRateDegPerSec,
              roll_deg: aircraft.rollDeg,
              magnetic_heading_deg: aircraft.magneticHeadingDeg,
              true_heading_deg: aircraft.trueHeadingDeg,
              barometric_rate_fpm: aircraft.barometricRateFpm,
              geometric_rate_fpm: aircraft.geometricRateFpm,
              squawk: aircraft.squawk,
              emergency: aircraft.emergency,
              category: aircraft.category,
              rssi_dbfs: aircraft.rssiDbfs,
              messages: aircraft.messages,
              seen_seconds: aircraft.seenSeconds,
              seen_position_seconds: aircraft.seenPositionSeconds,
              nav_altitude_mcp_ft: aircraft.navigation.altitudeMcpFt,
              nav_altitude_fms_ft: aircraft.navigation.altitudeFmsFt,
              nav_heading_deg: aircraft.navigation.headingDeg,
              nav_qnh_hpa: aircraft.navigation.qnhHpa,
              nav_modes: aircraft.navigation.modes,
              source: aircraft.source,
              quality: aircraft.quality,
              distance_nm: aircraft.distanceNm,
              bearing_deg: aircraft.bearingDeg
            };
          })
        )
      ]
    );
  }

  private async upsertCurrent(
    client: Queryable,
    aircraft: LiveAircraft[]
  ): Promise<void> {
    await client.query(
      `INSERT INTO current_aircraft (
         icao, state, updated_at, last_position_at, session_id
       )
       SELECT
         x.icao, x.state, x.updated_at,
         CASE WHEN x.positioned THEN x.updated_at ELSE NULL END,
         x.session_id
       FROM jsonb_to_recordset($1::jsonb) AS x(
         icao text, state jsonb, updated_at timestamptz,
         positioned boolean, session_id uuid
       )
       ON CONFLICT (icao) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at,
         last_position_at = COALESCE(
           EXCLUDED.last_position_at, current_aircraft.last_position_at
         ),
         session_id = EXCLUDED.session_id`,
      [
        json(
          aircraft.map((item) => ({
            icao: item.icao,
            state: item,
            updated_at: item.recordedAt,
            positioned: item.latitude !== null && item.longitude !== null,
            session_id: item.sessionId
          }))
        )
      ]
    );
  }

  private async upsertAircraftSummaries(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    await client.query(
      `INSERT INTO aircraft_summary (
         icao, first_seen_at, last_seen_at, total_observations, session_count,
         closest_range_nm, latest_callsign, latest_registration,
         latest_type_code, latest_operator
       )
       SELECT
         x.icao, x.recorded_at, x.recorded_at, 1, x.new_session,
         x.distance, x.callsign, x.registration, x.type_code, x.operator
       FROM jsonb_to_recordset($1::jsonb) AS x(
         icao text, recorded_at timestamptz, distance double precision,
         callsign text, registration text, type_code text, operator text,
         new_session integer
       )
       ON CONFLICT (icao) DO UPDATE SET
         last_seen_at = greatest(aircraft_summary.last_seen_at, EXCLUDED.last_seen_at),
         total_observations = aircraft_summary.total_observations + 1,
         session_count = aircraft_summary.session_count + EXCLUDED.session_count,
         closest_range_nm = CASE
           WHEN EXCLUDED.closest_range_nm IS NULL THEN aircraft_summary.closest_range_nm
           WHEN aircraft_summary.closest_range_nm IS NULL THEN EXCLUDED.closest_range_nm
           ELSE least(aircraft_summary.closest_range_nm, EXCLUDED.closest_range_nm)
         END,
         latest_callsign = COALESCE(EXCLUDED.latest_callsign, aircraft_summary.latest_callsign),
         latest_registration = COALESCE(EXCLUDED.latest_registration, aircraft_summary.latest_registration),
         latest_type_code = COALESCE(EXCLUDED.latest_type_code, aircraft_summary.latest_type_code),
         latest_operator = COALESCE(EXCLUDED.latest_operator, aircraft_summary.latest_operator),
         updated_at = now()`,
      [
        json(
          rows.map((row) => ({
            icao: row.icao,
            recorded_at: row.recordedAt,
            distance: row.distance,
            callsign: row.callsign,
            registration: row.registration,
            type_code: row.typeCode,
            operator: row.operator,
            new_session: row.newSession
          }))
        )
      ]
    );
  }

  private async upsertDailySummaries(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    await client.query(
      `INSERT INTO daily_aircraft_summary (
         summary_date, icao, first_seen_at, last_seen_at, observations,
         positioned_observations, session_count, minimum_altitude_ft,
         maximum_altitude_ft, maximum_ground_speed_kt, closest_range_nm,
         maximum_range_nm, callsigns
       )
       SELECT
         (x.recorded_at AT TIME ZONE 'UTC')::date, x.icao,
         x.recorded_at, x.recorded_at, 1, x.positioned, x.new_session,
         x.altitude, x.altitude, x.speed, x.distance, x.distance, x.callsigns
       FROM jsonb_to_recordset($1::jsonb) AS x(
         icao text, recorded_at timestamptz, positioned integer,
         new_session integer, altitude double precision,
         speed double precision, distance double precision, callsigns text[]
       )
       ON CONFLICT (summary_date, icao) DO UPDATE SET
         first_seen_at = least(daily_aircraft_summary.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = greatest(daily_aircraft_summary.last_seen_at, EXCLUDED.last_seen_at),
         observations = daily_aircraft_summary.observations + 1,
         positioned_observations = daily_aircraft_summary.positioned_observations + EXCLUDED.positioned_observations,
         session_count = daily_aircraft_summary.session_count + EXCLUDED.session_count,
         minimum_altitude_ft = CASE
           WHEN EXCLUDED.minimum_altitude_ft IS NULL THEN daily_aircraft_summary.minimum_altitude_ft
           WHEN daily_aircraft_summary.minimum_altitude_ft IS NULL THEN EXCLUDED.minimum_altitude_ft
           ELSE least(daily_aircraft_summary.minimum_altitude_ft, EXCLUDED.minimum_altitude_ft)
         END,
         maximum_altitude_ft = CASE
           WHEN EXCLUDED.maximum_altitude_ft IS NULL THEN daily_aircraft_summary.maximum_altitude_ft
           WHEN daily_aircraft_summary.maximum_altitude_ft IS NULL THEN EXCLUDED.maximum_altitude_ft
           ELSE greatest(daily_aircraft_summary.maximum_altitude_ft, EXCLUDED.maximum_altitude_ft)
         END,
         maximum_ground_speed_kt = CASE
           WHEN EXCLUDED.maximum_ground_speed_kt IS NULL THEN daily_aircraft_summary.maximum_ground_speed_kt
           WHEN daily_aircraft_summary.maximum_ground_speed_kt IS NULL THEN EXCLUDED.maximum_ground_speed_kt
           ELSE greatest(daily_aircraft_summary.maximum_ground_speed_kt, EXCLUDED.maximum_ground_speed_kt)
         END,
         closest_range_nm = CASE
           WHEN EXCLUDED.closest_range_nm IS NULL THEN daily_aircraft_summary.closest_range_nm
           WHEN daily_aircraft_summary.closest_range_nm IS NULL THEN EXCLUDED.closest_range_nm
           ELSE least(daily_aircraft_summary.closest_range_nm, EXCLUDED.closest_range_nm)
         END,
         maximum_range_nm = CASE
           WHEN EXCLUDED.maximum_range_nm IS NULL THEN daily_aircraft_summary.maximum_range_nm
           WHEN daily_aircraft_summary.maximum_range_nm IS NULL THEN EXCLUDED.maximum_range_nm
           ELSE greatest(daily_aircraft_summary.maximum_range_nm, EXCLUDED.maximum_range_nm)
         END,
         callsigns = ARRAY(
           SELECT DISTINCT value
           FROM unnest(daily_aircraft_summary.callsigns || EXCLUDED.callsigns) AS value
         )`,
      [
        json(
          rows.map((row) => ({
            icao: row.icao,
            recorded_at: row.recordedAt,
            positioned: row.positioned,
            new_session: row.newSession,
            altitude: row.altitude,
            speed: row.speed,
            distance: row.distance,
            callsigns: row.callsigns
          }))
        )
      ]
    );
  }

  private async upsertHourlyActivity(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    if (rows.length === 0) return;
    await client.query(
      `INSERT INTO hourly_aircraft_activity (
         bucket_hour, icao, first_seen_at, last_seen_at, reports,
         positioned_reports, session_ids, maximum_range_nm, maximum_altitude_ft
       )
       SELECT x.bucket_hour, x.icao, x.recorded_at, x.recorded_at, x.reports,
              x.positioned_reports, x.session_ids, x.maximum_range_nm,
              x.maximum_altitude_ft
       FROM jsonb_to_recordset($1::jsonb) AS x(
         bucket_hour timestamptz, icao text, recorded_at timestamptz,
         reports bigint, positioned_reports bigint, session_ids uuid[],
         maximum_range_nm double precision, maximum_altitude_ft double precision
       )
       ON CONFLICT (bucket_hour, icao) DO UPDATE SET
         first_seen_at = least(hourly_aircraft_activity.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = greatest(hourly_aircraft_activity.last_seen_at, EXCLUDED.last_seen_at),
         reports = hourly_aircraft_activity.reports + EXCLUDED.reports,
         positioned_reports = hourly_aircraft_activity.positioned_reports + EXCLUDED.positioned_reports,
         session_ids = ARRAY(
           SELECT DISTINCT value
           FROM unnest(hourly_aircraft_activity.session_ids || EXCLUDED.session_ids) value
         ),
         maximum_range_nm = CASE
           WHEN EXCLUDED.maximum_range_nm IS NULL THEN hourly_aircraft_activity.maximum_range_nm
           WHEN hourly_aircraft_activity.maximum_range_nm IS NULL THEN EXCLUDED.maximum_range_nm
           ELSE greatest(hourly_aircraft_activity.maximum_range_nm, EXCLUDED.maximum_range_nm)
         END,
         maximum_altitude_ft = CASE
           WHEN EXCLUDED.maximum_altitude_ft IS NULL THEN hourly_aircraft_activity.maximum_altitude_ft
           WHEN hourly_aircraft_activity.maximum_altitude_ft IS NULL THEN EXCLUDED.maximum_altitude_ft
           ELSE greatest(hourly_aircraft_activity.maximum_altitude_ft, EXCLUDED.maximum_altitude_ft)
         END`,
      [
        json(
          rows.map((row) => ({
            bucket_hour: row.bucketHour,
            icao: row.icao,
            recorded_at: row.recordedAt,
            reports: row.reports,
            positioned_reports: row.positionedReports,
            session_ids: row.sessionIds,
            maximum_range_nm: row.maximumRangeNm,
            maximum_altitude_ft: row.maximumAltitudeFt
          }))
        )
      ]
    );
  }

  private async upsertCoverageCells(
    client: Queryable,
    rows: Array<{
      coverageDate: string;
      latitudeIndex: number;
      longitudeIndex: number;
      reports: number;
      aircraftIcaos: string[];
      maximumAltitudeFt: number | null;
    }>
  ): Promise<void> {
    if (rows.length === 0) return;
    await client.query(
      `INSERT INTO daily_coverage_cells (
         coverage_date, latitude_index, longitude_index, reports,
         aircraft_icaos, maximum_altitude_ft
       )
       SELECT x.coverage_date, x.latitude_index, x.longitude_index, x.reports,
              x.aircraft_icaos, x.maximum_altitude_ft
       FROM jsonb_to_recordset($1::jsonb) AS x(
         coverage_date date, latitude_index smallint, longitude_index smallint,
         reports bigint, aircraft_icaos text[], maximum_altitude_ft double precision
       )
       ON CONFLICT (coverage_date, latitude_index, longitude_index) DO UPDATE SET
         reports = daily_coverage_cells.reports + EXCLUDED.reports,
         aircraft_icaos = ARRAY(
           SELECT DISTINCT value
           FROM unnest(daily_coverage_cells.aircraft_icaos || EXCLUDED.aircraft_icaos) value
         ),
         maximum_altitude_ft = CASE
           WHEN EXCLUDED.maximum_altitude_ft IS NULL THEN daily_coverage_cells.maximum_altitude_ft
           WHEN daily_coverage_cells.maximum_altitude_ft IS NULL THEN EXCLUDED.maximum_altitude_ft
           ELSE greatest(daily_coverage_cells.maximum_altitude_ft, EXCLUDED.maximum_altitude_ft)
         END`,
      [
        json(
          rows.map((row) => ({
            coverage_date: row.coverageDate,
            latitude_index: row.latitudeIndex,
            longitude_index: row.longitudeIndex,
            reports: row.reports,
            aircraft_icaos: row.aircraftIcaos,
            maximum_altitude_ft: row.maximumAltitudeFt
          }))
        )
      ]
    );
  }

  private async insertAlerts(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<AlertRow[]> {
    if (rows.length === 0) return [];
    const result = await client.query<AlertRow>(
      `INSERT INTO alert_events (
         id, icao, session_id, rule, state, message, callsign,
         occurred_at, dedupe_key
       )
       SELECT
         x.id, x.icao, x.session_id, x.rule, x.state, x.message,
         x.callsign, x.occurred_at, x.dedupe_key
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, icao text, session_id uuid, rule text, state text,
         message text, callsign text, occurred_at timestamptz,
         dedupe_key text
       )
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, icao, session_id, rule, state, message,
                 occurred_at, dismissed_at, callsign`,
      [
        json(
          rows.map((row) => ({
            id: row.id,
            icao: row.icao,
            session_id: row.sessionId,
            rule: row.rule,
            state: row.state,
            message: row.message,
            callsign: row.callsign,
            occurred_at: row.occurredAt,
            dedupe_key: row.dedupeKey
          }))
        )
      ]
    );
    return result.rows;
  }

  async removeExpiredCurrent(now = new Date()): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - this.config.currentAircraftTtlSeconds * 1000
    );
    const result = await this.database.query<{ icao: string }>(
      "DELETE FROM current_aircraft WHERE updated_at < $1 RETURNING icao",
      [cutoff]
    );
    return result.rows.map((row) => row.icao.trim().toLowerCase());
  }

  async closeInactiveSessions(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.sessionGapSeconds * 1000
    );
    return this.database.transaction(async (client) => {
      const closed = await client.query(
        `UPDATE track_sessions
         SET ended_at = last_position_at, updated_at = now()
         WHERE ended_at IS NULL AND last_position_at < $1`,
        [cutoff]
      );
      await client.query(
        `UPDATE current_aircraft c
         SET session_id = NULL,
             state = jsonb_set(c.state, '{sessionId}', 'null'::jsonb)
         FROM track_sessions s
         WHERE c.session_id = s.id AND s.ended_at IS NOT NULL`
      );
      return closed.rowCount ?? 0;
    });
  }

  async liveAircraft(now = new Date()): Promise<LiveAircraft[]> {
    const cutoff = new Date(
      now.getTime() - this.config.currentAircraftTtlSeconds * 1000
    );
    const result = await this.database.query<{
      state: LiveAircraft;
      watched: boolean;
      has_active_alert: boolean;
      metadata_icao: string | null;
      registration: string | null;
      type_code: string | null;
      description: string | null;
      operator: string | null;
      owner: string | null;
      country: string | null;
    }>(
      `SELECT c.state,
              (w.icao IS NOT NULL) AS watched,
              EXISTS (
                SELECT 1 FROM alert_events a
                WHERE a.icao = c.icao AND a.dismissed_at IS NULL
              ) AS has_active_alert,
              m.icao AS metadata_icao, m.registration, m.type_code,
              m.description, m.operator, m.owner, m.country
       FROM current_aircraft c
       LEFT JOIN watchlist w ON w.icao = c.icao
       LEFT JOIN aircraft_metadata m ON m.icao = c.icao
       WHERE c.updated_at >= $1
       ORDER BY c.icao`,
      [cutoff]
    );
    return result.rows.map((row) => ({
      ...row.state,
      icao: row.state.icao.trim().toLowerCase(),
      stale:
        now.getTime() - Date.parse(row.state.recordedAt) > 15_000 ||
        row.state.stale,
      watched: row.watched,
      hasActiveAlert: row.has_active_alert,
      metadata: row.metadata_icao
        ? metadataFromRow({
            icao: row.metadata_icao,
            registration: row.registration,
            type_code: row.type_code,
            description: row.description,
            operator: row.operator,
            owner: row.owner,
            country: row.country
          })
        : null
    }));
  }

  async aircraftDetail(icao: string): Promise<AircraftDetailResponse> {
    const [live, metadataResult, summaryResult, sessions, alerts] =
      await Promise.all([
        this.liveAircraft().then(
          (aircraft) => aircraft.find((item) => item.icao === icao) ?? null
        ),
        this.database.query<MetadataRow>(
          "SELECT * FROM aircraft_metadata WHERE icao = $1",
          [icao]
        ),
        this.database.query<{
          icao: string;
          first_seen_at: Date | string;
          last_seen_at: Date | string;
          total_observations: number | string;
          session_count: number | string;
          closest_range_nm: number | null;
          latest_callsign: string | null;
          latest_registration: string | null;
          latest_type_code: string | null;
          latest_operator: string | null;
        }>("SELECT * FROM aircraft_summary WHERE icao = $1", [icao]),
        this.database.query<SessionRow>(
          `SELECT s.*, true AS detailed_track_available,
                  ARRAY(
                    SELECT DISTINCT a.rule
                    FROM alert_events a
                    WHERE a.session_id = s.id
                  ) AS alert_rules
           FROM track_sessions s WHERE s.icao = $1
           ORDER BY s.started_at DESC LIMIT 20`,
          [icao]
        ),
        this.database.query<AlertRow>(
          `SELECT id, icao, session_id, rule, state, message,
                  occurred_at, dismissed_at, callsign
           FROM alert_events WHERE icao = $1
           ORDER BY occurred_at DESC LIMIT 50`,
          [icao]
        )
      ]);
    const summaryRow = summaryResult.rows[0];
    const summary: AircraftSummary | null = summaryRow
      ? {
          icao: summaryRow.icao.trim().toLowerCase(),
          firstSeenAt: iso(summaryRow.first_seen_at),
          lastSeenAt: iso(summaryRow.last_seen_at),
          totalObservations: number(summaryRow.total_observations),
          sessionCount: number(summaryRow.session_count),
          closestRangeNm: summaryRow.closest_range_nm,
          latestCallsign: summaryRow.latest_callsign,
          latestRegistration: summaryRow.latest_registration,
          latestTypeCode: summaryRow.latest_type_code,
          latestOperator: summaryRow.latest_operator
        }
      : null;
    return {
      aircraft: live,
      metadata: metadataResult.rows[0]
        ? metadataFromRow(metadataResult.rows[0])
        : null,
      summary,
      recentSessions: sessions.rows.map(sessionFromRow),
      alerts: alerts.rows.map(alertFromRow)
    };
  }

  async sessions(query: SessionQuery): Promise<SessionsResponse> {
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.now() - this.config.historyRetentionDays * 86_400_000);
    const to = query.to ? new Date(query.to) : new Date();
    if (to.getTime() - from.getTime() > 32 * 86_400_000) {
      throw new RepositoryInputError(
        "RANGE_TOO_LARGE",
        "Session searches are limited to 32 days"
      );
    }
    const cursor = decodeCursor(query.cursor, sessionCursorSchema);
    const result = await this.database.query<SessionRow>(
      `SELECT s.*, true AS detailed_track_available,
              ARRAY(
                SELECT DISTINCT a.rule
                FROM alert_events a
                WHERE a.session_id = s.id
              ) AS alert_rules,
              m.icao AS metadata_icao, m.registration, m.type_code,
              m.description, m.operator, m.owner, m.country
       FROM track_sessions s
       LEFT JOIN aircraft_metadata m ON m.icao = s.icao
       WHERE s.started_at >= $1 AND s.started_at <= $2
         AND ($3::text IS NULL OR s.icao = $3)
         AND ($4::text IS NULL OR EXISTS (
           SELECT 1 FROM unnest(s.callsigns) c WHERE c ILIKE '%' || $4 || '%'
         ))
         AND ($5::text IS NULL OR m.registration ILIKE '%' || $5 || '%')
         AND ($6::text IS NULL OR m.type_code ILIKE '%' || $6 || '%')
         AND ($7::text IS NULL OR m.operator ILIKE '%' || $7 || '%')
         AND (
           $8::text IS NULL
           OR s.icao ILIKE '%' || $8 || '%'
           OR array_to_string(s.callsigns, ' ') ILIKE '%' || $8 || '%'
           OR m.registration ILIKE '%' || $8 || '%'
           OR m.type_code ILIKE '%' || $8 || '%'
           OR m.description ILIKE '%' || $8 || '%'
           OR m.operator ILIKE '%' || $8 || '%'
         )
         AND (
           $9::text IS NULL OR $9 = 'any' AND EXISTS (
             SELECT 1 FROM alert_events a WHERE a.session_id = s.id
           ) OR $9 = 'active' AND EXISTS (
             SELECT 1 FROM alert_events a
             WHERE a.session_id = s.id AND a.dismissed_at IS NULL
           ) OR $9 = 'emergency' AND EXISTS (
             SELECT 1 FROM alert_events a
             WHERE a.session_id = s.id
               AND a.rule IN ('emergency_squawk', 'emergency_state')
           ) OR EXISTS (
             SELECT 1 FROM alert_events a
             WHERE a.session_id = s.id AND a.rule = $9
           )
         )
         AND (
           $10::timestamptz IS NULL OR
           (s.started_at, s.id) < ($10::timestamptz, $11::uuid)
         )
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT $12`,
      [
        from,
        to,
        query.icao ?? null,
        query.callsign ?? null,
        query.registration ?? null,
        query.type ?? null,
        query.operator ?? null,
        query.query ?? query.q ?? null,
        query.alert ?? null,
        cursor?.startedAt ?? null,
        cursor?.id ?? null,
        query.limit + 1
      ]
    );
    const hasMore = result.rows.length > query.limit;
    const page = result.rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(sessionFromRow),
      nextCursor:
        hasMore && last
          ? encodeCursor({ startedAt: iso(last.started_at), id: last.id })
          : null
    };
  }

  async track(
    id: string,
    requestedResolution: "auto" | "1s" | "5s" | "15s" | "60s",
    options: { from?: string; tail?: boolean; limit?: number } = {}
  ): Promise<TrackResponse | null> {
    const sessionResult = await this.database.query<SessionRow>(
      `SELECT s.*, true AS detailed_track_available,
              ARRAY(
                SELECT DISTINCT a.rule
                FROM alert_events a
                WHERE a.session_id = s.id
              ) AS alert_rules
       FROM track_sessions s WHERE s.id = $1`,
      [id]
    );
    const row = sessionResult.rows[0];
    if (!row) return null;
    const durationSeconds =
      (new Date(row.ended_at ?? row.last_position_at).getTime() -
        new Date(row.started_at).getTime()) /
      1000;
    const resolution: TrackResponse["resolution"] =
      requestedResolution === "auto"
        ? durationSeconds <= 7200
          ? "1s"
          : durationSeconds <= 21_600
            ? "5s"
            : durationSeconds <= 86_400
              ? "15s"
              : "60s"
        : requestedResolution;
    const interval = intervalForResolution(resolution);
    const limit = Math.max(1, Math.min(options.limit ?? 20_000, 20_000));
    const direction = options.tail ? "DESC" : "ASC";
    const points = await this.database.query<{
      recorded_at: Date | string;
      latitude: number;
      longitude: number;
      altitude_barometric_ft: number | null;
      altitude_geometric_ft: number | null;
      on_ground: boolean;
      ground_speed_kt: number | null;
      track_deg: number | null;
      vertical_rate_fpm: number | null;
      distance_nm: number | null;
      bearing_deg: number | null;
    }>(
      resolution === "1s"
        ? `SELECT * FROM (
             SELECT recorded_at, latitude, longitude,
                    altitude_barometric_ft, altitude_geometric_ft, on_ground,
                    ground_speed_kt, track_deg,
                    COALESCE(barometric_rate_fpm, geometric_rate_fpm) AS vertical_rate_fpm,
                    distance_nm, bearing_deg
             FROM position_samples
             WHERE session_id = $1
               AND ($2::timestamptz IS NULL OR recorded_at > $2)
             ORDER BY recorded_at ${direction}
             LIMIT $3
           ) selected_points
           ORDER BY recorded_at`
        : `SELECT * FROM (
             SELECT DISTINCT ON (
                      date_bin($2::interval, recorded_at, timestamptz 'epoch')
                    )
                    recorded_at, latitude, longitude,
                    altitude_barometric_ft, altitude_geometric_ft, on_ground,
                    ground_speed_kt, track_deg,
                    COALESCE(barometric_rate_fpm, geometric_rate_fpm) AS vertical_rate_fpm,
                    distance_nm, bearing_deg
             FROM position_samples
             WHERE session_id = $1
               AND ($3::timestamptz IS NULL OR recorded_at > $3)
             ORDER BY
               date_bin($2::interval, recorded_at, timestamptz 'epoch') ${direction},
               recorded_at ${direction}
             LIMIT $4
           ) selected_points
           ORDER BY recorded_at`,
      resolution === "1s"
        ? [id, options.from ?? null, limit + 1]
        : [id, interval, options.from ?? null, limit + 1]
    );
    const truncated = points.rows.length > limit;
    const page = truncated
      ? options.tail
        ? points.rows.slice(points.rows.length - limit)
        : points.rows.slice(0, limit)
      : points.rows;
    const trackPoints: TrackPoint[] = page.map((point) => ({
      recordedAt: iso(point.recorded_at),
      latitude: point.latitude,
      longitude: point.longitude,
      altitudeBarometricFt: point.altitude_barometric_ft,
      altitudeGeometricFt: point.altitude_geometric_ft,
      onGround: point.on_ground,
      groundSpeedKt: point.ground_speed_kt,
      trackDeg: point.track_deg,
      verticalRateFpm: point.vertical_rate_fpm,
      distanceNm: point.distance_nm,
      bearingDeg: point.bearing_deg
    }));
    return {
      session: sessionFromRow(row),
      resolution,
      points: trackPoints,
      truncated
    };
  }

  async summaries(query: SummaryQuery): Promise<SummariesResponse> {
    const cursor = decodeCursor(query.cursor, summaryCursorSchema);
    const result = await this.database.query<{
      summary_date: Date | string;
      icao: string;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      observations: number | string;
      positioned_observations: number | string;
      session_count: number | string;
      minimum_altitude_ft: number | null;
      maximum_altitude_ft: number | null;
      maximum_ground_speed_kt: number | null;
      closest_range_nm: number | null;
      callsigns: string[];
      metadata_icao: string | null;
      registration: string | null;
      type_code: string | null;
      description: string | null;
      operator: string | null;
      owner: string | null;
      country: string | null;
    }>(
      `SELECT d.*, m.icao AS metadata_icao, m.registration, m.type_code,
              m.description, m.operator, m.owner, m.country
       FROM daily_aircraft_summary d
       LEFT JOIN aircraft_metadata m ON m.icao = d.icao
       WHERE ($1::date IS NULL OR d.summary_date >= $1)
         AND ($2::date IS NULL OR d.summary_date <= $2)
         AND ($3::text IS NULL OR d.icao = $3)
         AND (
           $4::text IS NULL OR d.icao ILIKE '%' || $4 || '%'
           OR array_to_string(d.callsigns, ' ') ILIKE '%' || $4 || '%'
           OR m.registration ILIKE '%' || $4 || '%'
           OR m.type_code ILIKE '%' || $4 || '%'
           OR m.operator ILIKE '%' || $4 || '%'
         )
         AND (
           $5::date IS NULL OR
           (d.summary_date, d.icao) < ($5::date, $6::text)
         )
       ORDER BY d.summary_date DESC, d.icao DESC
       LIMIT $7`,
      [
        query.from ?? null,
        query.to ?? null,
        query.icao ?? null,
        query.query ?? null,
        cursor?.date ?? null,
        cursor?.icao ?? null,
        query.limit + 1
      ]
    );
    const hasMore = result.rows.length > query.limit;
    const page = result.rows.slice(0, query.limit);
    const items: DailyAircraftSummary[] = page.map((row) => {
      const date =
        row.summary_date instanceof Date
          ? row.summary_date.toISOString().slice(0, 10)
          : utcDate(row.summary_date);
      const positionedObservations = number(row.positioned_observations);
      return {
        icao: row.icao.trim().toLowerCase(),
        date,
        firstSeenAt: iso(row.first_seen_at),
        lastSeenAt: iso(row.last_seen_at),
        observations: number(row.observations),
        positionedObservations,
        sessionCount: number(row.session_count),
        minimumAltitudeFt: row.minimum_altitude_ft,
        maximumAltitudeFt: row.maximum_altitude_ft,
        maximumGroundSpeedKt: row.maximum_ground_speed_kt,
        closestRangeNm: row.closest_range_nm,
        callsigns: row.callsigns ?? [],
        detailedTrackAvailable: hasDetailedTrackAvailable(
          date,
          positionedObservations,
          this.config.historyRetentionDays
        ),
        metadata: metadataFromRow(row)
      };
    });
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ date: last.date, icao: last.icao })
          : null
    };
  }

  async insightAvailability(
    requestedFrom?: Date,
    now = new Date()
  ): Promise<InsightAvailability> {
    const result = await this.database.query<{
      hourly_from: Date | string | null;
      daily_from: Date | string | null;
      coverage_from: Date | string | null;
      status: InsightAvailability["backfill"]["status"];
      processed_days: number | string;
      total_days: number | string;
      next_date: Date | string | null;
      last_error: string | null;
    }>(
      `SELECT
         (SELECT min(bucket_hour) FROM hourly_aircraft_activity) AS hourly_from,
         (SELECT min(summary_date) FROM daily_aircraft_summary) AS daily_from,
         (SELECT min(coverage_date) FROM daily_coverage_cells) AS coverage_from,
         b.status, b.processed_days, b.total_days, b.next_date, b.last_error
       FROM insight_backfill_state b WHERE b.id = true`
    );
    const row = result.rows[0];
    const cutoff = new Date(
      now.getTime() - this.config.historyRetentionDays * 86_400_000
    );
    cutoff.setUTCMinutes(0, 0, 0);
    const dailyFrom = row?.daily_from
      ? utcDate(row.daily_from)
      : null;
    const coverageFrom = row?.coverage_from
      ? utcDate(row.coverage_from)
      : null;
    const notices: string[] = [];
    const requestedDay = requestedFrom?.toISOString().slice(0, 10) ?? null;
    if (row && row.status !== "complete") {
      notices.push(
        row.status === "failed"
          ? "Historical aggregate backfill needs attention."
          : "Historical aggregates are still being backfilled."
      );
    }
    if (requestedDay && dailyFrom && requestedDay < dailyFrom) {
      notices.push("Activity before the first retained daily summary is unavailable.");
    }
    if (requestedDay && coverageFrom && requestedDay < coverageFrom) {
      notices.push("Coverage before the first aggregated coverage day is unavailable.");
    }
    return {
      hourlyFrom: row?.hourly_from ? iso(row.hourly_from) : null,
      dailyFrom,
      coverageFrom,
      detailedTrackFrom: cutoff.toISOString(),
      partial: notices.length > 0,
      notices,
      backfill: {
        status: row?.status ?? "pending",
        processedDays: row ? number(row.processed_days) : 0,
        totalDays: row ? number(row.total_days) : 0,
        nextDate: row?.next_date ? utcDate(row.next_date) : null,
        error: row?.last_error ?? null
      }
    };
  }

  async insightsOverview(
    query: InsightQuery,
    now = new Date()
  ): Promise<InsightOverview> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const duration = to.getTime() - from.getTime();
    if (duration <= 0) {
      throw new RepositoryInputError("INVALID_RANGE", "from must be before to");
    }
    if (duration > 366 * 86_400_000) {
      throw new RepositoryInputError(
        "RANGE_TOO_LARGE",
        "Insight queries are limited to 366 days"
      );
    }
    const cutoff = new Date(
      now.getTime() - this.config.historyRetentionDays * 86_400_000
    );
    cutoff.setUTCMinutes(0, 0, 0);
    const comparisonFrom = new Date(from.getTime() - duration);
    const earliestRequested = query.compare ? comparisonFrom : from;
    if (query.bucket === "hour" && earliestRequested < cutoff) {
      throw new RepositoryInputError(
        "HOURLY_DETAIL_EXPIRED",
        query.compare
          ? `The preceding hourly comparison is available from ${cutoff.toISOString()}`
          : `Hourly insights are available from ${cutoff.toISOString()}`
      );
    }

    const hourly = query.bucket === "hour";
    const seriesSql = hourly
      ? `WITH filtered AS (
           SELECT * FROM hourly_aircraft_activity
           WHERE bucket_hour >= $1 AND bucket_hour < $2
         ), session_counts AS (
           SELECT f.bucket_hour, count(DISTINCT s.session_id) AS sessions
           FROM filtered f
           CROSS JOIN LATERAL unnest(f.session_ids) AS s(session_id)
           GROUP BY f.bucket_hour
         )
         SELECT f.bucket_hour AS bucket_start,
                f.bucket_hour + interval '1 hour' AS bucket_end,
                count(*) AS unique_aircraft,
                COALESCE(sc.sessions, 0) AS sessions,
                sum(f.reports) AS reports,
                sum(f.positioned_reports) AS positioned_reports,
                max(f.maximum_range_nm) AS maximum_range_nm,
                max(f.maximum_altitude_ft) AS maximum_altitude_ft
         FROM filtered f
         LEFT JOIN session_counts sc ON sc.bucket_hour = f.bucket_hour
         GROUP BY f.bucket_hour, sc.sessions
         ORDER BY f.bucket_hour`
      : `SELECT
           d.summary_date::timestamp AT TIME ZONE 'UTC' AS bucket_start,
           (d.summary_date + 1)::timestamp AT TIME ZONE 'UTC' AS bucket_end,
           count(*) AS unique_aircraft,
           sum(d.session_count) AS sessions,
           sum(d.observations) AS reports,
           sum(d.positioned_observations) AS positioned_reports,
           max(d.maximum_range_nm) AS maximum_range_nm,
           max(d.maximum_altitude_ft) AS maximum_altitude_ft
         FROM daily_aircraft_summary d
         WHERE d.summary_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
           AND d.summary_date < ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)
         GROUP BY d.summary_date
         ORDER BY d.summary_date`;
    const metricsSql = hourly
      ? `WITH filtered AS (
           SELECT * FROM hourly_aircraft_activity
           WHERE bucket_hour >= $1 AND bucket_hour < $2
         )
         SELECT count(DISTINCT icao) AS unique_aircraft,
                (SELECT count(DISTINCT s.session_id)
                 FROM filtered f
                 CROSS JOIN LATERAL unnest(f.session_ids) AS s(session_id)) AS sessions,
                COALESCE(sum(reports), 0) AS reports,
                COALESCE(sum(positioned_reports), 0) AS positioned_reports,
                max(maximum_range_nm) AS maximum_range_nm,
                max(maximum_altitude_ft) AS maximum_altitude_ft
         FROM filtered`
      : `SELECT count(DISTINCT icao) AS unique_aircraft,
                COALESCE(sum(session_count), 0) AS sessions,
                COALESCE(sum(observations), 0) AS reports,
                COALESCE(sum(positioned_observations), 0) AS positioned_reports,
                max(maximum_range_nm) AS maximum_range_nm,
                max(maximum_altitude_ft) AS maximum_altitude_ft
         FROM daily_aircraft_summary
         WHERE summary_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
           AND summary_date < ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)`;
    const activityCte = hourly
      ? `WITH filtered AS (
           SELECT * FROM hourly_aircraft_activity
           WHERE bucket_hour >= $1 AND bucket_hour < $2
         ), activity AS (
           SELECT f.icao, sum(f.reports) AS reports,
                  sum(f.positioned_reports) AS positioned_reports,
                  (SELECT count(DISTINCT s.session_id)
                   FROM filtered f2
                   CROSS JOIN LATERAL unnest(f2.session_ids) AS s(session_id)
                   WHERE f2.icao = f.icao) AS sessions
           FROM filtered f GROUP BY f.icao
         )`
      : `WITH activity AS (
           SELECT icao, sum(observations) AS reports,
                  sum(positioned_observations) AS positioned_reports,
                  sum(session_count) AS sessions
           FROM daily_aircraft_summary
           WHERE summary_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
             AND summary_date < ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)
           GROUP BY icao
         )`;
    const leadersSql = `${activityCte}, leaders AS (
         SELECT 'aircraft'::text AS kind, trim(a.icao) AS key,
                COALESCE(NULLIF(m.registration, ''), upper(trim(a.icao))) AS label,
                NULLIF(concat_ws(' · ', NULLIF(m.type_code, ''), NULLIF(m.operator, '')), '') AS secondary,
                a.reports, a.positioned_reports, a.sessions
         FROM activity a LEFT JOIN aircraft_metadata m ON m.icao = a.icao
         UNION ALL
         SELECT 'types', COALESCE(NULLIF(lower(m.type_code), ''), 'unknown'),
                COALESCE(NULLIF(m.type_code, ''), 'Unknown type'), NULL,
                sum(a.reports), sum(a.positioned_reports), sum(a.sessions)
         FROM activity a LEFT JOIN aircraft_metadata m ON m.icao = a.icao
         GROUP BY COALESCE(NULLIF(lower(m.type_code), ''), 'unknown'),
                  COALESCE(NULLIF(m.type_code, ''), 'Unknown type')
         UNION ALL
         SELECT 'operators', COALESCE(NULLIF(lower(m.operator), ''), 'unknown'),
                COALESCE(NULLIF(m.operator, ''), 'Unknown operator'), NULL,
                sum(a.reports), sum(a.positioned_reports), sum(a.sessions)
         FROM activity a LEFT JOIN aircraft_metadata m ON m.icao = a.icao
         GROUP BY COALESCE(NULLIF(lower(m.operator), ''), 'unknown'),
                  COALESCE(NULLIF(m.operator, ''), 'Unknown operator')
       ), ranked AS (
         SELECT *, row_number() OVER (PARTITION BY kind ORDER BY reports DESC, label) AS rank
         FROM leaders
       ) SELECT kind, key, label, secondary, reports, positioned_reports, sessions
         FROM ranked WHERE rank <= 10 ORDER BY kind, rank`;

    const receiverBucket = hourly
      ? "date_trunc('hour', recorded_at)"
      : "date_trunc('day', recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
    const receiverSql = `SELECT ${receiverBucket} AS bucket_start,
                                count(*) AS samples,
                                count(*) FILTER (
                                  WHERE health IN ('online', 'degraded')
                                ) AS available_samples,
                                avg(message_rate_per_second) AS message_rate_per_second,
                                sum(bad_messages) AS rejected_records
                         FROM receiver_samples
                         WHERE recorded_at >= greatest($1::timestamptz, $3::timestamptz)
                           AND recorded_at < $2::timestamptz
                         GROUP BY bucket_start
                         ORDER BY bucket_start`;

    const [
      seriesResult,
      metricsResult,
      leadersResult,
      receiverResult,
      comparisonMetricsResult,
      availability
    ] =
      await Promise.all([
        this.database.query<InsightSeriesRow>(seriesSql, [from, to]),
        this.database.query<InsightAggregateRow>(metricsSql, [from, to]),
        this.database.query<{
          kind: "aircraft" | "types" | "operators";
          key: string;
          label: string;
          secondary: string | null;
          reports: number | string;
          positioned_reports: number | string;
          sessions: number | string;
        }>(leadersSql, [from, to]),
        this.database.query<ReceiverInsightRow>(receiverSql, [from, to, cutoff]),
        query.compare
          ? this.database.query<InsightAggregateRow>(metricsSql, [
              comparisonFrom,
              from
            ])
          : Promise.resolve({ rows: [] as InsightAggregateRow[] }),
        this.insightAvailability(earliestRequested, now)
      ]);
    const leaders: InsightOverview["leaders"] = {
      aircraft: [],
      types: [],
      operators: []
    };
    for (const row of leadersResult.rows) {
      const leader: InsightLeader = {
        key: row.key.trim().toLowerCase(),
        label: row.label,
        secondary: row.secondary,
        reports: number(row.reports),
        positionedReports: number(row.positioned_reports),
        sessions: number(row.sessions)
      };
      leaders[row.kind].push(leader);
    }
    const metrics = insightMetricsFromRow(metricsResult.rows[0]);
    const receiverByBucket = new Map(
      receiverResult.rows.map((row) => [iso(row.bucket_start), row])
    );
    const series = seriesResult.rows.map((row) => {
      const bucketStart = new Date(row.bucket_start);
      const bucketEnd = new Date(row.bucket_end);
      const receiver = receiverByBucket.get(bucketStart.toISOString());
      return {
        bucketStart: bucketStart.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
        ...insightMetricsFromRow(row),
        ...receiverPerformanceForBucket(
          bucketStart,
          bucketEnd,
          from,
          to,
          cutoff,
          // Receiver samples are compacted to one row per UTC minute when
          // persisted, independently of the polling cadence.
          60_000,
          receiver
            ? {
                samples: number(receiver.samples),
                availableSamples: number(receiver.available_samples),
                messageRatePerSecond: nullableNumber(
                  receiver.message_rate_per_second
                ),
                rejectedRecords: nullableNumber(receiver.rejected_records)
              }
            : undefined
        )
      };
    });
    const previousMetrics = insightMetricsFromRow(
      comparisonMetricsResult.rows[0]
    );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: query.bucket,
      metrics,
      series,
      leaders,
      availability,
      comparison: query.compare
        ? {
            from: comparisonFrom.toISOString(),
            to: from.toISOString(),
            metrics: previousMetrics,
            changes: insightMetricChanges(metrics, previousMetrics)
          }
        : null
    };
  }

  async insightsCoverage(
    query: InsightCoverageQuery,
    now = new Date()
  ): Promise<InsightCoverageResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const duration = to.getTime() - from.getTime();
    if (duration <= 0) {
      throw new RepositoryInputError("INVALID_RANGE", "from must be before to");
    }
    if (duration > 366 * 86_400_000) {
      throw new RepositoryInputError(
        "RANGE_TOO_LARGE",
        "Coverage queries are limited to 366 days"
      );
    }
    const limit = 10_000;
    const [result, availability] = await Promise.all([
      this.database.query<{
        latitude_index: number;
        longitude_index: number;
        reports: number | string;
        unique_aircraft: number | string;
        maximum_altitude_ft: number | string | null;
      }>(
        `WITH filtered AS (
           SELECT * FROM daily_coverage_cells
           WHERE coverage_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
             AND coverage_date < ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)
         )
         SELECT f.latitude_index, f.longitude_index, sum(f.reports) AS reports,
                (SELECT count(DISTINCT icao)
                 FROM filtered f2
                 CROSS JOIN LATERAL unnest(f2.aircraft_icaos) AS icao
                 WHERE f2.latitude_index = f.latitude_index
                   AND f2.longitude_index = f.longitude_index) AS unique_aircraft,
                max(f.maximum_altitude_ft) AS maximum_altitude_ft
         FROM filtered f
         GROUP BY f.latitude_index, f.longitude_index
         ORDER BY reports DESC, f.latitude_index, f.longitude_index
         LIMIT $3`,
        [from, to, limit + 1]
      ),
      this.insightAvailability(from, now)
    ]);
    const truncated = result.rows.length > limit;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      cells: result.rows.slice(0, limit).map((row) => {
        const cell = coverageGridCell(
          -90 + row.latitude_index * 0.05,
          -180 + row.longitude_index * 0.05
        );
        return {
          latitude: cell.latitude,
          longitude: cell.longitude,
          south: cell.south,
          west: cell.west,
          north: cell.north,
          east: cell.east,
          reports: number(row.reports),
          uniqueAircraft: number(row.unique_aircraft),
          maximumAltitudeFt: nullableNumber(row.maximum_altitude_ft)
        };
      }),
      truncated,
      availability
    };
  }

  async alerts(query: AlertQuery): Promise<AlertsResponse> {
    const cursor = decodeCursor(query.cursor, alertCursorSchema);
    const result = await this.database.query<AlertRow>(
      `SELECT id, icao, session_id, rule, state, message,
              occurred_at, dismissed_at, callsign
       FROM alert_events
       WHERE ($1::text IS NULL OR icao = $1)
         AND ($2::boolean IS NULL OR (dismissed_at IS NOT NULL) = $2)
         AND (
           $3::timestamptz IS NULL OR
           (occurred_at, id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT $5`,
      [
        query.icao ?? null,
        query.dismissed ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        query.limit + 1
      ]
    );
    const hasMore = result.rows.length > query.limit;
    const page = result.rows.slice(0, query.limit);
    const items = page.map(alertFromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null
    };
  }

  async dismissAlert(id: string, at = new Date()): Promise<AlertEvent | null> {
    const result = await this.database.query<AlertRow>(
      `UPDATE alert_events SET dismissed_at = COALESCE(dismissed_at, $2)
       WHERE id = $1
       RETURNING id, icao, session_id, rule, state, message,
                 occurred_at, dismissed_at, callsign`,
      [id, at]
    );
    return result.rows[0] ? alertFromRow(result.rows[0]) : null;
  }

  async dismissAlerts(ids: string[], at = new Date()): Promise<AlertEvent[]> {
    const result = await this.database.query<AlertRow>(
      `UPDATE alert_events
       SET dismissed_at = COALESCE(dismissed_at, $2)
       WHERE id = ANY($1::uuid[])
       RETURNING id, icao, session_id, rule, state, message,
                 occurred_at, dismissed_at, callsign`,
      [ids, at]
    );
    return result.rows.map(alertFromRow);
  }

  async watchlist(): Promise<WatchlistEntry[]> {
    const result = await this.database.query<{
      icao: string;
      label: string | null;
      notes: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>("SELECT * FROM watchlist ORDER BY updated_at DESC, icao");
    return result.rows.map((row) => ({
      icao: row.icao.trim().toLowerCase(),
      label: row.label,
      notes: row.notes,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async savedViews(): Promise<SavedView[]> {
    const result = await this.database.query<SavedViewRow>(
      `SELECT id, name, surface, configuration, created_at, updated_at
       FROM saved_views ORDER BY updated_at DESC, name, id`
    );
    return result.rows.map(savedViewFromRow);
  }

  async createSavedView(input: SavedViewInput): Promise<SavedView> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_907_182_028]);
      const count = await client.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM saved_views"
      );
      if (number(count.rows[0]?.count ?? 0) >= 20) {
        throw new RepositoryInputError(
          "SAVED_VIEW_LIMIT",
          "Flightmap supports up to 20 saved views"
        );
      }
      const result = await client.query<SavedViewRow>(
        `INSERT INTO saved_views (id, name, surface, configuration)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, name, surface, configuration, created_at, updated_at`,
        [
          randomUUID(),
          input.name,
          input.configuration.surface,
          json(input.configuration)
        ]
      );
      return savedViewFromRow(result.rows[0]!);
    });
  }

  async updateSavedView(
    id: string,
    patch: SavedViewPatch
  ): Promise<SavedView | null> {
    const configuration = patch.configuration ?? null;
    const result = await this.database.query<SavedViewRow>(
      `UPDATE saved_views
       SET name = COALESCE($2, name),
           surface = COALESCE($3, surface),
           configuration = COALESCE($4::jsonb, configuration),
           updated_at = now()
       WHERE id = $1
       RETURNING id, name, surface, configuration, created_at, updated_at`,
      [
        id,
        patch.name ?? null,
        configuration?.surface ?? null,
        configuration ? json(configuration) : null
      ]
    );
    return result.rows[0] ? savedViewFromRow(result.rows[0]) : null;
  }

  async deleteSavedView(id: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM saved_views WHERE id = $1",
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async putWatchlist(
    icao: string,
    input: WatchlistInput
  ): Promise<WatchlistEntry> {
    const result = await this.database.query<{
      icao: string;
      label: string | null;
      notes: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `INSERT INTO watchlist (icao, label, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (icao) DO UPDATE SET
         label = EXCLUDED.label, notes = EXCLUDED.notes, updated_at = now()
       RETURNING *`,
      [icao, input.label ?? null, input.notes ?? null]
    );
    const row = result.rows[0]!;
    return {
      icao: row.icao.trim().toLowerCase(),
      label: row.label,
      notes: row.notes,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async deleteWatchlist(icao: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM watchlist WHERE icao = $1",
      [icao]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveReceiverInfo(info: {
    latitude: number | null;
    longitude: number | null;
    version: string | null;
    advertisedRefreshMs: number | null;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO receiver_state (
         id, latitude, longitude, software_version, advertised_refresh_ms
       ) VALUES (true, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         latitude = COALESCE(EXCLUDED.latitude, receiver_state.latitude),
         longitude = COALESCE(EXCLUDED.longitude, receiver_state.longitude),
         software_version = COALESCE(EXCLUDED.software_version, receiver_state.software_version),
         advertised_refresh_ms = COALESCE(EXCLUDED.advertised_refresh_ms, receiver_state.advertised_refresh_ms),
         updated_at = now()`,
      [
        info.latitude,
        info.longitude,
        info.version,
        info.advertisedRefreshMs
      ]
    );
  }

  async receiverInfo(): Promise<{
    latitude: number | null;
    longitude: number | null;
    version: string | null;
    advertisedRefreshMs: number | null;
  } | null> {
    const result = await this.database.query<{
      latitude: number | null;
      longitude: number | null;
      software_version: string | null;
      advertised_refresh_ms: number | null;
    }>(
      `SELECT latitude, longitude, software_version, advertised_refresh_ms
       FROM receiver_state WHERE id = true`
    );
    const row = result.rows[0];
    return row
      ? {
          latitude: row.latitude,
          longitude: row.longitude,
          version: row.software_version,
          advertisedRefreshMs: row.advertised_refresh_ms
        }
      : null;
  }

  async saveReceiverSample(sample: {
    recordedAt: Date;
    messageRatePerSecond: number | null;
    acceptedMessages: number | null;
    badMessages: number | null;
    strongSignals: number | null;
    signalDbfs: number | null;
    noiseDbfs: number | null;
    peakSignalDbfs: number | null;
    cpuDemodMs: number | null;
    cpuReaderMs: number | null;
    cpuBackgroundMs: number | null;
    health: string;
    raw: unknown;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO receiver_samples (
         recorded_at, message_rate_per_second, accepted_messages,
         bad_messages, strong_signals, signal_dbfs, noise_dbfs,
         peak_signal_dbfs, cpu_demod_ms, cpu_reader_ms, cpu_background_ms,
         health, raw
       ) VALUES (
         date_trunc('minute', $1::timestamptz), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13
       )
       ON CONFLICT (recorded_at) DO UPDATE SET
         message_rate_per_second = EXCLUDED.message_rate_per_second,
         accepted_messages = EXCLUDED.accepted_messages,
         bad_messages = EXCLUDED.bad_messages,
         strong_signals = EXCLUDED.strong_signals,
         signal_dbfs = EXCLUDED.signal_dbfs,
         noise_dbfs = EXCLUDED.noise_dbfs,
         peak_signal_dbfs = EXCLUDED.peak_signal_dbfs,
         cpu_demod_ms = EXCLUDED.cpu_demod_ms,
         cpu_reader_ms = EXCLUDED.cpu_reader_ms,
         cpu_background_ms = EXCLUDED.cpu_background_ms,
         health = EXCLUDED.health,
         raw = EXCLUDED.raw`,
      [
        sample.recordedAt,
        sample.messageRatePerSecond,
        sample.acceptedMessages,
        sample.badMessages,
        sample.strongSignals,
        sample.signalDbfs,
        sample.noiseDbfs,
        sample.peakSignalDbfs,
        sample.cpuDemodMs,
        sample.cpuReaderMs,
        sample.cpuBackgroundMs,
        sample.health,
        json(sample.raw)
      ]
    );
  }

  async databaseStatus(): Promise<{
    healthy: boolean;
    sizeBytes: number | null;
    oldestSampleAt: string | null;
    newestSampleAt: string | null;
  }> {
    try {
      const result = await this.database.query<{
        size_bytes: string | number;
        oldest_sample_at: Date | string | null;
        newest_sample_at: Date | string | null;
      }>(
        `SELECT pg_database_size(current_database()) AS size_bytes,
                min(recorded_at) AS oldest_sample_at,
                max(recorded_at) AS newest_sample_at
         FROM position_samples`
      );
      const row = result.rows[0]!;
      return {
        healthy: true,
        sizeBytes: number(row.size_bytes),
        oldestSampleAt: row.oldest_sample_at ? iso(row.oldest_sample_at) : null,
        newestSampleAt: row.newest_sample_at ? iso(row.newest_sample_at) : null
      };
    } catch {
      return {
        healthy: false,
        sizeBytes: null,
        oldestSampleAt: null,
        newestSampleAt: null
      };
    }
  }

  async metadataStatus(): Promise<{
    importedAt: string | null;
    sourceModifiedAt: string | null;
    version: string | null;
    rowCount: number;
    lastCheckedAt: string | null;
    lastError: string | null;
  }> {
    const result = await this.database.query<{
      imported_at: Date | string | null;
      source_modified_at: Date | string | null;
      version: string | null;
      row_count: number;
      last_checked_at: Date | string | null;
      last_error: string | null;
    }>(
      `SELECT imported_at, source_modified_at, version, row_count,
              last_checked_at, last_error
       FROM aircraft_metadata_import WHERE id = true`
    );
    const row = result.rows[0];
    return row
      ? {
          importedAt: row.imported_at ? iso(row.imported_at) : null,
          sourceModifiedAt: row.source_modified_at
            ? iso(row.source_modified_at)
            : null,
          version: row.version,
          rowCount: row.row_count,
          lastCheckedAt: row.last_checked_at
            ? iso(row.last_checked_at)
            : null,
          lastError: row.last_error
        }
      : {
          importedAt: null,
          sourceModifiedAt: null,
          version: null,
          rowCount: 0,
          lastCheckedAt: null,
          lastError: null
        };
  }

  async lastMaintenanceAt(): Promise<string | null> {
    const result = await this.database.query<{
      ran_at: Date | string;
    }>("SELECT ran_at FROM maintenance_log ORDER BY ran_at DESC LIMIT 1");
    return result.rows[0] ? iso(result.rows[0].ran_at) : null;
  }
}
