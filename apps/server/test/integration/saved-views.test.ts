import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { SavedView, SavedViewConfiguration } from "@flightmap/shared";
import type { Database } from "../../src/db/database.js";
import {
  createTestDatabase,
  describeDatabase,
  repository,
  resetDatabase
} from "./harness.js";

function configuration(surface: "live" | "history"): SavedViewConfiguration {
  const mapLayers = {
    coverage: false,
    rangeRings: true,
    aircraftLabels: true,
    trails: true,
    allTrails: false,
    manchesterWaypoints: true
  };
  if (surface === "live") {
    return {
      surface: "live",
      filters: {
        query: "",
        minimumAltitude: "",
        maximumAltitude: "",
        minimumSpeed: "",
        maximumDistance: "",
        maximumFreshness: "",
        position: "all",
        source: "",
        category: "",
        watchedOnly: false,
        alertsOnly: false
      },
      sort: { key: "distance", direction: "asc" },
      display: { trailMinutes: 15, labelDensity: "auto" },
      mapLayers,
      viewport: null
    };
  }
  return {
    surface: "history",
    filters: {
      query: "",
      icao: "",
      callsign: "",
      registration: "",
      type: "",
      operator: "",
      from: "2026-07-25T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      alert: ""
    },
    sort: "started_desc",
    selectedSessionIds: [],
    replayTime: null,
    resolution: "auto",
    mapLayers,
    viewport: null
  };
}

describeDatabase("saved view defaults and pins against PostgreSQL", () => {
  let database: Database;

  beforeAll(async () => {
    ({ database } = await createTestDatabase());
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await resetDatabase(database);
  });

  async function create(
    name: string,
    surface: "live" | "history" = "history"
  ): Promise<SavedView> {
    return repository(database).createSavedView({
      name,
      configuration: configuration(surface)
    });
  }

  async function defaults(surface: string): Promise<string[]> {
    const result = await database.query<{ id: string }>(
      "SELECT id FROM saved_views WHERE surface = $1 AND is_default",
      [surface]
    );
    return result.rows.map((row) => row.id);
  }

  it("creates views with neither flag set", async () => {
    const view = await create("Yesterday");
    expect(view.isDefault).toBe(false);
    expect(view.pinnedAt).toBeNull();
  });

  it("moves the default within a surface and leaves other surfaces alone", async () => {
    const flights = repository(database);
    const first = await create("First");
    const second = await create("Second");
    const live = await create("Live", "live");

    await flights.updateSavedView(first.id, { isDefault: true });
    await flights.updateSavedView(live.id, { isDefault: true });
    const promoted = await flights.updateSavedView(second.id, { isDefault: true });

    expect(promoted?.isDefault).toBe(true);
    expect(await defaults("history")).toEqual([second.id]);
    expect(await defaults("live")).toEqual([live.id]);
  });

  /*
   * Two people pressing the star at the same moment is the case the partial
   * unique index exists for: whichever transaction commits second must have
   * cleared the first's row, not raced past it.
   */
  it("cannot leave two defaults on one surface under concurrent writes", async () => {
    const flights = repository(database);
    const views = await Promise.all([
      create("One"),
      create("Two"),
      create("Three")
    ]);

    await Promise.all(
      views.map((view) => flights.updateSavedView(view.id, { isDefault: true }))
    );

    expect(await defaults("history")).toHaveLength(1);
  });

  it("clears a default without touching the rest of the surface", async () => {
    const flights = repository(database);
    const view = await create("Only");
    await flights.updateSavedView(view.id, { isDefault: true });
    const cleared = await flights.updateSavedView(view.id, { isDefault: false });

    expect(cleared?.isDefault).toBe(false);
    expect(await defaults("history")).toEqual([]);
  });

  it("caps pins per surface and names the limit when it refuses", async () => {
    const flights = repository(database);
    const views = await Promise.all([
      create("One"),
      create("Two"),
      create("Three"),
      create("Four")
    ]);
    for (const view of views.slice(0, 3)) {
      const pinned = await flights.updateSavedView(view.id, { pinned: true });
      expect(pinned?.pinnedAt).not.toBeNull();
    }

    await expect(
      flights.updateSavedView(views[3]!.id, { pinned: true })
    ).rejects.toMatchObject({
      code: "SAVED_VIEW_PIN_LIMIT",
      message: "Each surface supports up to 3 pinned views; unpin one first"
    });

    // The cap is per surface: another surface still has its three.
    const live = await create("Live", "live");
    expect((await flights.updateSavedView(live.id, { pinned: true }))?.pinnedAt).not.toBeNull();

    await flights.updateSavedView(views[0]!.id, { pinned: false });
    expect(
      (await flights.updateSavedView(views[3]!.id, { pinned: true }))?.pinnedAt
    ).not.toBeNull();
  });

  it("keeps the original pin time when an already pinned view is pinned again", async () => {
    const flights = repository(database);
    const view = await create("One");
    const pinned = await flights.updateSavedView(view.id, { pinned: true });
    const again = await flights.updateSavedView(view.id, { pinned: true });

    expect(again?.pinnedAt).toBe(pinned?.pinnedAt);
  });

  it("returns null for a view that no longer exists", async () => {
    const flights = repository(database);
    const view = await create("One");
    await flights.deleteSavedView(view.id);

    expect(await flights.updateSavedView(view.id, { isDefault: true })).toBeNull();
  });
});
