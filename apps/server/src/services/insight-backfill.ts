import type { Database } from "../db/database.js";
import { utcDay } from "../domain/insights.js";

type Logger = {
  info: (object: unknown, message?: string) => void;
  error: (object: unknown, message?: string) => void;
};

type BackfillStateRow = {
  status: "pending" | "running" | "complete" | "failed";
  next_date: Date | string | null;
};

export function nextUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string): number {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000
    ) + 1
  );
}

function validatedPositionCtes(): string {
  return `raw_altitudes AS (
            SELECT p.*,
                   CASE
                     WHEN p.altitude_barometric_ft IS NOT NULL
                       AND p.altitude_geometric_ft IS NOT NULL
                       AND abs(p.altitude_barometric_ft - p.altitude_geometric_ft) <= 5000
                       THEN p.altitude_barometric_ft
                     WHEN p.altitude_barometric_ft IS NULL
                       THEN p.altitude_geometric_ft
                     WHEN p.altitude_geometric_ft IS NULL
                       THEN p.altitude_barometric_ft
                     ELSE NULL
                   END AS candidate_altitude_ft,
                   p.altitude_barometric_ft IS NOT NULL
                     AND p.altitude_geometric_ft IS NOT NULL
                     AND abs(p.altitude_barometric_ft - p.altitude_geometric_ft) <= 5000
                     AS altitude_sources_agree
            FROM position_samples p
            WHERE p.recorded_at >=
                    ($1::date::timestamp AT TIME ZONE 'UTC') - interval '30 seconds'
              AND p.recorded_at <
                    (($1::date + 1)::timestamp AT TIME ZONE 'UTC') + interval '30 seconds'
          ), altitude_context AS (
            SELECT r.*,
                   lag(r.candidate_altitude_ft) OVER sample_window AS previous_altitude_ft,
                   lag(r.recorded_at) OVER sample_window AS previous_recorded_at,
                   lead(r.candidate_altitude_ft) OVER sample_window AS next_altitude_ft,
                   lead(r.recorded_at) OVER sample_window AS next_recorded_at
            FROM raw_altitudes r
            WINDOW sample_window AS (PARTITION BY r.session_id ORDER BY r.recorded_at)
          ), altitude_continuity AS (
            SELECT c.*,
                   c.previous_altitude_ft IS NOT NULL
                     AND c.recorded_at > c.previous_recorded_at
                     AND c.recorded_at - c.previous_recorded_at <= interval '30 seconds'
                     AND abs(c.candidate_altitude_ft - c.previous_altitude_ft) <=
                       1000 + least(15000, greatest(
                         7500,
                         abs(COALESCE(c.barometric_rate_fpm, 0)),
                         abs(COALESCE(c.geometric_rate_fpm, 0))
                       )) * extract(epoch FROM c.recorded_at - c.previous_recorded_at) / 60
                     AS previous_continuous,
                   c.next_altitude_ft IS NOT NULL
                     AND c.next_recorded_at > c.recorded_at
                     AND c.next_recorded_at - c.recorded_at <= interval '30 seconds'
                     AND abs(c.next_altitude_ft - c.candidate_altitude_ft) <=
                       1000 + least(15000, greatest(
                         7500,
                         abs(COALESCE(c.barometric_rate_fpm, 0)),
                         abs(COALESCE(c.geometric_rate_fpm, 0))
                       )) * extract(epoch FROM c.next_recorded_at - c.recorded_at) / 60
                     AS next_continuous
            FROM altitude_context c
          ), validated_positions AS (
            SELECT a.*,
                   CASE
                     WHEN a.candidate_altitude_ft IS NULL
                       OR a.candidate_altitude_ft < -2000
                       OR a.candidate_altitude_ft > 130000
                       THEN NULL
                     WHEN a.candidate_altitude_ft > 60000 AND (
                       NOT a.altitude_sources_agree
                       OR NOT COALESCE(a.previous_continuous, false)
                       OR NOT COALESCE(a.next_continuous, false)
                       OR (a.nav_altitude_mcp_ft IS NOT NULL
                         AND a.nav_altitude_mcp_ft <= 60000
                         AND a.candidate_altitude_ft - a.nav_altitude_mcp_ft > 20000)
                       OR (a.nav_altitude_fms_ft IS NOT NULL
                         AND a.nav_altitude_fms_ft <= 60000
                         AND a.candidate_altitude_ft - a.nav_altitude_fms_ft > 20000)
                     ) THEN NULL
                     WHEN (a.previous_recorded_at IS NOT NULL OR a.next_recorded_at IS NOT NULL)
                       AND NOT (
                         COALESCE(a.previous_continuous, false)
                         OR COALESCE(a.next_continuous, false)
                       )
                       THEN NULL
                     ELSE a.candidate_altitude_ft
                   END AS trusted_altitude_ft
            FROM altitude_continuity a
            WHERE a.recorded_at >= $1::date::timestamp AT TIME ZONE 'UTC'
              AND a.recorded_at <
                    ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
          )`;
}

