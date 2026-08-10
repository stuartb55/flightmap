import { describe, expect, it, vi } from "vitest";
import {
  AircraftPhotoService,
  normaliseIcao,
  parsePhotoResponse,
  type AircraftPhotoSettings
} from "../src/services/aircraft-photos.js";
import type {
  PhotoRecord,
  PhotoRepository,
  PhotoState
} from "../src/db/photo-repository.js";

const settings = (overrides: Partial<AircraftPhotoSettings> = {}) =>
  (): AircraftPhotoSettings => ({
    aircraftPhotosEnabled: true,
    aircraftPhotoSourceUrl: "https://photos.test/hex/{icao}",
    aircraftPhotoTtlDays: 30,
    aircraftPhotoNegativeTtlDays: 7,
    ...overrides
  });

const logger = { warn: vi.fn() };

/** A minimal valid PNG header, which is what the sniffer accepts. */
function pngBytes(width = 640, height = 427): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function stubStore(state?: PhotoState) {
  const saved: { icao: string; record: PhotoRecord }[] = [];
  const store = {
    state: vi.fn(async () => state),
    image: vi.fn(async () => undefined),
    save: vi.fn(async (icao: string, record: PhotoRecord) => {
      saved.push({ icao, record });
    }),
    evict: vi.fn(async () => ({ expired: 0, evicted: 0 }))
  } as unknown as PhotoRepository;
  return { store, saved };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

/** A body that streams in chunks, which is what the bounded read consumes. */
function imageResponse(bytes: Buffer, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    body: (async function* () {
      yield new Uint8Array(bytes);
    })()
  } as unknown as Response;
}

const photoBody = {
  photos: [
    {
      thumbnail_large: { src: "ignored" },
      thumbnail: "https://cdn.photos.test/abc.png",
      photographer: "A Photographer",
      link: "https://photos.test/photo/1"
    }
  ]
};

/** Answers the lookup with `photoBody` and the image URL with `bytes`. */
function upstream(bytes: Buffer = pngBytes()) {
  return vi.fn(async (input: RequestInfo | URL) =>
    String(input).startsWith("https://cdn.")
      ? imageResponse(bytes)
      : jsonResponse(photoBody)
  ) as unknown as typeof fetch;
}

describe("normaliseIcao", () => {
  it("lower-cases the six hex digits the live path carries", () => {
    expect(normaliseIcao(" 406B90 ")).toBe("406b90");
  });

  /* The address is both a cache key and part of a third party's URL. */
  it("rejects anything that is not an ICAO address", () => {
    expect(normaliseIcao(null)).toBeNull();
    expect(normaliseIcao("")).toBeNull();
    expect(normaliseIcao("406b9")).toBeNull();
    expect(normaliseIcao("406b900")).toBeNull();
    expect(normaliseIcao("../../etc/passwd")).toBeNull();
    expect(normaliseIcao("zzzzzz")).toBeNull();
  });
});

describe("parsePhotoResponse", () => {
  it("reads a nested photos array", () => {
    expect(parsePhotoResponse(photoBody)).toEqual({
      imageUrl: "https://cdn.photos.test/abc.png",
      credit: "A Photographer",
      linkUrl: "https://photos.test/photo/1"
    });
  });

  /* The URL is a setting precisely so a different provider works without a
     code change, so the parse walks rather than indexes. */
  it("reads a bare object from a provider with a different shape", () => {
    expect(
      parsePhotoResponse({ url: "https://cdn.other.test/x.jpg", credit: "Someone" })
    ).toMatchObject({ imageUrl: "https://cdn.other.test/x.jpg", credit: "Someone" });
  });

  it("treats a response with no usable image URL as no photograph", () => {
    expect(parsePhotoResponse({ photos: [] })).toBeNull();
    expect(parsePhotoResponse({ status: "not found" })).toBeNull();
    expect(parsePhotoResponse(null)).toBeNull();
  });

  /* The URL goes into an outbound request from this server. */
  it("refuses an image URL that is not http or https", () => {
    expect(parsePhotoResponse({ url: "file:///etc/passwd" })).toBeNull();
    expect(parsePhotoResponse({ url: "data:image/png;base64,AAAA" })).toBeNull();
  });
});

