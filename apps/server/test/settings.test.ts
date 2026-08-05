import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  AppSettingsService,
  appSettingsSchema,
  defaultAppSettings
} from "../src/settings.js";

describe("application settings", () => {
  it("validates coordinate pairs and normalises receiver and map settings", () => {
    expect(() =>
      appSettingsSchema.parse({
        ...defaultAppSettings,
        receiverLatitude: 53.61
      })
    ).toThrow();
    expect(
      appSettingsSchema.parse({
        ...defaultAppSettings,
        receiverBaseUrl: "http://receiver.local/data/",
        rangeRingsNm: [50, 5, 25, 5]
      })
    ).toMatchObject({
      receiverBaseUrl: "http://receiver.local/data",
      rangeRingsNm: [5, 25, 50]
    });
  });

  it("loads persisted values and applies updates to active runtime config", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            settings: { receiverName: "Roof receiver" },
            updated_at: new Date("2026-07-29T12:00:00Z")
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{ updated_at: new Date("2026-07-29T13:00:00Z") }]
      });
    const service = new AppSettingsService({ query } as never);
    await service.load();
    const runtime = service.runtimeConfig(loadConfig({ NODE_ENV: "test" }));

    expect(runtime.receiverName).toBe("Roof receiver");
    await service.update({
      receiverName: "Loft receiver",
      historyRetentionDays: 14
    });

    expect(runtime.receiverName).toBe("Loft receiver");
    expect(runtime.historyRetentionDays).toBe(14);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE application_settings"),
      [expect.stringContaining('"receiverName":"Loft receiver"')]
    );
  });

  it("rejects unknown and incoherent updates before writing", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          settings: defaultAppSettings,
          updated_at: new Date("2026-07-29T12:00:00Z")
        }
      ]
    });
    const service = new AppSettingsService({ query } as never);
    await service.load();

    await expect(
      service.update({ madeUpSetting: true })
    ).rejects.toThrow();
    await expect(
      service.update({ receiverLatitude: 53.61 })
    ).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

/*
 * The airport dataset is the largest thing this service holds and its endpoint
 * is meant to be answered by an ETag comparison and nothing else, so the body
 * is serialised once per change rather than once per request.
 */
describe("the airport payload", () => {
  const airport = {
    icao: "EGCC",
    iata: "MAN",
    name: "Manchester Airport",
    latitude: 53.349375,
    longitude: -2.279521,
    elevationFt: 257,
    rank: 3,
    runways: [
      {
        ident: "05L/23R",
        lengthFt: 10_000,
        lowLatitude: 53.3451,
        lowLongitude: -2.29274,
        highLatitude: 53.3624,
        highLongitude: -2.25714
      }
    ]
  };

  async function service(mapAirports: unknown[]) {
    const query = vi.fn().mockResolvedValue({
      rows: [{ settings: { mapAirports }, updated_at: new Date("2026-08-05T12:00:00Z") }]
    });
    const created = new AppSettingsService({ query } as never);
    await created.load();
    return { service: created, query };
  }

  it("is empty by default, which is a valid deployment rather than a fault", () => {
    expect(defaultAppSettings.mapAirports).toEqual([]);
  });

  it("serialises once and hands back the same object until settings change", async () => {
    const { service: settings, query } = await service([airport]);
    const first = settings.airportsPayload();
    expect(settings.airportsPayload()).toBe(first);
    expect(JSON.parse(first.body)).toEqual({ items: [airport] });
    expect(first.etag).toMatch(/^"[\w-]{27}"$/);

    query.mockResolvedValueOnce({
      rows: [{ updated_at: new Date("2026-08-05T13:00:00Z") }]
    });
    await settings.update({ mapAirports: [] });
    const second = settings.airportsPayload();
    expect(second).not.toBe(first);
    expect(second.etag).not.toBe(first.etag);
    expect(JSON.parse(second.body)).toEqual({ items: [] });
  });

  /*
   * The ETag is over the body, so an operator rebuilding an unchanged dataset
   * does not invalidate every client's cached copy.
   */
  it("keeps the same ETag when a rebuild produces identical bytes", async () => {
    const first = (await service([airport])).service.airportsPayload();
    const second = (await service([airport])).service.airportsPayload();
    expect(second.etag).toBe(first.etag);
  });

  it("hands out copies, so a caller cannot mutate what is stored", async () => {
    const { service: settings } = await service([airport]);
    const copy = settings.get().settings.mapAirports;
    copy[0]!.runways.length = 0;
    expect(settings.get().settings.mapAirports[0]?.runways).toHaveLength(1);
  });
});
