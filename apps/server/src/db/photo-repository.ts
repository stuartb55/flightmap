import type { Database } from "./database.js";

/**
 * The aircraft photograph cache.
 *
 * Persistence only: what a photograph is, whether one may be fetched, and what
 * to do when the upstream misbehaves all live in `services/aircraft-photos.ts`.
 * Splitting them is what lets the service be tested against a stub upstream
 * without a database and the eviction be tested against a database without a
 * network.
 */

export type PhotoStatus = "present" | "absent" | "failed";

/** What the profile path needs: is there an answer, and is it still good. */
export type PhotoState = {
  status: PhotoStatus;
  expired: boolean;
  credit: string | null;
  linkUrl: string | null;
  width: number | null;
  height: number | null;
};

/** What the image endpoint needs, which is the bytes and a way to cache them. */
export type PhotoImage = {
  image: Buffer;
  contentType: string;
  etag: string;
};

export type PhotoRecord = {
  status: PhotoStatus;
  image?: Buffer;
  contentType?: string;
  width?: number;
  height?: number;
  credit?: string | null;
  linkUrl?: string | null;
  sourceUrl?: string | null;
  /** Seconds from now; the caller decides which of the two TTLs applies. */
  ttlSeconds: number;
};

export type PhotoEviction = {
  expired: number;
  evicted: number;
};

/** What the Settings card reports about the cache it is offering to clear. */
export type PhotoCacheSummary = {
  /** Rows holding an image. */
  photographs: number;
  /** Rows recording that there is no photograph, or that a fetch failed. */
  misses: number;
  bytes: number;
};

type StateRow = {
  status: PhotoStatus;
  expired: boolean;
  credit: string | null;
  link_url: string | null;
  width: number | null;
  height: number | null;
};

type ImageRow = {
  image: Buffer;
  content_type: string;
  bytes: number;
  fetched_at: Date | string;
};

/**
 * Strong, and derived rather than stored: the pair identifies these exact bytes
 * for this airframe, which is all an ETag has to do when every URL holds one
 * photograph. A refetch moves `fetched_at` even when the upstream returns the
 * same image, which costs one re-download in the browser per TTL and saves a
 * column and a hash over every stored image.
 */
function photoEtag(row: ImageRow): string {
  const fetched = new Date(row.fetched_at).getTime();
  return `"${row.bytes.toString(36)}-${fetched.toString(36)}"`;
}

export class PhotoRepository {
  constructor(private readonly database: Database) {}

  /**
   * Undefined when nothing has been asked yet. An expired row is still
   * returned, because what it says about the airframe — that there was a
   * photograph, or that there was not — stays useful while the refetch runs.
   */
  async state(icao: string): Promise<PhotoState | undefined> {
    const result = await this.database.pool.query<StateRow>(
      `SELECT status, expires_at <= now() AS expired,
              credit, link_url, width, height
         FROM aircraft_photos WHERE icao = $1`,
      [icao]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      status: row.status,
      expired: row.expired,
      credit: row.credit,
      linkUrl: row.link_url,
      width: row.width,
      height: row.height
    };
  }

  /**
   * The bytes, and a note that they were wanted.
   *
   * Expiry is deliberately not a condition. A photograph that is a day past its
   * time to live is still that aircraft, and blanking the profile while a
   * refetch runs — or forever, on a receiver whose internet access has gone
   * away — would be worse than serving it. Expiry decides when to re-ask
   * upstream and when maintenance may drop the row, not what may be served.
   *
   * The read doubles as the touch that eviction orders by, so a photograph
   * nobody looks at is the one that goes when the cache is full.
   */
  async image(icao: string): Promise<PhotoImage | undefined> {
    const result = await this.database.pool.query<ImageRow>(
      `UPDATE aircraft_photos SET last_served_at = now()
        WHERE icao = $1 AND status = 'present' AND image IS NOT NULL
        RETURNING image, content_type, bytes, fetched_at`,
      [icao]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      image: row.image,
      contentType: row.content_type,
      etag: photoEtag(row)
    };
  }

  /** Last write wins: a refetch replaces whatever the previous answer was. */
  async save(icao: string, record: PhotoRecord): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO aircraft_photos (
         icao, status, image, content_type, bytes, width, height,
         credit, link_url, source_url,
         fetched_at, expires_at, last_served_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         now(), now() + make_interval(secs => $11), now()
       )
       ON CONFLICT (icao) DO UPDATE SET
         status = EXCLUDED.status,
         image = EXCLUDED.image,
         content_type = EXCLUDED.content_type,
         bytes = EXCLUDED.bytes,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         credit = EXCLUDED.credit,
         link_url = EXCLUDED.link_url,
         source_url = EXCLUDED.source_url,
         fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at`,
      [
        icao,
        record.status,
        record.image ?? null,
        record.contentType ?? null,
        record.image?.byteLength ?? null,
        record.width ?? null,
        record.height ?? null,
        record.credit ?? null,
        record.linkUrl ?? null,
        record.sourceUrl ?? null,
        record.ttlSeconds
      ]
    );
  }

  /**
   * What the cache is holding, for the Settings card to report before it
   * offers to throw it away. Counted rather than estimated: the number an
   * operator is deciding against has to be the real one.
   */
  async summary(): Promise<PhotoCacheSummary> {
    const result = await this.database.pool.query<{
      photographs: string;
      misses: string;
      bytes: string;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'present') AS photographs,
              count(*) FILTER (WHERE status <> 'present') AS misses,
              coalesce(sum(bytes), 0) AS bytes
         FROM aircraft_photos`
    );
    const row = result.rows[0];
    return {
      photographs: Number(row?.photographs ?? 0),
      misses: Number(row?.misses ?? 0),
      bytes: Number(row?.bytes ?? 0)
    };
  }

  /**
   * Empties the cache.
   *
   * The misses go with the photographs. Someone clearing the cache has usually
   * changed the source, and keeping the old source's "there is no photograph of
   * this" answers would suppress the new one's for a week.
   */
  async clear(): Promise<number> {
    const result = await this.database.pool.query("DELETE FROM aircraft_photos");
    return result.rowCount ?? 0;
  }

  /**
   * Expired rows first, then the least recently served beyond the cap.
   *
   * The order matters: dropping what has expired usually brings the cache under
   * its entry limit on its own, so the second pass — which throws away
   * photographs that are still good — only runs on a cache that is genuinely
   * full.
   */
  async evict(maximumEntries: number): Promise<PhotoEviction> {
    const expiredResult = await this.database.pool.query(
      "DELETE FROM aircraft_photos WHERE expires_at <= now()"
    );
    const evictedResult = await this.database.pool.query(
      `DELETE FROM aircraft_photos
        WHERE icao IN (
          SELECT icao FROM aircraft_photos
           ORDER BY last_served_at DESC, icao
          OFFSET $1
        )`,
      [maximumEntries]
    );
    return {
      expired: expiredResult.rowCount ?? 0,
      evicted: evictedResult.rowCount ?? 0
    };
  }
}
