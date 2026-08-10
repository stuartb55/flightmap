import type pg from "pg";
import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import type { PhotoRepository } from "../db/photo-repository.js";

type Logger = {
  info: (object: unknown, message?: string) => void;
  error: (object: unknown, message?: string) => void;
};

export type MaintenanceResult = {
  ranAt: string;
  cutoffAt: string;
  droppedPartitions: number;
  deletedSessions: number;
  deletedAlerts: number;
  deletedReceiverSamples: number;
  deletedHourlyActivity: number;
  expiredPhotos: number;
  evictedPhotos: number;
  failedSteps: string[];
};

/** Advisory lock key shared by every process that runs maintenance. */
const MAINTENANCE_LOCK_KEY = 1_907_182_026;
/** Rows removed per committed batch; keeps each statement far under the
 *  60 s statement timeout and releases locks between batches. */
const DELETE_BATCH_SIZE = 5_000;
/** Safety valve so a delete that never converges cannot spin forever. */
const MAX_DELETE_BATCHES = 2_000;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function retentionCutoff(
  now: Date,
  retentionDays: number
): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

function partitionDate(name: string): string | null {
  const match = /^position_samples_(\d{4})(\d{2})(\d{2})$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export class MaintenanceService {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<MaintenanceResult> | null = null;
  private started = false;

  constructor(
    private readonly database: Database,
    private readonly config: Pick<
      Config,
      "historyRetentionDays" | "sessionGapSeconds"
    >,
    private readonly logger: Logger,
    /**
     * The photograph cache, which is bounded by count as well as by age and so
     * cannot be swept by the age-based helpers below. Absent where maintenance
     * runs without one — the CLI, and every test that predates the cache — in
     * which case the step is skipped rather than failing the run.
     */
    private readonly photos?: PhotoRepository,
    /** How many photographs the cache may hold; read per run, not per boot. */
    private readonly photoCacheEntries: () => number = () => 2_000,
  ) {}

  /**
   * Each step commits on its own. A slow delete must not roll back the
   * partition drops that actually reclaim disk, and the ACCESS EXCLUSIVE lock
   * a `DROP TABLE` takes must not be held for the length of the whole run.
   */
  async run(now = new Date()): Promise<MaintenanceResult> {
    const cutoff = retentionCutoff(now, this.config.historyRetentionDays);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    const failedSteps: string[] = [];
    let droppedPartitions = 0;
    let deletedSessions = 0;
    let deletedAlerts = 0;
    let deletedReceiverSamples = 0;
    let deletedHourlyActivity = 0;
    let expiredPhotos = 0;
    let evictedPhotos = 0;

    await this.database.connect(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [MAINTENANCE_LOCK_KEY]
      );
      if (!lock.rows[0]?.acquired) {
        this.logger.info({}, "Retention maintenance already running elsewhere");
        failedSteps.push("lock");
        return;
      }
      try {
        const step = async (
          name: string,
          work: () => Promise<void>
        ): Promise<void> => {
          try {
            await work();
          } catch (error) {
            failedSteps.push(name);
            this.logger.error({ error, step: name }, "Maintenance step failed");
          }
        };

        await step("ensure_partitions", async () => {
          await this.inTransaction(client, async () => {
            for (let offset = 0; offset <= 2; offset += 1) {
              await client.query("SELECT ensure_position_partition($1)", [
                new Date(now.getTime() + offset * 86_400_000)
              ]);
            }
          });
        });

        await step("drop_partitions", async () => {
          droppedPartitions = await this.dropExpiredPartitions(
            client,
            cutoffDay
          );
        });

        await step("close_sessions", async () => {
          await this.inTransaction(client, async () => {
            await client.query(
              `UPDATE track_sessions
               SET ended_at = last_position_at, updated_at = now()
               WHERE ended_at IS NULL
                 AND last_position_at < $1::timestamptz - make_interval(secs => $2)`,
              [now, this.config.sessionGapSeconds]
            );
            await client.query(
              `UPDATE current_aircraft c
               SET session_id = NULL,
                   state = jsonb_set(c.state, '{sessionId}', 'null'::jsonb)
               FROM track_sessions s
               WHERE c.session_id = s.id AND s.ended_at IS NOT NULL`
            );
          });
        });

        await step("delete_sessions", async () => {
          deletedSessions = await this.deleteInBatches(
            client,
            "track_sessions",
            "last_position_at < $1",
            [cutoff]
          );
        });

        await step("delete_alerts", async () => {
          deletedAlerts = await this.deleteInBatches(
            client,
            "alert_events",
            "occurred_at < $1",
            [cutoff]
          );
        });

        await step("delete_receiver_samples", async () => {
          deletedReceiverSamples = await this.deleteInBatches(
            client,
            "receiver_samples",
            "recorded_at < $1",
            [cutoff]
          );
        });

        await step("delete_hourly_activity", async () => {
          deletedHourlyActivity = await this.deleteInBatches(
            client,
            "hourly_aircraft_activity",
            "bucket_hour < date_trunc('hour', $1::timestamptz)",
            [cutoff]
          );
        });

        /*
         * Inside the same lock as the retention steps, and after them: the
         * photograph cache is the one table bounded by entry count rather than
         * by age, so it needs its own pass. Expired rows go first because that
         * usually brings the cache under its limit on its own, and only what is
         * left over is thrown away while still good.
         */
        await step("evict_photos", async () => {
          if (!this.photos) return;
          const result = await this.photos.evict(this.photoCacheEntries());
          expiredPhotos = result.expired;
          evictedPhotos = result.evicted;
        });

        await step("log", async () => {
          await client.query(
            `INSERT INTO maintenance_log (
               retention_days, dropped_partitions, deleted_sessions,
               deleted_alerts, deleted_receiver_samples,
               deleted_hourly_activity, expired_photos, evicted_photos
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              this.config.historyRetentionDays,
              droppedPartitions,
              deletedSessions,
              deletedAlerts,
              deletedReceiverSamples,
              deletedHourlyActivity,
              expiredPhotos,
              evictedPhotos
            ]
          );
        });
      } finally {
        await client
          .query("SELECT pg_advisory_unlock($1)", [MAINTENANCE_LOCK_KEY])
          .catch(() => undefined);
      }
    });

    const summary: MaintenanceResult = {
      ranAt: now.toISOString(),
      cutoffAt: cutoff.toISOString(),
      droppedPartitions,
      deletedSessions,
      deletedAlerts,
      deletedReceiverSamples,
      deletedHourlyActivity,
      expiredPhotos,
      evictedPhotos,
      failedSteps
    };
    this.logger.info(
      summary,
      failedSteps.length > 0
        ? "Retention maintenance completed with failures"
        : "Retention maintenance completed"
    );
    return summary;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const runAndReschedule = async (): Promise<void> => {
      let delay = RUN_INTERVAL_MS;
      this.activeRun = this.run();
      await this.activeRun
        .then((result) => {
          if (result.failedSteps.length > 0) delay = RETRY_AFTER_FAILURE_MS;
        })
        .catch((error) => {
          delay = RETRY_AFTER_FAILURE_MS;
          this.logger.error({ error }, "Retention maintenance failed");
        });
      this.activeRun = null;
      if (!this.started) return;
      this.timer = setTimeout(() => void runAndReschedule(), delay);
      this.timer.unref();
    };
    void runAndReschedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.activeRun) await this.activeRun.catch(() => undefined);
  }

  private async inTransaction(
    client: pg.PoolClient,
    work: () => Promise<void>
  ): Promise<void> {
    await client.query("BEGIN");
    try {
      await work();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async dropExpiredPartitions(
    client: pg.PoolClient,
    cutoffDay: string
  ): Promise<number> {
    const partitions = await client.query<{ partition_name: string }>(
      `SELECT child.relname AS partition_name
       FROM pg_inherits
       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
       JOIN pg_class child ON pg_inherits.inhrelid = child.oid
       WHERE parent.oid = 'position_samples'::regclass`
    );
    let dropped = 0;
    for (const row of partitions.rows) {
      const date = partitionDate(row.partition_name);
      // Keep the cutoff's partial UTC day; it is dropped on the next run.
      if (date === null || date >= cutoffDay) continue;
      try {
        await this.inTransaction(client, async () => {
          // Give up rather than queue behind the collector: the partition is
          // still expired on the next run.
          await client.query("SET LOCAL lock_timeout = '5s'");
          await client.query(`DROP TABLE IF EXISTS "${row.partition_name}"`);
        });
        dropped += 1;
      } catch (error) {
        this.logger.error(
          { error, partition: row.partition_name },
          "Could not drop expired partition"
        );
      }
    }
    return dropped;
  }

  /**
   * Deletes in committed batches keyed by `ctid` so no single statement can
   * exceed the query timeout or hold row locks across the whole table.
   * `table` and `predicate` are code constants, never user input.
   */
  private async deleteInBatches(
    client: pg.PoolClient,
    table: string,
    predicate: string,
    values: readonly unknown[]
  ): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
      let removed = 0;
      await this.inTransaction(client, async () => {
        const result = await client.query(
          `WITH doomed AS (
             SELECT ctid FROM ${table} WHERE ${predicate}
             LIMIT ${DELETE_BATCH_SIZE}
           )
           DELETE FROM ${table} target
           USING doomed
           WHERE target.ctid = doomed.ctid`,
          values as unknown[]
        );
        removed = result.rowCount ?? 0;
      });
      deleted += removed;
      if (removed < DELETE_BATCH_SIZE) return deleted;
    }
    this.logger.error(
      { table, deleted },
      "Batched delete hit its batch ceiling; remaining rows wait for the next run"
    );
    return deleted;
  }
}

export function createMaintenanceService(
  database: Database,
  config: Pick<Config, "historyRetentionDays" | "sessionGapSeconds">,
  logger: Logger,
  photos?: PhotoRepository,
  photoCacheEntries?: () => number
): MaintenanceService {
  return new MaintenanceService(
    database,
    config,
    logger,
    photos,
    photoCacheEntries
  );
}
