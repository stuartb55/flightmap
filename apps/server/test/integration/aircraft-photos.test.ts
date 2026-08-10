import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/database.js";
import { PhotoRepository } from "../../src/db/photo-repository.js";
import { MaintenanceService } from "../../src/services/maintenance.js";
import {
  createTestDatabase,
  describeDatabase,
  integrationConfig,
  resetDatabase
} from "./harness.js";

const logger = { info: vi.fn(), error: vi.fn() };

/** A minimal valid PNG, which is all the store cares about — it stores bytes. */
function pngBytes(marker = 0): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(640 + marker, 16);
  bytes.writeUInt32BE(427, 20);
  return bytes;
}

describeDatabase("the aircraft photograph cache against PostgreSQL", () => {
  let database: Database;
  let photos: PhotoRepository;

  beforeAll(async () => {
    ({ database } = await createTestDatabase());
    photos = new PhotoRepository(database);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await resetDatabase(database);
    vi.clearAllMocks();
  });

  const present = (icao: string, ttlSeconds = 3_600) =>
    photos.save(icao, {
      status: "present",
      image: pngBytes(),
      contentType: "image/png",
      width: 640,
      height: 427,
      credit: "A Photographer",
      linkUrl: "https://photos.test/photo/1",
      sourceUrl: "https://cdn.photos.test/abc.png",
      ttlSeconds
    });

  async function ageLastServed(icao: string, minutes: number): Promise<void> {
    await database.query(
      `UPDATE aircraft_photos
          SET last_served_at = now() - make_interval(mins => $2)
        WHERE icao = $1`,
      [icao, minutes]
    );
  }

  it("round-trips the bytes and what was read out of them", async () => {
    await present("406b90");

    const state = await photos.state("406b90");
    expect(state).toMatchObject({
      status: "present",
      expired: false,
      credit: "A Photographer",
      width: 640,
      height: 427
    });

    const image = await photos.image("406b90");
    expect(image?.contentType).toBe("image/png");
    expect(image?.image.equals(pngBytes())).toBe(true);
    expect(image?.etag).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
  });

  /* The ETag has to change when the bytes do, or a browser holding the old
     photograph is never told about the new one. */
  it("changes the ETag when the photograph is refetched", async () => {
    await present("406b90");
    const first = await photos.image("406b90");

    await photos.save("406b90", {
      status: "present",
      image: Buffer.concat([pngBytes(1), Buffer.alloc(64)]),
      contentType: "image/png",
      width: 641,
      height: 427,
      ttlSeconds: 3_600
    });
    const second = await photos.image("406b90");

    expect(second?.etag).not.toBe(first?.etag);
  });

  it("reports an expired row as expired without throwing its answer away", async () => {
    await photos.save("406b90", { status: "absent", ttlSeconds: -60 });

    expect(await photos.state("406b90")).toMatchObject({
      status: "absent",
      expired: true
    });
  });

  /*
   * Expiry decides when to re-ask upstream, not what may be served. A receiver
   * whose internet access has gone away goes on showing the photographs it has
   * rather than blanking them the moment their time to live runs out.
   */
  it("serves an expired photograph rather than blanking the profile", async () => {
    await present("406b90", -60);

    const image = await photos.image("406b90");
    expect(image?.image.equals(pngBytes())).toBe(true);
  });

  it("has nothing to serve for an airframe with no photograph", async () => {
    await photos.save("406b90", { status: "absent", ttlSeconds: 3_600 });

    expect(await photos.image("406b90")).toBeUndefined();
    expect(await photos.image("abc123")).toBeUndefined();
  });

  /* Eviction orders by it, so a read has to be what sets it. */
  it("marks a photograph as served when its bytes are handed out", async () => {
    await present("406b90");
    await ageLastServed("406b90", 90);

    await photos.image("406b90");

    const result = await database.query<{ minutes: number }>(
      `SELECT EXTRACT(EPOCH FROM (now() - last_served_at)) / 60 AS minutes
         FROM aircraft_photos WHERE icao = $1`,
      ["406b90"]
    );
    expect(Number(result.rows[0]?.minutes)).toBeLessThan(1);
  });

  it("drops expired rows before it evicts anything still good", async () => {
    await present("406b90");
    await photos.save("4ca8c3", { status: "absent", ttlSeconds: -60 });
    await photos.save("400a1f", { status: "failed", ttlSeconds: -60 });

    expect(await photos.evict(2_000)).toEqual({ expired: 2, evicted: 0 });
    expect(await photos.state("406b90")).toBeDefined();
    expect(await photos.state("4ca8c3")).toBeUndefined();
  });

  it("evicts the least recently served once the cache is over its limit", async () => {
    await present("406b90");
    await present("4ca8c3");
    await present("400a1f");
    // Oldest first, so the two that go are 400a1f and 4ca8c3.
    await ageLastServed("400a1f", 300);
    await ageLastServed("4ca8c3", 200);
    await ageLastServed("406b90", 100);

    expect(await photos.evict(1)).toEqual({ expired: 0, evicted: 2 });
    expect(await photos.state("406b90")).toBeDefined();
    expect(await photos.state("4ca8c3")).toBeUndefined();
    expect(await photos.state("400a1f")).toBeUndefined();
  });

  it("leaves a cache under its limit alone", async () => {
    await present("406b90");

    expect(await photos.evict(2_000)).toEqual({ expired: 0, evicted: 0 });
    expect(await photos.state("406b90")).toBeDefined();
  });

  /* The database enforces it as well as the service, because a half-written
     failure served as a zero-byte photograph is a broken image rather than
     nothing at all. */
  it("refuses a present row with no image", async () => {
    await expect(
      database.query(
        `INSERT INTO aircraft_photos (icao, status, expires_at)
         VALUES ($1, 'present', now() + interval '1 hour')`,
        ["406b90"]
      )
    ).rejects.toThrow();
  });

  it("runs eviction inside the maintenance pass and records what it did", async () => {
    await present("406b90");
    await present("4ca8c3");
    await photos.save("400a1f", { status: "absent", ttlSeconds: -60 });
    await ageLastServed("4ca8c3", 200);

    const maintenance = new MaintenanceService(
      database,
      integrationConfig(),
      logger,
      photos,
      () => 1
    );
    const result = await maintenance.run();

    expect(result.failedSteps).toEqual([]);
    expect(result.expiredPhotos).toBe(1);
    expect(result.evictedPhotos).toBe(1);

    const logged = await database.query<{
      expired_photos: string;
      evicted_photos: string;
    }>("SELECT expired_photos, evicted_photos FROM maintenance_log");
    expect(logged.rows[0]).toMatchObject({
      expired_photos: "1",
      evicted_photos: "1"
    });
    expect(await photos.state("406b90")).toBeDefined();
  });

  /* Maintenance predates the photograph cache and still has to run without
     one — the CLI builds the service with no repository. */
  it("runs a maintenance pass with no photograph cache attached", async () => {
    const maintenance = new MaintenanceService(
      database,
      integrationConfig(),
      logger
    );
    const result = await maintenance.run();

    expect(result.failedSteps).toEqual([]);
    expect(result.expiredPhotos).toBe(0);
    expect(result.evictedPhotos).toBe(0);
  });
});
