/**
 * Aircraft photographs, fetched once per airframe and served from our origin.
 *
 * This is the second thing in the application that talks to a third party, and
 * the first that stores what one sends back. The whole module is about
 * containing that:
 *
 *   - Off until an operator configures a source. A default installation makes
 *     no outbound request to any photo host, ever.
 *   - Never on the 1 Hz path. Nothing here is joined into the live snapshot and
 *     nothing is fetched on a receiver tick. A fetch is triggered by someone
 *     opening one aircraft's profile, and the profile response never waits on
 *     it — the image endpoint 404s until the row lands.
 *   - One request in flight at a time, behind a bounded queue. A wall of
 *     profile views must not become a wall of upstream requests.
 *   - A miss is a row. An airframe with no photograph, and an upstream that
 *     failed, are both cached — with a shorter expiry — or every view of a
 *     common unphotographed airframe re-asks upstream forever.
 *   - Silent. A photograph is decoration; nothing here is allowed to fail a
 *     request the caller is waiting on, and nothing logs at error level.
 */
import { sniffImage } from "../domain/images.js";
import type { PhotoRepository, PhotoState } from "../db/photo-repository.js";

type Logger = {
  warn: (object: unknown, message?: string) => void;
};

export type AircraftPhotoSettings = {
  aircraftPhotosEnabled: boolean;
  aircraftPhotoSourceUrl: string;
  aircraftPhotoTtlDays: number;
  aircraftPhotoNegativeTtlDays: number;
};

/** What the profile is told about a photograph, without the bytes. */
export type AircraftPhotoStatus = {
  /** Whether `GET /api/v1/aircraft/:icao/photo` will answer with an image. */
  available: boolean;
  credit: string | null;
  linkUrl: string | null;
  width: number | null;
  height: number | null;
};

/*
 * Fixed in code rather than in settings, for the reason `services/airports.ts`
 * gives: no operator can judge a sensible byte cap, and the only thing a wrong
 * one can do is turn a hostile or broken URL into a memory problem. A thumbnail
 * from a photo API is tens of kilobytes; this is generous for one and far too
 * small to be a problem.
 */
const MAXIMUM_IMAGE_BYTES = 200 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How many airframes may be waiting on the single upstream slot. Beyond this a
 * request is dropped rather than queued: the queue exists to smooth a handful
 * of profile views, not to guarantee that every airframe ever looked at is
 * eventually fetched. A dropped one is fetched on the next view.
 */
const MAXIMUM_QUEUE_LENGTH = 32;

const SECONDS_PER_DAY = 86_400;

/** Six hex digits, because it goes into a third party's URL. */
export function normaliseIcao(icao: string | null): string | null {
  const trimmed = icao?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^[0-9a-f]{6}$/.test(trimmed) ? trimmed : null;
}

