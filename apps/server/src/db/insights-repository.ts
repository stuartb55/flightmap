import type {
  CoverageCellDetailQuery,
  CoverageCellDetailResponse,
  InsightAvailability,
  InsightCoverageQuery,
  InsightCoverageResponse,
  InsightLeader,
  InsightOverview,
  InsightPatternsQuery,
  InsightPatternsResponse,
  InsightQuery,
  RangeProfileQuery,
  RangeProfileResponse
} from "@flightmap/shared";
import {
  airlineOperatorRows
} from "../domain/airline-operators.js";
import {
  coverageGridCell,
  coverageGridCellFromIndices,
  insightMetricChanges,
  receiverPerformanceForBucket
} from "../domain/insights.js";
import type {
  InsightAggregateRow,
  InsightSeriesRow,
  MetadataRow,
  ReceiverInsightRow
} from "./repository-shared.js";
import {
  RepositoryBase,
  RepositoryInputError,
  insightMetricsFromRow,
  iso,
  nullableNumber,
  number,
  utcDate
} from "./repository-shared.js";

/** Aggregated activity, coverage, patterns and range profiles. */
export class InsightsRepository extends RepositoryBase {
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
    // Sessions and callsigns are grouped once per ICAO rather than recomputed
    // by a correlated subquery for every row of the leaderboard.
    const activityCte = hourly
      ? `WITH filtered AS (
           SELECT * FROM hourly_aircraft_activity
           WHERE bucket_hour >= $1 AND bucket_hour < $2
         ), activity_totals AS (
           SELECT f.icao, sum(f.reports) AS reports,
                  sum(f.positioned_reports) AS positioned_reports
           FROM filtered f GROUP BY f.icao
         ), activity_sessions AS (
           SELECT f.icao, count(DISTINCT s.session_id) AS sessions
           FROM filtered f
           CROSS JOIN LATERAL unnest(f.session_ids) AS s(session_id)
           GROUP BY f.icao
         ), activity_callsigns AS (
           SELECT f.icao, array_agg(DISTINCT trim(c.callsign)) AS callsigns
           FROM filtered f
           CROSS JOIN LATERAL unnest(f.callsigns) AS c(callsign)
           WHERE NULLIF(trim(c.callsign), '') IS NOT NULL
           GROUP BY f.icao
         ), activity AS (
           SELECT t.icao, t.reports, t.positioned_reports,
                  COALESCE(s.sessions, 0) AS sessions,
                  COALESCE(c.callsigns, '{}'::text[]) AS callsigns
           FROM activity_totals t
           LEFT JOIN activity_sessions s ON s.icao = t.icao
           LEFT JOIN activity_callsigns c ON c.icao = t.icao
         )`
      : `WITH filtered AS (
           SELECT * FROM daily_aircraft_summary
           WHERE summary_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
             AND summary_date < ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)
         ), activity_totals AS (
           SELECT f.icao, sum(f.observations) AS reports,
                  sum(f.positioned_observations) AS positioned_reports,
                  sum(f.session_count) AS sessions
           FROM filtered f GROUP BY f.icao
         ), activity_callsigns AS (
           SELECT f.icao, array_agg(DISTINCT trim(c.callsign)) AS callsigns
           FROM filtered f
           CROSS JOIN LATERAL unnest(f.callsigns) AS c(callsign)
           WHERE NULLIF(trim(c.callsign), '') IS NOT NULL
           GROUP BY f.icao
         ), activity AS (
           SELECT t.icao, t.reports, t.positioned_reports, t.sessions,
                  COALESCE(c.callsigns, '{}'::text[]) AS callsigns
           FROM activity_totals t
           LEFT JOIN activity_callsigns c ON c.icao = t.icao
         )`;
    const leadersSql = `${activityCte}, reference_designators AS (
         SELECT upper(d.designator) AS designator, d.operator
         FROM jsonb_to_recordset($3::jsonb) AS d(
           designator text, operator text
         )
       ), designator_evidence AS (
         SELECT left(upper(trim(s.latest_callsign)), 3) AS designator,
                COALESCE(NULLIF(m.operator, ''),
                         NULLIF(s.latest_operator, '')) AS operator,
                count(*) AS aircraft_count
         FROM aircraft_summary s
         LEFT JOIN aircraft_metadata m ON m.icao = s.icao
         WHERE upper(trim(s.latest_callsign)) ~ '^[A-Z]{3}[0-9][A-Z0-9]{0,4}$'
           AND COALESCE(NULLIF(m.operator, ''),
                        NULLIF(s.latest_operator, '')) IS NOT NULL
         GROUP BY left(upper(trim(s.latest_callsign)), 3),
                  COALESCE(NULLIF(m.operator, ''),
                           NULLIF(s.latest_operator, ''))
       ), ranked_designator_evidence AS (
         SELECT designator, operator, aircraft_count,
                row_number() OVER (
                  PARTITION BY designator
                  ORDER BY aircraft_count DESC, operator
                ) AS rank
         FROM designator_evidence
       ), designators AS (
         SELECT designator, operator FROM reference_designators
         UNION ALL
         SELECT e.designator, e.operator
         FROM ranked_designator_evidence e
         WHERE e.rank = 1 AND e.aircraft_count >= 2
           AND NOT EXISTS (
             SELECT 1 FROM reference_designators r
             WHERE r.designator = e.designator
           )
       ), resolved AS (
         SELECT a.icao, a.reports, a.positioned_reports, a.sessions,
                COALESCE(NULLIF(m.registration, ''),
                         NULLIF(s.latest_registration, '')) AS registration,
                COALESCE(NULLIF(m.type_code, ''),
                         NULLIF(s.latest_type_code, '')) AS type_code,
                NULLIF(m.description, '') AS description,
                COALESCE(call.operator, NULLIF(m.operator, ''),
                         NULLIF(s.latest_operator, '')) AS operator,
                call.designator AS inferred_designator,
                (SELECT min(trim(c.callsign))
                 FROM unnest(a.callsigns) AS c(callsign)
                 WHERE NULLIF(trim(c.callsign), '') IS NOT NULL) AS callsign
         FROM activity a
         LEFT JOIN aircraft_metadata m ON m.icao = a.icao
         LEFT JOIN aircraft_summary s ON s.icao = a.icao
         LEFT JOIN LATERAL (
           SELECT d.operator, d.designator
           FROM unnest(a.callsigns) AS c(callsign)
           JOIN designators d
             ON d.designator = left(upper(trim(c.callsign)), 3)
           WHERE upper(trim(c.callsign)) ~ '^[A-Z]{3}[0-9][A-Z0-9]{0,4}$'
           ORDER BY d.designator
           LIMIT 1
         ) call ON true
       ), leaders AS (
         SELECT 'aircraft'::text AS kind, trim(r.icao) AS key,
                COALESCE(r.registration, r.callsign,
                         upper(trim(r.icao))) AS label,
                NULLIF(concat_ws(' · ',
                  COALESCE(r.type_code, r.description), r.operator), '') AS secondary,
                r.reports, r.positioned_reports, r.sessions
         FROM resolved r
         UNION ALL
         SELECT 'types',
                COALESCE(lower(r.type_code), lower(r.description), 'unknown'),
                COALESCE(r.type_code, r.description, 'Unknown type'),
                min(r.description) FILTER (WHERE r.type_code IS NOT NULL),
                sum(r.reports), sum(r.positioned_reports), sum(r.sessions)
         FROM resolved r
         GROUP BY COALESCE(lower(r.type_code), lower(r.description), 'unknown'),
                  COALESCE(r.type_code, r.description, 'Unknown type')
         UNION ALL
         SELECT 'operators', COALESCE(lower(r.operator), 'unknown'),
                COALESCE(r.operator, 'Unknown operator'),
                CASE WHEN bool_or(r.inferred_designator IS NOT NULL)
                  THEN 'Inferred from ' || string_agg(
                    DISTINCT r.inferred_designator, ', '
                    ORDER BY r.inferred_designator
                  ) || ' callsign'
                  ELSE NULL
                END,
                sum(r.reports), sum(r.positioned_reports), sum(r.sessions)
         FROM resolved r
         GROUP BY COALESCE(lower(r.operator), 'unknown'),
                  COALESCE(r.operator, 'Unknown operator')
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
        }>(leadersSql, [from, to, JSON.stringify(airlineOperatorRows)]),
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

  async insightPatterns(
    query: InsightPatternsQuery,
    now = new Date()
  ): Promise<InsightPatternsResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const duration = to.getTime() - from.getTime();
    if (duration > 366 * 86_400_000) {
      throw new RepositoryInputError("RANGE_TOO_LARGE", "Pattern queries are limited to 366 days");
    }
    const previousFrom = new Date(from.getTime() - duration);
    const result = await this.database.query<{
      period: "current" | "previous";
      weekday: number | string;
      hour: number | string;
      unique_aircraft: number | string;
      reports: number | string;
      sessions: number | string;
    }>(
      `WITH ranges(period, range_from, range_to) AS (
         VALUES ('current'::text, $1::timestamptz, $2::timestamptz),
                ('previous'::text, $3::timestamptz, $1::timestamptz)
       ), activity AS (
         SELECT r.period,
                extract(isodow FROM h.bucket_hour AT TIME ZONE $4)::int - 1 AS weekday,
                extract(hour FROM h.bucket_hour AT TIME ZONE $4)::int AS hour,
                count(DISTINCT h.icao) AS unique_aircraft,
                sum(h.reports) AS reports
         FROM ranges r
         JOIN hourly_aircraft_activity h ON h.bucket_hour >= r.range_from AND h.bucket_hour < r.range_to
         WHERE r.period = 'current' OR $5::boolean
         GROUP BY r.period, weekday, hour
       ), session_counts AS (
         SELECT r.period,
                extract(isodow FROM h.bucket_hour AT TIME ZONE $4)::int - 1 AS weekday,
                extract(hour FROM h.bucket_hour AT TIME ZONE $4)::int AS hour,
                count(DISTINCT session_id) AS sessions
         FROM ranges r
         JOIN hourly_aircraft_activity h ON h.bucket_hour >= r.range_from AND h.bucket_hour < r.range_to
         CROSS JOIN LATERAL unnest(h.session_ids) session_id
         WHERE r.period = 'current' OR $5::boolean
         GROUP BY r.period, weekday, hour
       )
       SELECT a.*, coalesce(s.sessions, 0) AS sessions
       FROM activity a
       LEFT JOIN session_counts s USING (period, weekday, hour)
       ORDER BY a.period, a.weekday, a.hour`,
      [from, to, previousFrom, query.timeZone, query.compare]
    );
    const previous = new Map(
      result.rows.filter((row) => row.period === "previous")
        .map((row) => [`${row.weekday}:${row.hour}`, number(row.reports)])
    );
    const cells = result.rows.filter((row) => row.period === "current").map((row) => {
      const previousReports = previous.get(`${row.weekday}:${row.hour}`) ?? null;
      const reports = number(row.reports);
      return {
        weekday: number(row.weekday),
        hour: number(row.hour),
        uniqueAircraft: number(row.unique_aircraft),
        sessions: number(row.sessions),
        reports,
        previousReports,
        changePercent: previousReports == null || previousReports === 0
          ? null
          : ((reports - previousReports) / previousReports) * 100
      };
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: query.timeZone,
      cells,
      busiest: cells.reduce<(typeof cells)[number] | null>((best, cell) =>
        !best || cell.reports > best.reports ? cell : best, null),
      availability: await this.insightAvailability(from, now)
    };
  }

  async rangeProfile(query: RangeProfileQuery): Promise<RangeProfileResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const duration = to.getTime() - from.getTime();
    if (duration > 366 * 86_400_000) {
      throw new RepositoryInputError("RANGE_TOO_LARGE", "Range profiles are limited to 366 days");
    }
    const previousFrom = new Date(from.getTime() - duration);
    const [result, availability] = await Promise.all([
      this.database.query<{
        period: "current" | "previous";
        bearing_bucket: number;
        range_bucket_nm: number;
        reports: number | string;
      }>(
        `WITH ranges(period, range_from, range_to) AS (
           VALUES ('current'::text, ($1::timestamptz AT TIME ZONE 'UTC')::date, (($2::timestamptz AT TIME ZONE 'UTC')::date + 1)),
                  ('previous'::text, ($3::timestamptz AT TIME ZONE 'UTC')::date, ($1::timestamptz AT TIME ZONE 'UTC')::date)
         )
         SELECT r.period, h.bearing_bucket, h.range_bucket_nm, sum(h.reports) AS reports
         FROM ranges r
         JOIN daily_range_histogram h ON h.profile_date >= r.range_from AND h.profile_date < r.range_to
         WHERE ($4::text = 'all' OR h.altitude_band = $4)
           AND (r.period = 'current' OR $5::boolean)
         GROUP BY r.period, h.bearing_bucket, h.range_bucket_nm
         ORDER BY r.period, h.bearing_bucket, h.range_bucket_nm`,
        [from, to, previousFrom, query.altitudeBand, query.compare]
      ),
      this.database.query<{ available_from: Date | string | null }>(
        "SELECT min(profile_date) AS available_from FROM daily_range_histogram"
      )
    ]);
    const percentile = (rows: typeof result.rows, fraction: number): number | null => {
      const total = rows.reduce((sum, row) => sum + number(row.reports), 0);
      if (!total) return null;
      const target = total * fraction;
      let cumulative = 0;
      for (const row of rows) {
        cumulative += number(row.reports);
        if (cumulative >= target) return row.range_bucket_nm + 2.5;
      }
      return rows.at(-1)?.range_bucket_nm ?? null;
    };
    const sectorRows = (period: "current" | "previous", bearing: number) =>
      result.rows.filter((row) => row.period === period && row.bearing_bucket === bearing);
    const sectors = Array.from({ length: 72 }, (_, bearing) => {
      const current = sectorRows("current", bearing);
      const previous = sectorRows("previous", bearing);
      const p95 = percentile(current, 0.95);
      const previousP95 = percentile(previous, 0.95);
      return {
        bearingStartDeg: bearing * 5,
        bearingEndDeg: bearing * 5 + 5,
        reports: current.reduce((sum, row) => sum + number(row.reports), 0),
        medianRangeNm: percentile(current, 0.5),
        p95RangeNm: p95,
        maximumRangeNm: current.length ? current.at(-1)!.range_bucket_nm + 5 : null,
        previousP95RangeNm: previousP95,
        p95ChangeNm: p95 == null || previousP95 == null ? null : p95 - previousP95
      };
    });
    const available = availability.rows[0]?.available_from;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      altitudeBand: query.altitudeBand,
      sectors,
      availableFrom: available ? utcDate(available) : null
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
        `WITH bounds AS (
           SELECT ($1::timestamptz AT TIME ZONE 'UTC')::date AS from_date,
                  ((($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1) AS to_date
         ),
         filtered AS (
           SELECT c.latitude_index, c.longitude_index,
                  sum(c.reports) AS reports,
                  max(c.maximum_altitude_ft) AS maximum_altitude_ft
           FROM daily_coverage_cells c, bounds b
           WHERE c.coverage_date >= b.from_date AND c.coverage_date < b.to_date
           GROUP BY c.latitude_index, c.longitude_index
         ),
         distinct_aircraft AS (
           SELECT a.latitude_index, a.longitude_index,
                  count(DISTINCT a.icao) AS unique_aircraft
           FROM daily_coverage_cell_aircraft a, bounds b
           WHERE a.coverage_date >= b.from_date AND a.coverage_date < b.to_date
           GROUP BY a.latitude_index, a.longitude_index
         )
         SELECT f.latitude_index, f.longitude_index, f.reports,
                coalesce(d.unique_aircraft, 0) AS unique_aircraft,
                f.maximum_altitude_ft
         FROM filtered f
         LEFT JOIN distinct_aircraft d
           ON d.latitude_index = f.latitude_index
          AND d.longitude_index = f.longitude_index
         ORDER BY f.reports DESC, f.latitude_index, f.longitude_index
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
        const cell = coverageGridCellFromIndices(
          row.latitude_index,
          row.longitude_index
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

  async coverageCellDetail(
    query: CoverageCellDetailQuery
  ): Promise<CoverageCellDetailResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const grid = coverageGridCell(query.latitude, query.longitude);
    const result = await this.database.query<{
      reports: number | string;
      maximum_altitude_ft: number | string | null;
      aircraft_icaos: string[];
    }>(
      `SELECT coalesce(sum(reports), 0) AS reports,
              max(maximum_altitude_ft) AS maximum_altitude_ft,
              ARRAY(SELECT DISTINCT nested.icao
                    FROM daily_coverage_cell_aircraft nested
                    WHERE nested.coverage_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
                      AND nested.coverage_date < (($2::timestamptz AT TIME ZONE 'UTC')::date + 1)
                      AND nested.latitude_index = $3
                      AND nested.longitude_index = $4
                    ORDER BY nested.icao) AS aircraft_icaos
       FROM daily_coverage_cells
       WHERE coverage_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
         AND coverage_date < (($2::timestamptz AT TIME ZONE 'UTC')::date + 1)
         AND latitude_index = $3 AND longitude_index = $4`,
      [from, to, grid.latitudeIndex, grid.longitudeIndex]
    );
    const row = result.rows[0] ?? {
      reports: 0,
      maximum_altitude_ft: null,
      aircraft_icaos: []
    };
    const metadata = row.aircraft_icaos.length === 0
      ? { rows: [] as MetadataRow[] }
      : await this.database.query<MetadataRow>(
          `SELECT requested.icao, m.registration, m.type_code, m.description,
                  m.operator, m.owner, m.country
           FROM unnest($1::text[]) requested(icao)
           LEFT JOIN aircraft_metadata m ON m.icao = requested.icao
           ORDER BY coalesce(m.registration, requested.icao)`,
          [row.aircraft_icaos]
        );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      cell: {
        latitude: grid.latitude,
        longitude: grid.longitude,
        south: grid.south,
        west: grid.west,
        north: grid.north,
        east: grid.east,
        reports: number(row.reports),
        uniqueAircraft: row.aircraft_icaos.length,
        maximumAltitudeFt: nullableNumber(row.maximum_altitude_ft)
      },
      aircraft: metadata.rows.map((item) => ({
        icao: item.icao,
        registration: item.registration,
        typeCode: item.type_code,
        operator: item.operator
      }))
    };
  }
}