export class InsightBackfillService {
  private started = false;
  private activeRun: Promise<void> | null = null;

  constructor(
    private readonly database: Database,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    setImmediate(() => {
      if (!this.started || this.activeRun) return;
      this.activeRun = this.run().finally(() => {
        this.activeRun = null;
      });
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.activeRun) await this.activeRun.catch(() => undefined);
  }

  async run(): Promise<void> {
    try {
      const rangeResult = await this.database.query<{
        oldest_date: Date | string | null;
        newest_date: Date | string | null;
      }>(
        `SELECT min((recorded_at AT TIME ZONE 'UTC')::date) AS oldest_date,
                max((recorded_at AT TIME ZONE 'UTC')::date) AS newest_date
         FROM position_samples`
      );
      const range = rangeResult.rows[0];
      const oldest = range?.oldest_date
        ? utcDay(range.oldest_date)
        : null;
      const newest = range?.newest_date
        ? utcDay(range.newest_date)
        : null;
      if (!oldest || !newest) {
        await this.database.query(
          `UPDATE insight_backfill_state
           SET status = 'complete', oldest_date = NULL, newest_date = NULL,
               next_date = NULL, processed_days = 0, total_days = 0,
               completed_at = now(), last_error = NULL, updated_at = now()
           WHERE id = true`
        );
        return;
      }

      const stateResult = await this.database.query<BackfillStateRow>(
        "SELECT status, next_date FROM insight_backfill_state WHERE id = true"
      );
      const state = stateResult.rows[0];
      if (state?.status === "complete") return;
      let day = state?.next_date
        ? utcDay(state.next_date)
        : oldest;
      if (day < oldest || day > newest) day = oldest;
      const processed = Math.max(0, daysInclusive(oldest, day) - 1);
      await this.database.query(
        `UPDATE insight_backfill_state
         SET status = 'running', oldest_date = $1, newest_date = $2,
             next_date = $3, processed_days = $4, total_days = $5,
             started_at = COALESCE(started_at, now()), completed_at = NULL,
             last_error = NULL, updated_at = now()
         WHERE id = true`,
        [oldest, newest, day, processed, daysInclusive(oldest, newest)]
      );

      while (this.started && day <= newest) {
        await this.backfillDay(day);
        const next = nextUtcDate(day);
        const complete = day === newest;
        await this.database.query(
          `UPDATE insight_backfill_state
           SET status = $1, next_date = $2,
               processed_days = least(total_days, processed_days + 1),
               completed_at = CASE WHEN $1 = 'complete' THEN now() ELSE NULL END,
               updated_at = now()
           WHERE id = true`,
          [complete ? "complete" : "running", complete ? null : next]
        );
        day = next;
      }
      this.logger.info(
        { oldestDate: oldest, newestDate: newest },
        "Insight aggregate backfill completed"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database
        .query(
          `UPDATE insight_backfill_state
           SET status = 'failed', last_error = left($1, 2000), updated_at = now()
           WHERE id = true`,
          [message]
        )
        .catch(() => undefined);
      this.logger.error({ error }, "Insight aggregate backfill failed");
    }
  }

  private async backfillDay(day: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('flightmap:insights:' || $1)::bigint)",
        [day]
      );
      await client.query(
        `DELETE FROM hourly_aircraft_activity
         WHERE bucket_hour >= $1::date::timestamp AT TIME ZONE 'UTC'
           AND bucket_hour < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'`,
        [day]
      );
      await client.query(
        `INSERT INTO hourly_aircraft_activity (
           bucket_hour, icao, first_seen_at, last_seen_at, reports,
           positioned_reports, session_ids, callsigns, maximum_range_nm,
           maximum_altitude_ft
         )
         WITH ${validatedPositionCtes()}
         SELECT date_trunc('hour', recorded_at), icao, min(recorded_at),
                max(recorded_at), count(*), count(*),
                array_agg(DISTINCT session_id),
                COALESCE(
                  array_agg(DISTINCT callsign) FILTER (WHERE callsign IS NOT NULL),
                  '{}'::text[]
                ),
                max(distance_nm),
                max(trusted_altitude_ft)
         FROM validated_positions
         GROUP BY date_trunc('hour', recorded_at), icao`,
        [day]
      );
      await client.query(
        "DELETE FROM daily_coverage_cells WHERE coverage_date = $1",
        [day]
      );
      await client.query(
        "DELETE FROM daily_coverage_cell_aircraft WHERE coverage_date = $1",
        [day]
      );
      await client.query(
        `INSERT INTO daily_coverage_cells (
           coverage_date, latitude_index, longitude_index, reports,
           maximum_altitude_ft
         )
         WITH ${validatedPositionCtes()}
         SELECT $1::date,
                least(3599, greatest(0, floor((latitude + 90) / 0.05)::integer)),
                least(7199, greatest(0, floor((longitude + 180) / 0.05)::integer)),
                count(*),
                max(trusted_altitude_ft)
         FROM validated_positions
         GROUP BY 1, 2, 3`,
        [day]
      );
      await client.query(
        `INSERT INTO daily_coverage_cell_aircraft (
           coverage_date, latitude_index, longitude_index, icao
         )
         WITH ${validatedPositionCtes()}
         SELECT DISTINCT $1::date,
                least(3599, greatest(0, floor((latitude + 90) / 0.05)::integer)),
                least(7199, greatest(0, floor((longitude + 180) / 0.05)::integer)),
                trim(icao)
         FROM validated_positions
         ON CONFLICT DO NOTHING`,
        [day]
      );
      await client.query(
        "DELETE FROM daily_range_histogram WHERE profile_date = $1",
        [day]
      );
      await client.query(
        "DELETE FROM daily_range_histogram_aircraft WHERE profile_date = $1",
        [day]
      );
      await client.query(
        `INSERT INTO daily_range_histogram (
           profile_date, bearing_bucket, altitude_band, range_bucket_nm,
           reports
         )
         WITH ${validatedPositionCtes()}
         SELECT $1::date,
                floor(mod(mod(bearing_deg::numeric, 360) + 360, 360) / 5)::smallint,
                CASE
                  WHEN on_ground THEN 'ground'
                  WHEN trusted_altitude_ft IS NULL OR trusted_altitude_ft < 10000 THEN 'low'
                  WHEN trusted_altitude_ft < 25000 THEN 'medium'
                  ELSE 'high'
                END,
                least(500, floor(greatest(0, distance_nm) / 5) * 5)::smallint,
                count(*)
         FROM validated_positions
         WHERE bearing_deg IS NOT NULL AND distance_nm IS NOT NULL
         GROUP BY 1, 2, 3, 4`,
        [day]
      );
      await client.query(
        `INSERT INTO daily_range_histogram_aircraft (
           profile_date, bearing_bucket, altitude_band, range_bucket_nm, icao
         )
         WITH ${validatedPositionCtes()}
         SELECT DISTINCT $1::date,
                floor(mod(mod(bearing_deg::numeric, 360) + 360, 360) / 5)::smallint,
                CASE
                  WHEN on_ground THEN 'ground'
                  WHEN trusted_altitude_ft IS NULL OR trusted_altitude_ft < 10000 THEN 'low'
                  WHEN trusted_altitude_ft < 25000 THEN 'medium'
                  ELSE 'high'
                END,
                least(500, floor(greatest(0, distance_nm) / 5) * 5)::smallint,
                trim(icao)
         FROM validated_positions
         WHERE bearing_deg IS NOT NULL AND distance_nm IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [day]
      );
      await client.query(
        `UPDATE daily_aircraft_summary
         SET minimum_altitude_ft = NULL, maximum_altitude_ft = NULL
         WHERE summary_date = $1`,
        [day]
      );
      await client.query(
        `WITH ${validatedPositionCtes()}, per_aircraft AS (
           SELECT icao, min(trusted_altitude_ft) AS minimum_altitude_ft,
                  max(trusted_altitude_ft) AS maximum_altitude_ft,
                  max(distance_nm) AS maximum_range_nm
           FROM validated_positions
           GROUP BY icao
         ), per_session AS (
           SELECT session_id,
                  min(trusted_altitude_ft) AS minimum_altitude_ft,
                  max(trusted_altitude_ft) AS maximum_altitude_ft,
                  (array_agg(trusted_altitude_ft ORDER BY recorded_at DESC)
                    FILTER (WHERE trusted_altitude_ft IS NOT NULL))[1]
                    AS last_altitude_ft
           FROM validated_positions
           GROUP BY session_id
         ), daily_update AS (
           UPDATE daily_aircraft_summary d
           SET minimum_altitude_ft = p.minimum_altitude_ft,
               maximum_altitude_ft = p.maximum_altitude_ft,
               maximum_range_nm = p.maximum_range_nm
           FROM per_aircraft p
           WHERE d.summary_date = $1 AND d.icao = p.icao
           RETURNING d.icao
         )
         UPDATE track_sessions s
         SET minimum_altitude_ft = CASE
               WHEN p.minimum_altitude_ft IS NULL THEN s.minimum_altitude_ft
               WHEN s.minimum_altitude_ft IS NULL THEN p.minimum_altitude_ft
               ELSE least(s.minimum_altitude_ft, p.minimum_altitude_ft)
             END,
             maximum_altitude_ft = CASE
               WHEN p.maximum_altitude_ft IS NULL THEN s.maximum_altitude_ft
               WHEN s.maximum_altitude_ft IS NULL THEN p.maximum_altitude_ft
               ELSE greatest(s.maximum_altitude_ft, p.maximum_altitude_ft)
             END,
             last_altitude_ft = COALESCE(p.last_altitude_ft, s.last_altitude_ft),
             updated_at = now()
         FROM per_session p
         WHERE s.id = p.session_id`,
        [day]
      );
    });
  }
}
