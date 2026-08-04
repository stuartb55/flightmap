import type {
  AircraftActivityQuery,
  AircraftActivityResponse,
  DailyAircraftSummary,
  SessionQuery,
  SessionSort,
  SessionsResponse,
  SummariesResponse,
  SummaryQuery,
  TrackEvent,
  TrackPoint,
  TrackResponse
} from "@flightmap/shared";
import type {
  SessionRow
} from "./repository-shared.js";
import {
  RepositoryBase,
  RepositoryInputError,
  decodeCursor,
  encodeCursor,
  hasDetailedTrackAvailable,
  intervalForResolution,
  iso,
  metadataFromRow,
  normaliseIcao,
  nullableNumber,
  number,
  sessionCursorSchema,
  sessionFromRow,
  summaryCursorSchema,
  utcDate
} from "./repository-shared.js";

/**
 * How each sort orders a session page, and what it pages by.
 *
 * The numeric sorts fold their NULLs into a sentinel that cannot occur —
 * no approach is a billion miles and no aircraft is a billion feet below sea
 * level — so a plain row comparison keeps NULLs at the far end without a
 * separate NULLS FIRST/LAST branch in the keyset predicate.
 */
const sessionSorts = {
  started_desc: { expression: "s.started_at", direction: "DESC", numeric: false },
  started_asc: { expression: "s.started_at", direction: "ASC", numeric: false },
  duration_desc: {
    expression:
      "extract(epoch from (coalesce(s.ended_at, s.last_position_at) - s.started_at))",
    direction: "DESC",
    numeric: true
  },
  closest_asc: {
    expression: "coalesce(s.closest_range_nm, 1e9)",
    direction: "ASC",
    numeric: true
  },
  altitude_desc: {
    expression: "coalesce(s.maximum_altitude_ft, -1e9)",
    direction: "DESC",
    numeric: true
  },
  samples_desc: {
    expression: "s.sample_count::double precision",
    direction: "DESC",
    numeric: true
  }
} as const satisfies Record<
  SessionSort,
  { expression: string; direction: "ASC" | "DESC"; numeric: boolean }
>;

