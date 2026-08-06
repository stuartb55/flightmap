import { randomUUID } from "node:crypto";
import type {
  LiveAircraft
} from "@flightmap/shared";
import {
  activeAircraftAlertRules,
  evaluateAlerts,
  isActiveAircraftAlert
} from "../domain/alerts.js";
import {
  analyticalAltitudeFt
} from "../domain/altitude.js";
import {
  coverageGridCell,
  utcDay,
  utcHour
} from "../domain/insights.js";
import {
  decideSession
} from "../domain/session.js";
import type {
  NormalisedSnapshot
} from "../domain/normalise.js";
import type {
  Queryable
} from "./database.js";
import type {
  AlertRow,
  CurrentContextRow,
  CustomAlertRuleRow,
  IngestionResult,
  MetadataRow,
  RangeAltitudeBand
} from "./repository-shared.js";
import {
  RepositoryBase,
  alertFromRow,
  customAlertRuleFromRow,
  customRuleMatches,
  iso,
  json,
  metadataFromRow,
  normaliseIcao,
  number,
  rangeAltitudeBand
} from "./repository-shared.js";

/** Snapshot ingestion: sessions, positions, live rows, rollups and alerts. */
export class IngestRepository extends RepositoryBase {
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
      // The state blob is cleared alongside the column, as the other two
      // copies of this statement do. An aircraft absent from this snapshot is
      // not rewritten by `upsertCurrent` below, so without this it keeps a
      // sessionId pointing at a session that has ended — until the health
      // loop's sweep happens to notice.
      await client.query(
        `UPDATE current_aircraft c
         SET session_id = NULL,
             state = jsonb_set(c.state, '{sessionId}', 'null'::jsonb)
         FROM track_sessions s
         WHERE c.session_id = s.id AND s.ended_at IS NOT NULL`
      );

