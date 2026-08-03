import {
  RepositoryBase,
  iso,
  json,
  number
} from "./repository-shared.js";

/** Receiver metadata and samples, and database/metadata health. */
export class StatusRepository extends RepositoryBase {
  async databaseReady(): Promise<boolean> {
    return this.database.healthy();
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
