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