      const icaos = uniqueAircraft.map((aircraft) => aircraft.icao);
      const currentResult = await client.query<CurrentContextRow>(
        `SELECT c.icao, c.session_id, c.last_position_at, c.state,
                s.last_altitude_ft
         FROM current_aircraft c
         LEFT JOIN track_sessions s ON s.id = c.session_id
         WHERE c.icao = ANY($1::text[])
           AND (c.session_id IS NULL OR s.ended_at IS NULL)`,
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
      const customRuleResult = await client.query<CustomAlertRuleRow>(
        "SELECT * FROM custom_alert_rules WHERE enabled ORDER BY created_at"
      );
      const activeAlertResult = await client.query<{ icao: string }>(
        `SELECT DISTINCT icao FROM alert_events
         WHERE icao = ANY($1::text[])
           AND rule = ANY($2::text[])
           AND dismissed_at IS NULL`,
        [icaos, [...activeAircraftAlertRules]]
      );
      const customAlertCooldownResult = await client.query<{
        icao: string;
        state: string;
        last_occurred_at: Date | string;
      }>(
        `SELECT icao, state, max(occurred_at) AS last_occurred_at
         FROM alert_events
         WHERE rule = 'custom' AND icao = ANY($1::text[]) AND state IS NOT NULL
         GROUP BY icao, state`,
        [icaos]
      );

      const currentByIcao = new Map(
        currentResult.rows.map((row) => [normaliseIcao(row.icao), row])
      );
      const watched = new Set(
        watchlistResult.rows.map((row) => normaliseIcao(row.icao))
      );
      const metadata = new Map(
        metadataResult.rows.map((row) => [normaliseIcao(row.icao), metadataFromRow(row)])
      );
      const activeAlerts = new Set(
        activeAlertResult.rows.map((row) => normaliseIcao(row.icao))
      );
      const customRules = customRuleResult.rows.map(customAlertRuleFromRow);
      const customAlertCooldowns = new Map(customAlertCooldownResult.rows.map((row) => [
        `${row.state}:${normaliseIcao(row.icao)}`,
        new Date(row.last_occurred_at)
      ]));
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
      const rangeByBucket = new Map<string, {
        profileDate: string;
        bearingBucket: number;
        altitudeBand: RangeAltitudeBand;
        rangeBucketNm: number;
        reports: number;
      }>();
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

        const encounterKey =
          sessionId ?? `unpositioned:${aircraft.icao}:${iso(snapshot.recordedAt).slice(0, 10)}`;
        const candidates = evaluateAlerts(aircraft, {
          watched: aircraft.watched,
          encounterKey
        });
        aircraft.hasActiveAlert = activeAlerts.has(aircraft.icao);

        const analyticalAltitude = analyticalAltitudeFt(
          aircraft,
          previous
            ? {
                ...previous.state,
                analyticalAltitudeFt: previous.last_altitude_ft
              }
            : null
        );

        for (const rule of customRules) {
          if (!customRuleMatches(rule, aircraft, analyticalAltitude)) continue;
          const cooldownMapKey = `${rule.id}:${aircraft.icao}`;
          const lastCustomAlert = customAlertCooldowns.get(cooldownMapKey);
          if (rule.cooldownMinutes > 0 && lastCustomAlert
            && snapshot.recordedAt.getTime() - lastCustomAlert.getTime() < rule.cooldownMinutes * 60_000) continue;
          const cooldownKey = rule.cooldownMinutes > 0 ? iso(snapshot.recordedAt) : encounterKey;
          alertSamples.push({
            id: randomUUID(),
            icao: aircraft.icao,
            sessionId,
            rule: "custom",
            state: rule.id,
            message: `${rule.name} matched ${aircraft.callsign || aircraft.metadata?.registration || aircraft.icao}`,
            severity: rule.severity,
            callsign: aircraft.callsign,
            occurredAt: aircraft.recordedAt,
            dedupeKey: `${cooldownKey}:custom:${rule.id}:${aircraft.icao}`
          });
          customAlertCooldowns.set(cooldownMapKey, snapshot.recordedAt);
        }

        if (
          sessionId &&
          aircraft.latitude !== null &&
          aircraft.longitude !== null
        ) {
          sessionSamples.push({
            id: sessionId,
            icao: aircraft.icao,
            recorded_at: aircraft.recordedAt,
            callsigns: aircraft.callsign ? [aircraft.callsign] : [],
            altitude: analyticalAltitude,
            speed: aircraft.groundSpeedKt,
            distance: aircraft.distanceNm,
            latitude: aircraft.latitude,
            longitude: aircraft.longitude
          });
          positionSamples.push({
            ...aircraft,
            sessionId,
            analyticalAltitudeFt: analyticalAltitude
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
          altitude: analyticalAltitude,
          speed: aircraft.groundSpeedKt,
          distance: aircraft.distanceNm,
          callsigns: aircraft.callsign ? [aircraft.callsign] : []
        });
        const positioned =
          aircraft.latitude !== null && aircraft.longitude !== null;
        hourlySamples.push({
          bucketHour: utcHour(snapshot.recordedAt),
          icao: aircraft.icao,
          recordedAt: aircraft.recordedAt,
          reports: 1,
          positionedReports: positioned ? 1 : 0,
          sessionIds: sessionId ? [sessionId] : [],
          callsigns: aircraft.callsign ? [aircraft.callsign] : [],
          maximumRangeNm: aircraft.distanceNm,
          maximumAltitudeFt: analyticalAltitude
        });
        if (positioned) {
          const cell = coverageGridCell(aircraft.latitude!, aircraft.longitude!);
          const key = `${cell.latitudeIndex}:${cell.longitudeIndex}`;
          const existing = coverageByCell.get(key);
          if (existing) {
            existing.reports += 1;
            existing.aircraftIcaos.add(aircraft.icao);
            if (
              analyticalAltitude !== null &&
              (existing.maximumAltitudeFt === null ||
                analyticalAltitude > existing.maximumAltitudeFt)
            ) {
              existing.maximumAltitudeFt = analyticalAltitude;
            }
          } else {
            coverageByCell.set(key, {
              coverageDate: utcDay(snapshot.recordedAt),
              latitudeIndex: cell.latitudeIndex,
              longitudeIndex: cell.longitudeIndex,
              reports: 1,
              aircraftIcaos: new Set([aircraft.icao]),
              maximumAltitudeFt: analyticalAltitude
            });
          }
          if (aircraft.distanceNm !== null && aircraft.bearingDeg !== null) {
            const bearingBucket = Math.floor((((aircraft.bearingDeg % 360) + 360) % 360) / 5);
            const rangeBucketNm = Math.min(500, Math.floor(Math.max(0, aircraft.distanceNm) / 5) * 5);
            const altitudeBand = rangeAltitudeBand(aircraft.onGround, analyticalAltitude);
            const rangeKey = `${bearingBucket}:${altitudeBand}:${rangeBucketNm}`;
            const range = rangeByBucket.get(rangeKey);
            if (range) {
              range.reports += 1;
            } else {
              rangeByBucket.set(rangeKey, {
                profileDate: utcDay(snapshot.recordedAt),
                bearingBucket,
                altitudeBand,
                rangeBucketNm,
                reports: 1
              });
            }
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
            severity: candidate.rule === "watchlist" ? "warning" : "critical",
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
      const firstSeenByIcao = await this.upsertAircraftSummaries(
        client,
        summarySamples
      );
      await this.upsertDailySummaries(client, dailySamples);
      await this.upsertHourlyActivity(client, hourlySamples);
      await this.upsertCoverageCells(
        client,
        [...coverageByCell.values()].map((cell) => ({
          ...cell,
          aircraftIcaos: [...cell.aircraftIcaos]
        }))
      );
      await this.upsertRangeHistogram(client, [...rangeByBucket.values()]);
      const insertedAlerts = await this.insertAlerts(client, alertSamples);
      const newlyAlertedIcaos = new Set(
        insertedAlerts
          .filter((alert) => isActiveAircraftAlert(alert.rule))
          .map((alert) => normaliseIcao(alert.icao))
      );
      for (const aircraft of uniqueAircraft) {
        aircraft.hasActiveAlert =
          aircraft.hasActiveAlert || newlyAlertedIcaos.has(aircraft.icao);
        // Static per airframe, so it rides along on rows already being sent
        // without making an otherwise unchanged row look changed to the diff.
        aircraft.firstSeenAt = firstSeenByIcao.get(aircraft.icao) ?? null;
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
         last_altitude_ft = COALESCE(
           EXCLUDED.last_altitude_ft, track_sessions.last_altitude_ft
         ),
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
         altitude_barometric_ft, altitude_geometric_ft,
         analytical_altitude_ft, on_ground,
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
         x.altitude_barometric_ft, x.altitude_geometric_ft,
         x.analytical_altitude_ft, x.on_ground,
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
         altitude_geometric_ft double precision,
         analytical_altitude_ft double precision, on_ground boolean,
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
              analytical_altitude_ft: row.analyticalAltitudeFt,
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

  /**
   * Returns the resulting first-seen time per ICAO so the caller can put it on
   * the rows it publishes. The live delta carries whole aircraft, and a row
   * built by `normalise` has no way to know when this receiver first heard the
   * airframe — without this the field would be correct in the REST snapshot,
   * which reads it through a join, and null a second later in every delta.
   */
  private async upsertAircraftSummaries(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<Map<string, string>> {
    const result = await client.query<{
      icao: string;
      first_seen_at: Date | string;
    }>(
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
         updated_at = now()
       RETURNING icao, first_seen_at`,
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
    return new Map(
      result.rows.map((row) => [normaliseIcao(row.icao), iso(row.first_seen_at)])
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
         positioned_reports, session_ids, callsigns, maximum_range_nm,
         maximum_altitude_ft
       )
       SELECT x.bucket_hour, x.icao, x.recorded_at, x.recorded_at, x.reports,
              x.positioned_reports, x.session_ids, x.callsigns,
              x.maximum_range_nm, x.maximum_altitude_ft
       FROM jsonb_to_recordset($1::jsonb) AS x(
         bucket_hour timestamptz, icao text, recorded_at timestamptz,
         reports bigint, positioned_reports bigint, session_ids uuid[],
         callsigns text[], maximum_range_nm double precision,
         maximum_altitude_ft double precision
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
         callsigns = ARRAY(
           SELECT DISTINCT value
           FROM unnest(hourly_aircraft_activity.callsigns || EXCLUDED.callsigns) value
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
            callsigns: row.callsigns,
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
    const payload = json(
      rows.map((row) => ({
        coverage_date: row.coverageDate,
        latitude_index: row.latitudeIndex,
        longitude_index: row.longitudeIndex,
        reports: row.reports,
        aircraft_icaos: row.aircraftIcaos,
        maximum_altitude_ft: row.maximumAltitudeFt
      }))
    );
    await client.query(
      `INSERT INTO daily_coverage_cells (
         coverage_date, latitude_index, longitude_index, reports,
         maximum_altitude_ft
       )
       SELECT x.coverage_date, x.latitude_index, x.longitude_index, x.reports,
              x.maximum_altitude_ft
       FROM jsonb_to_recordset($1::jsonb) AS x(
         coverage_date date, latitude_index smallint, longitude_index smallint,
         reports bigint, maximum_altitude_ft double precision
       )
       ON CONFLICT (coverage_date, latitude_index, longitude_index) DO UPDATE SET
         reports = daily_coverage_cells.reports + EXCLUDED.reports,
         maximum_altitude_ft = CASE
           WHEN EXCLUDED.maximum_altitude_ft IS NULL THEN daily_coverage_cells.maximum_altitude_ft
           WHEN daily_coverage_cells.maximum_altitude_ft IS NULL THEN EXCLUDED.maximum_altitude_ft
           ELSE greatest(daily_coverage_cells.maximum_altitude_ft, EXCLUDED.maximum_altitude_ft)
         END`,
      [payload]
    );
    // Membership is one small row per aircraft per cell per day; the previous
    // array column was rewritten in full on every snapshot.
    await client.query(
      `INSERT INTO daily_coverage_cell_aircraft (
         coverage_date, latitude_index, longitude_index, icao
       )
       SELECT DISTINCT x.coverage_date, x.latitude_index, x.longitude_index, icao
       FROM jsonb_to_recordset($1::jsonb) AS x(
         coverage_date date, latitude_index smallint, longitude_index smallint,
         aircraft_icaos text[]
       )
       CROSS JOIN LATERAL unnest(x.aircraft_icaos) AS icao
       ON CONFLICT DO NOTHING`,
      [payload]
    );
  }

  /**
   * Counters only. The range profile reads nothing but `reports`, so unlike
   * coverage there is no per-aircraft membership to keep alongside it.
   */
  private async upsertRangeHistogram(
    client: Queryable,
    rows: Array<{
      profileDate: string;
      bearingBucket: number;
      altitudeBand: RangeAltitudeBand;
      rangeBucketNm: number;
      reports: number;
    }>
  ): Promise<void> {
    if (!rows.length) return;
    const payload = json(rows.map((row) => ({
      profile_date: row.profileDate,
      bearing_bucket: row.bearingBucket,
      altitude_band: row.altitudeBand,
      range_bucket_nm: row.rangeBucketNm,
      reports: row.reports
    })));
    await client.query(
      `INSERT INTO daily_range_histogram (
         profile_date, bearing_bucket, altitude_band, range_bucket_nm, reports
       )
       SELECT x.profile_date, x.bearing_bucket, x.altitude_band, x.range_bucket_nm, x.reports
       FROM jsonb_to_recordset($1::jsonb) AS x(
         profile_date date, bearing_bucket smallint, altitude_band text,
         range_bucket_nm smallint, reports bigint
       )
       ON CONFLICT (profile_date, bearing_bucket, altitude_band, range_bucket_nm) DO UPDATE SET
         reports = daily_range_histogram.reports + EXCLUDED.reports`,
      [payload]
    );
  }

  private async insertAlerts(
    client: Queryable,
    rows: Array<Record<string, unknown>>
  ): Promise<AlertRow[]> {
    if (rows.length === 0) return [];
    const result = await client.query<AlertRow>(
      `INSERT INTO alert_events (
         id, icao, session_id, rule, state, message, severity, callsign,
         occurred_at, dedupe_key
       )
       SELECT
         x.id, x.icao, x.session_id, x.rule, x.state, x.message, x.severity,
         x.callsign, x.occurred_at, x.dedupe_key
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, icao text, session_id uuid, rule text, state text,
         message text, severity text, callsign text, occurred_at timestamptz,
         dedupe_key text
       )
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, icao, session_id, rule, state, message, severity,
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
            severity: row.severity,
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
    return result.rows.map((row) => normaliseIcao(row.icao));
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
}