/** Track sessions, retained position detail, and per-aircraft history. */
export class HistoryRepository extends RepositoryBase {
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
    // Routes always parse a sort in; the fallback is for direct callers.
    const sort = sessionSorts[query.sort ?? "started_desc"];
    // Whitelisted fragments only: the sort arrives as an enum, never as text.
    const after = sort.direction === "DESC" ? "<" : ">";
    const cursorType = sort.numeric ? "double precision" : "timestamptz";
    const keyset =
      `($10::${cursorType} IS NULL OR ` +
      `(${sort.expression}, s.id) ${after} ($10::${cursorType}, $11::uuid))`;
    // A cursor is only meaningful alongside the sort that produced it.
    const cursorValue = sort.numeric ? cursor?.value : cursor?.startedAt;
    if (cursor && cursorValue === undefined) {
      throw new RepositoryInputError(
        "INVALID_CURSOR",
        "Cursor does not belong to this sort order"
      );
    }
    const result = await this.database.query<SessionRow & { sort_value: string | number | null }>(
      `SELECT s.*, true AS detailed_track_available,
              ${sort.expression} AS sort_value,
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
         AND ($4::text IS NULL OR (
           -- The indexable predicate first; the per-callsign check keeps a
           -- pattern from matching across two joined callsigns.
           flightmap_callsigns_text(s.callsigns) LIKE '%' || lower($4) || '%'
           AND EXISTS (
             SELECT 1 FROM unnest(s.callsigns) c WHERE c ILIKE '%' || $4 || '%'
           )
         ))
         AND ($5::text IS NULL OR lower(m.registration) LIKE '%' || lower($5) || '%')
         AND ($6::text IS NULL OR lower(m.type_code) LIKE '%' || lower($6) || '%')
         AND ($7::text IS NULL OR lower(m.operator) LIKE '%' || lower($7) || '%')
         AND (
           $8::text IS NULL
           OR lower(s.icao::text) LIKE '%' || lower($8) || '%'
           OR flightmap_callsigns_text(s.callsigns) LIKE '%' || lower($8) || '%'
           OR lower(m.registration) LIKE '%' || lower($8) || '%'
           OR lower(m.type_code) LIKE '%' || lower($8) || '%'
           OR lower(m.description) LIKE '%' || lower($8) || '%'
           OR lower(m.operator) LIKE '%' || lower($8) || '%'
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
         AND ${keyset}
       ORDER BY ${sort.expression} ${sort.direction}, s.id ${sort.direction}
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
        cursorValue ?? null,
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
          ? encodeCursor(
              sort.numeric
                // The numeric sorts coalesce, so this is only null-typed, not null.
                ? { value: number(last.sort_value ?? 0), id: last.id }
                : { startedAt: iso(last.started_at), id: last.id }
            )
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
    const [points, eventRows] = await Promise.all([this.database.query<{
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
    ), this.database.query<{
      type: TrackEvent["type"];
      occurred_at: Date | string;
      label: string;
      value: string | null;
      severity: TrackEvent["severity"];
    }>(
      `WITH ordered AS (
         SELECT recorded_at, callsign, squawk, emergency, distance_nm,
                lag(callsign) OVER (ORDER BY recorded_at) AS previous_callsign,
                lag(squawk) OVER (ORDER BY recorded_at) AS previous_squawk,
                lag(emergency) OVER (ORDER BY recorded_at) AS previous_emergency,
                row_number() OVER (ORDER BY recorded_at) AS row_number
         FROM position_samples
         WHERE session_id = $1
       ), changes AS (
         SELECT CASE
                  WHEN callsign IS DISTINCT FROM previous_callsign THEN 'callsign'
                  WHEN squawk IS DISTINCT FROM previous_squawk THEN 'squawk'
                  ELSE 'emergency'
                END AS type,
                recorded_at AS occurred_at,
                CASE
                  WHEN callsign IS DISTINCT FROM previous_callsign THEN 'Callsign changed'
                  WHEN squawk IS DISTINCT FROM previous_squawk THEN 'Squawk changed'
                  ELSE 'Emergency state changed'
                END AS label,
                CASE
                  WHEN callsign IS DISTINCT FROM previous_callsign THEN callsign
                  WHEN squawk IS DISTINCT FROM previous_squawk THEN squawk
                  ELSE emergency
                END AS value,
                CASE
                  WHEN emergency IS DISTINCT FROM previous_emergency
                    AND emergency IS NOT NULL AND emergency <> 'none' THEN 'critical'
                  WHEN squawk IS DISTINCT FROM previous_squawk
                    AND squawk IN ('7500', '7600', '7700') THEN 'critical'
                  ELSE 'info'
                END AS severity
         FROM ordered
         WHERE row_number > 1
           AND (callsign IS DISTINCT FROM previous_callsign
             OR squawk IS DISTINCT FROM previous_squawk
             OR emergency IS DISTINCT FROM previous_emergency)
       ), closest AS (
         SELECT recorded_at AS occurred_at, distance_nm
         FROM ordered WHERE distance_nm IS NOT NULL
         ORDER BY distance_nm ASC, recorded_at ASC LIMIT 1
       )
       SELECT 'session_start' AS type, s.started_at AS occurred_at,
              'Session started' AS label, NULL::text AS value, 'info' AS severity
       FROM track_sessions s WHERE s.id = $1
       UNION ALL
       SELECT 'session_end', s.ended_at, 'Session ended', NULL::text, 'info'
       FROM track_sessions s WHERE s.id = $1 AND s.ended_at IS NOT NULL
       UNION ALL
       SELECT type, occurred_at, label, value, severity FROM changes
       UNION ALL
       SELECT 'alert', a.occurred_at, a.message, a.state,
              CASE WHEN a.rule IN ('emergency_squawk', 'emergency_state') THEN 'critical' ELSE 'warning' END
       FROM alert_events a WHERE a.session_id = $1
       UNION ALL
       SELECT 'closest_approach', occurred_at, 'Closest approach',
              round(distance_nm::numeric, 1)::text || ' nm', 'info'
       FROM closest
       ORDER BY occurred_at`,
      [id]
    )]);
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
      events: eventRows.rows.map((event) => ({
        type: event.type,
        occurredAt: iso(event.occurred_at),
        label: event.label,
        value: event.value,
        severity: event.severity
      })),
      truncated
    };
  }

  async aircraftActivity(
    icao: string,
    query: AircraftActivityQuery,
    now = new Date()
  ): Promise<AircraftActivityResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const interval = query.bucket === "month" ? "month" : "day";
    const [result, callsignResult] = await Promise.all([this.database.query<{
      bucket_start: Date | string;
      bucket_end: Date | string;
      observations: number | string;
      positioned_observations: number | string;
      sessions: number | string;
      active_days: number | string;
      closest_range_nm: number | string | null;
      maximum_altitude_ft: number | string | null;
    }>(
      `SELECT date_trunc($4, summary_date::timestamp AT TIME ZONE 'UTC') AS bucket_start,
              date_trunc($4, summary_date::timestamp AT TIME ZONE 'UTC')
                + CASE WHEN $4 = 'month' THEN interval '1 month' ELSE interval '1 day' END AS bucket_end,
              sum(observations) AS observations,
              sum(positioned_observations) AS positioned_observations,
              sum(session_count) AS sessions,
              count(*) AS active_days,
              min(closest_range_nm) AS closest_range_nm,
              max(maximum_altitude_ft) AS maximum_altitude_ft
       FROM daily_aircraft_summary
       WHERE icao = $1
         AND summary_date >= ($2::timestamptz AT TIME ZONE 'UTC')::date
         AND summary_date < ($3::timestamptz AT TIME ZONE 'UTC')::date + 1
       GROUP BY 1, 2 ORDER BY 1`,
      [icao, from, to, interval]
    ), this.database.query<{ callsign: string }>(
      `SELECT DISTINCT callsign
       FROM daily_aircraft_summary d
       CROSS JOIN LATERAL unnest(d.callsigns) callsign
       WHERE d.icao = $1
         AND d.summary_date >= ($2::timestamptz AT TIME ZONE 'UTC')::date
         AND d.summary_date < ($3::timestamptz AT TIME ZONE 'UTC')::date + 1
         AND callsign <> ''
       ORDER BY callsign`,
      [icao, from, to]
    )]);
    const series = result.rows.map((activity) => ({
      bucketStart: iso(activity.bucket_start),
      bucketEnd: iso(activity.bucket_end),
      observations: number(activity.observations),
      positionedObservations: number(activity.positioned_observations),
      sessions: number(activity.sessions),
      closestRangeNm: nullableNumber(activity.closest_range_nm),
      maximumAltitudeFt: nullableNumber(activity.maximum_altitude_ft)
    }));
    return {
      icao,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: query.bucket,
      totals: {
        observations: series.reduce((sum, point) => sum + point.observations, 0),
        positionedObservations: series.reduce((sum, point) => sum + point.positionedObservations, 0),
        sessions: series.reduce((sum, point) => sum + point.sessions, 0),
        activeDays: result.rows.reduce((sum, point) => sum + number(point.active_days), 0),
        closestRangeNm: series.reduce<number | null>((best, point) =>
          point.closestRangeNm == null ? best : best == null ? point.closestRangeNm : Math.min(best, point.closestRangeNm), null),
        maximumAltitudeFt: series.reduce<number | null>((best, point) =>
          point.maximumAltitudeFt == null ? best : best == null ? point.maximumAltitudeFt : Math.max(best, point.maximumAltitudeFt), null)
      },
      callsigns: callsignResult.rows.map((point) => point.callsign),
      series,
      detailedTrackFrom: new Date(now.getTime() - this.config.historyRetentionDays * 86_400_000).toISOString()
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
           $4::text IS NULL
           OR lower(d.icao::text) LIKE '%' || lower($4) || '%'
           OR flightmap_callsigns_text(d.callsigns) LIKE '%' || lower($4) || '%'
           OR lower(m.registration) LIKE '%' || lower($4) || '%'
           OR lower(m.type_code) LIKE '%' || lower($4) || '%'
           OR lower(m.operator) LIKE '%' || lower($4) || '%'
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
        icao: normaliseIcao(row.icao),
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
}