export type PhotoCandidate = {
  imageUrl: string;
  credit: string | null;
  linkUrl: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

/**
 * Reads an image URL, a credit and a link back out of a provider response.
 *
 * Written against the shape the common public ICAO-hex photo APIs return — a
 * `photos` array of objects carrying a thumbnail URL and a photographer — but
 * it walks rather than indexes, so a provider that returns one object at the
 * top level works without a code change. That is the point of the URL being a
 * setting: the app cannot verify anyone's terms, so it does not hard-code
 * anyone's schema either.
 */
export function parsePhotoResponse(body: unknown): PhotoCandidate | null {
  const record = locatePhoto(body);
  if (!record) return null;
  const imageUrl =
    clean(record.thumbnail_large) ??
    clean(record.thumbnail) ??
    clean(record.image) ??
    clean(record.url);
  if (!imageUrl || !isHttpUrl(imageUrl)) return null;
  return {
    imageUrl,
    credit: clean(record.photographer) ?? clean(record.credit) ?? null,
    linkUrl: clean(record.link) ?? clean(record.page) ?? null
  };
}

type PhotoRecordShape = Record<string, unknown>;

function locatePhoto(body: unknown): PhotoRecordShape | null {
  if (Array.isArray(body)) {
    for (const entry of body) {
      const found = locatePhoto(entry);
      if (found) return found;
    }
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  const record = body as PhotoRecordShape;
  const carriesUrl = ["thumbnail_large", "thumbnail", "image", "url"].some(
    (key) => clean(record[key]) !== null
  );
  // A thumbnail object nests its own `src`, so a bare `{ src }` is not the
  // photo record itself — keep walking until something carries a usable URL.
  if (carriesUrl) return record;
  for (const key of ["photos", "response", "data", "result", "results"]) {
    const nested = record[key];
    if (nested !== null && typeof nested === "object") {
      const found = locatePhoto(nested);
      if (found) return found;
    }
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export class AircraftPhotoService {
  /*
   * One upstream request at a time. `queue` holds the airframes waiting for the
   * slot; `pending` is the set of everything either running or queued, so the
   * same airframe opened on two devices at once is one request rather than two.
   */
  private readonly queue: string[] = [];
  private readonly pending = new Set<string>();
  private draining: Promise<void> | null = null;

  constructor(
    private readonly photos: PhotoRepository,
    private readonly settings: () => AircraftPhotoSettings,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * What the profile knows about an airframe's photograph, and the trigger for
   * fetching one it has never asked about.
   *
   * Returns immediately in every case. A fetch that this call starts lands
   * afterwards, and the client picks it up on the next view — which is what
   * keeps a third party off the critical path of a page load.
   */
  async status(rawIcao: string | null): Promise<AircraftPhotoStatus | null> {
    const settings = this.settings();
    if (!settings.aircraftPhotosEnabled || !settings.aircraftPhotoSourceUrl) {
      return null;
    }
    const icao = normaliseIcao(rawIcao);
    if (!icao) return null;

    const state = await this.readState(icao);
    // Nothing cached, or what is cached has expired: ask, and answer from what
    // is already known in the meantime.
    if (!state || state.expired) this.enqueue(icao);
    if (!state) return null;
    return {
      available: state.status === "present",
      credit: state.credit,
      linkUrl: state.linkUrl,
      width: state.width,
      height: state.height
    };
  }

  /** Waits for the queue to drain. Tests only; nothing in the app awaits this. */
  async settled(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async readState(icao: string): Promise<PhotoState | undefined> {
    try {
      return await this.photos.state(icao);
    } catch (error) {
      // A cache read that fails must not fail the profile it decorates. Report
      // "nothing known" and let the next view try again.
      this.logger.warn(
        { icao, error: String(error) },
        "Aircraft photo cache read failed"
      );
      return undefined;
    }
  }

  private enqueue(icao: string): void {
    if (this.pending.has(icao)) return;
    if (this.queue.length >= MAXIMUM_QUEUE_LENGTH) return;
    this.pending.add(icao);
    this.queue.push(icao);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    for (let icao = this.queue.shift(); icao; icao = this.queue.shift()) {
      try {
        await this.resolve(icao, this.settings());
      } catch (error) {
        // The loop outlives any one airframe: a throw here would strand
        // everything queued behind it.
        this.logger.warn(
          { icao, error: String(error) },
          "Aircraft photo fetch failed"
        );
      } finally {
        this.pending.delete(icao);
      }
    }
  }

  private async resolve(
    icao: string,
    settings: AircraftPhotoSettings
  ): Promise<void> {
    // Re-read rather than trusting the settings captured when this was queued:
    // an operator may have turned the feature off while it waited.
    if (!settings.aircraftPhotosEnabled || !settings.aircraftPhotoSourceUrl) {
      return;
    }
    const found = await this.fetchPhoto(icao, settings);
    const negativeTtl = settings.aircraftPhotoNegativeTtlDays * SECONDS_PER_DAY;
    if (found === "failed") {
      await this.photos.save(icao, { status: "failed", ttlSeconds: negativeTtl });
      return;
    }
    if (!found) {
      await this.photos.save(icao, { status: "absent", ttlSeconds: negativeTtl });
      return;
    }
    await this.photos.save(icao, {
      status: "present",
      image: found.image,
      contentType: found.meta.contentType,
      width: found.meta.width,
      height: found.meta.height,
      credit: found.credit,
      linkUrl: found.linkUrl,
      sourceUrl: found.sourceUrl,
      ttlSeconds: settings.aircraftPhotoTtlDays * SECONDS_PER_DAY
    });
  }

  /**
   * `"failed"` is a transport problem and earns a short retry; `null` is the
   * source answering that it has no photograph, which is a real answer and is
   * cached as one.
   */
  private async fetchPhoto(
    icao: string,
    settings: AircraftPhotoSettings
  ): Promise<
    | "failed"
    | null
    | {
        image: Buffer;
        meta: NonNullable<ReturnType<typeof sniffImage>>;
        credit: string | null;
        linkUrl: string | null;
        sourceUrl: string;
      }
  > {
    const url = settings.aircraftPhotoSourceUrl.replaceAll(
      "{icao}",
      encodeURIComponent(icao)
    );
    let candidate: PhotoCandidate | null;
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      // A provider answers "no such airframe" with 404, which is an answer.
      if (response.status === 404) return null;
      if (!response.ok) return "failed";
      candidate = parsePhotoResponse(await response.json());
    } catch (error) {
      this.logger.warn(
        { icao, error: String(error) },
        "Aircraft photo lookup failed"
      );
      return "failed";
    }
    // The source answered, and its answer is that there is no photograph.
    if (!candidate) return null;

    const image = await this.download(icao, candidate.imageUrl);
    if (image === "failed") return "failed";
    if (!image) return null;
    return {
      image: image.bytes,
      meta: image.meta,
      credit: candidate.credit,
      linkUrl: candidate.linkUrl,
      sourceUrl: candidate.imageUrl
    };
  }

  /**
   * A bounded read rather than `response.arrayBuffer()`: this is asking a URL a
   * third party chose for an unknown number of bytes, and the answer has to be
   * allowed to be "too many" without taking the process down with it.
   *
   * What comes back is then checked against its own bytes rather than against
   * the `content-type` it arrived under, so an HTML error page served as a JPEG
   * ends up as a cache miss instead of a broken image on the profile.
   */
  private async download(
    icao: string,
    url: string
  ): Promise<
    "failed" | null | { bytes: Buffer; meta: NonNullable<ReturnType<typeof sniffImage>> }
  > {
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "image/jpeg, image/png, image/webp" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok || !response.body) return "failed";
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAXIMUM_IMAGE_BYTES) {
        return null;
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        // Not a transport failure: the source has a photograph and it is too
        // big for this cache, which will still be true on a retry.
        if (total > MAXIMUM_IMAGE_BYTES) return null;
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const meta = sniffImage(bytes);
      if (!meta) return null;
      return { bytes, meta };
    } catch (error) {
      this.logger.warn(
        { icao, error: String(error) },
        "Aircraft photo download failed"
      );
      return "failed";
    }
  }
}
