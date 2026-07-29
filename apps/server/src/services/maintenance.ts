import type { Config } from "../config.js";
import type { Database } from "../db/database.js";

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
};

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
  ) {}

  async run(now = new Date()): Promise<MaintenanceResult> {
    const cutoff = retentionCutoff(now, this.config.historyRetentionDays);
    const cutoffDay = cutoff.toISOString().slice(0, 10);

    const result = await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_907_182_026]);
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
      for (let offset = 0; offset <= 2; offset += 1) {
        await client.query("SELECT ensure_position_partition($1)", [
          new Date(now.getTime() + offset * 86_400_000)
        ]);
      }

      const partitions = await client.query<{ partition_name: string }>(
        `SELECT child.relname AS partition_name
         FROM pg_inherits
         JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
         JOIN pg_class child ON pg_inherits.inhrelid = child.oid
         WHERE parent.oid = 'position_samples'::regclass`
      );
      let droppedPartitions = 0;
      for (const row of partitions.rows) {
        const date = partitionDate(row.partition_name);
        // Keep the cutoff's partial UTC day; it is dropped on the next run.
        if (date !== null && date < cutoffDay) {
          await client.query(`DROP TABLE IF EXISTS "${row.partition_name}"`);
          droppedPartitions += 1;
        }
      }

      const sessions = await client.query(
        "DELETE FROM track_sessions WHERE last_position_at < $1",
        [cutoff]
      );
      const alerts = await client.query(
        "DELETE FROM alert_events WHERE occurred_at < $1",
        [cutoff]
      );
      const receiverSamples = await client.query(
        "DELETE FROM receiver_samples WHERE recorded_at < $1",
        [cutoff]
      );
      await client.query(
        `INSERT INTO maintenance_log (
           retention_days, dropped_partitions, deleted_sessions,
           deleted_alerts, deleted_receiver_samples
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          this.config.historyRetentionDays,
          droppedPartitions,
          sessions.rowCount ?? 0,
          alerts.rowCount ?? 0,
          receiverSamples.rowCount ?? 0
        ]
      );
      return {
        droppedPartitions,
        deletedSessions: sessions.rowCount ?? 0,
        deletedAlerts: alerts.rowCount ?? 0,
        deletedReceiverSamples: receiverSamples.rowCount ?? 0
      };
    });
    const summary = {
      ranAt: now.toISOString(),
      cutoffAt: cutoff.toISOString(),
      ...result
    };
    this.logger.info(summary, "Retention maintenance completed");
    return summary;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const runAndReschedule = async (): Promise<void> => {
      this.activeRun = this.run();
      await this.activeRun.catch((error) => {
        this.logger.error({ error }, "Retention maintenance failed");
      });
      this.activeRun = null;
      if (!this.started) return;
      this.timer = setTimeout(
        () => void runAndReschedule(),
        24 * 60 * 60 * 1000
      );
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
}

export function createMaintenanceService(
  database: Database,
  config: Pick<Config, "historyRetentionDays" | "sessionGapSeconds">,
  logger: Logger
): MaintenanceService {
  return new MaintenanceService(database, config, logger);
}
