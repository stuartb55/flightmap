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
         SELECT date_trunc('hour', recorded_at), icao, min(recorded_at),
                max(recorded_at), count(*), count(*),
                array_agg(DISTINCT session_id),
                COALESCE(
                  array_agg(DISTINCT callsign) FILTER (WHERE callsign IS NOT NULL),
                  '{}'::text[]
                ),
                max(distance_nm),
                max(COALESCE(altitude_barometric_ft, altitude_geometric_ft))
         FROM position_samples
         WHERE recorded_at >= $1::date::timestamp AT TIME ZONE 'UTC'
           AND recorded_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
         GROUP BY date_trunc('hour', recorded_at), icao`,
        [day]
      );
      await client.query(
        "DELETE FROM daily_coverage_cells WHERE coverage_date = $1",
        [day]
      );
      await client.query(
        `INSERT INTO daily_coverage_cells (
           coverage_date, latitude_index, longitude_index, reports,
           aircraft_icaos, maximum_altitude_ft
         )
         SELECT $1::date,
                least(3599, greatest(0, floor((latitude + 90) / 0.05)::integer)),
                least(7199, greatest(0, floor((longitude + 180) / 0.05)::integer)),
                count(*), array_agg(DISTINCT trim(icao)),
                max(COALESCE(altitude_barometric_ft, altitude_geometric_ft))
         FROM position_samples
         WHERE recorded_at >= $1::date::timestamp AT TIME ZONE 'UTC'
           AND recorded_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
         GROUP BY 1, 2, 3`,
        [day]
      );
      await client.query(
        `UPDATE daily_aircraft_summary d
         SET maximum_range_nm = p.maximum_range_nm
         FROM (
           SELECT icao, max(distance_nm) AS maximum_range_nm
           FROM position_samples
           WHERE recorded_at >= $1::date::timestamp AT TIME ZONE 'UTC'
             AND recorded_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
           GROUP BY icao
         ) p
         WHERE d.summary_date = $1 AND d.icao = p.icao`,
        [day]
      );
    });
  }
}