describe("AircraftPhotoService", () => {
  /*
   * The first acceptance criterion, and the reason the whole item is shaped the
   * way it is: a default installation reaches no photo host, ever.
   */
  it("makes no outbound request when photographs are switched off", async () => {
    const { store } = stubStore();
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(
      store,
      settings({ aircraftPhotosEnabled: false }),
      logger,
      fetchImpl
    );

    expect(await service.status("406b90")).toBeNull();
    await service.settled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.state).not.toHaveBeenCalled();
  });

  /* Enabled but unconfigured is the state an operator passes through while
     reading the docs, and it must not reach anything either. */
  it("makes no outbound request when no source is configured", async () => {
    const { store } = stubStore();
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(
      store,
      settings({ aircraftPhotoSourceUrl: "" }),
      logger,
      fetchImpl
    );

    expect(await service.status("406b90")).toBeNull();
    await service.settled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches once and stores the bytes with what the sniffer read", async () => {
    const { store, saved } = stubStore();
    const service = new AircraftPhotoService(store, settings(), logger, upstream());

    expect(await service.status("406b90")).toBeNull();
    await service.settled();

    expect(saved).toHaveLength(1);
    expect(saved[0]!.icao).toBe("406b90");
    expect(saved[0]!.record).toMatchObject({
      status: "present",
      contentType: "image/png",
      width: 640,
      height: 427,
      credit: "A Photographer",
      linkUrl: "https://photos.test/photo/1",
      sourceUrl: "https://cdn.photos.test/abc.png",
      ttlSeconds: 30 * 86_400
    });
  });

  /* A cached answer is the answer. Nothing goes upstream until it expires. */
  it("serves a cached photograph without asking upstream again", async () => {
    const { store } = stubStore({
      status: "present",
      expired: false,
      credit: "A Photographer",
      linkUrl: "https://photos.test/photo/1",
      width: 640,
      height: 427
    });
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    expect(await service.status("406b90")).toEqual({
      available: true,
      credit: "A Photographer",
      linkUrl: "https://photos.test/photo/1",
      width: 640,
      height: 427
    });
    await service.settled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-asks upstream once the cached answer has expired", async () => {
    const { store, saved } = stubStore({
      status: "present",
      expired: true,
      credit: null,
      linkUrl: null,
      width: null,
      height: null
    });
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    // The expired answer is still reported while the refetch runs, because it
    // is still true about the airframe.
    expect(await service.status("406b90")).toMatchObject({ available: true });
    await service.settled();
    expect(saved).toHaveLength(1);
  });

  /*
   * Two devices opening the same aircraft at once, or one opened twice before
   * the first fetch lands, must be one upstream request rather than two.
   */
  it("collapses concurrent views of one airframe into one request", async () => {
    const { store, saved } = stubStore();
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    await Promise.all([
      service.status("406b90"),
      service.status("406b90"),
      service.status("406B90")
    ]);
    await service.settled();

    expect(saved).toHaveLength(1);
    // One lookup and one image download, not three of each.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /*
   * "A miss is a row." Without this, every unphotographed airframe — most of
   * general aviation — is re-asked on every view for as long as it is in range.
   */
  it("records an absent row when the source has no photograph", async () => {
    const { store, saved } = stubStore();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ photos: [] })
    ) as unknown as typeof fetch;
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    await service.status("406b90");
    await service.settled();

    expect(saved[0]!.record).toMatchObject({
      status: "absent",
      ttlSeconds: 7 * 86_400
    });
  });

  it("records an absent row when the source 404s the airframe", async () => {
    const { store, saved } = stubStore();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "not found" }, 404)
    ) as unknown as typeof fetch;
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    await service.status("406b90");
    await service.settled();
    expect(saved[0]!.record).toMatchObject({ status: "absent" });
  });

  /* A short expiry, so an upstream outage does not poison the cache for a
     month the way a normal time to live would. */
  it("records a failed row when the source errors, times out, or is unreachable", async () => {
    for (const responder of [
      async () => jsonResponse({ error: "boom" }, 500),
      async () => {
        throw new Error("The operation was aborted due to timeout");
      }
    ]) {
      const { store, saved } = stubStore();
      const service = new AircraftPhotoService(
        store,
        settings(),
        logger,
        responder as unknown as typeof fetch
      );

      await service.status("406b90");
      await service.settled();
      expect(saved[0]!.record).toMatchObject({
        status: "failed",
        ttlSeconds: 7 * 86_400
      });
    }
  });

  /*
   * The failure a photo API actually produces when it falls over: a 200 whose
   * body is an HTML error page. Stored, it would be a broken image on the
   * profile; it has to be a miss instead.
   */
  it("records an absent row when the bytes are not an image it stores", async () => {
    const { store, saved } = stubStore();
    const service = new AircraftPhotoService(
      store,
      settings(),
      logger,
      upstream(Buffer.from("<!DOCTYPE html><html>Service unavailable"))
    );

    await service.status("406b90");
    await service.settled();
    expect(saved[0]!.record).toMatchObject({ status: "absent" });
  });

  /* Bounded by the read itself, not by the declared length, because a hostile
     or broken source can declare anything. */
  it("stops reading an image past the size cap and stores no bytes", async () => {
    const { store, saved } = stubStore();
    const oversized = Buffer.concat([pngBytes(), Buffer.alloc(400 * 1024)]);
    const service = new AircraftPhotoService(
      store,
      settings(),
      logger,
      upstream(oversized)
    );

    await service.status("406b90");
    await service.settled();
    expect(saved[0]!.record).toMatchObject({ status: "absent" });
    expect(saved[0]!.record.image).toBeUndefined();
  });

  it("declines an image whose declared length is already over the cap", async () => {
    const { store, saved } = stubStore();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("https://cdn.")
        ? imageResponse(pngBytes(), { "content-length": String(10 * 1024 * 1024) })
        : jsonResponse(photoBody)
    ) as unknown as typeof fetch;
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    await service.status("406b90");
    await service.settled();
    expect(saved[0]!.record).toMatchObject({ status: "absent" });
  });

  /* A cache read that fails must not fail the profile it decorates. */
  it("reports nothing known when the cache cannot be read", async () => {
    const store = {
      state: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
      image: vi.fn(),
      save: vi.fn(async () => undefined),
      evict: vi.fn()
    } as unknown as PhotoRepository;
    const service = new AircraftPhotoService(store, settings(), logger, upstream());

    await expect(service.status("406b90")).resolves.toBeNull();
    await service.settled();
  });

  it("ignores an address that is not an ICAO address", async () => {
    const { store } = stubStore();
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(store, settings(), logger, fetchImpl);

    expect(await service.status("not-an-icao")).toBeNull();
    await service.settled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /* Turning the feature off while a queue is draining must stop the queue,
     not let it finish reaching a third party. */
  it("abandons queued work when the feature is switched off mid-drain", async () => {
    const { store, saved } = stubStore();
    let enabled = true;
    const fetchImpl = upstream();
    const service = new AircraftPhotoService(
      store,
      () => ({ ...settings()(), aircraftPhotosEnabled: enabled }),
      logger,
      fetchImpl
    );

    void service.status("406b90");
    enabled = false;
    await service.settled();
    expect(saved).toHaveLength(0);
  });
});
