import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("environment configuration", () => {
  it("does not take product settings from environment variables", () => {
    const config = loadConfig({
      RECEIVER_NAME: "Old environment receiver",
      RANGE_RINGS_NM: "1,2,3",
      HISTORY_RETENTION_DAYS: "7"
    });
    expect(config.receiverName).toBe("Home receiver");
    expect(config.rangeRingsNm).toEqual([5, 10, 25, 50, 100]);
    expect(config.historyRetentionDays).toBe(30);
  });

  it("normalises host/origin allowlists and optional access tokens", () => {
    const config = loadConfig({
      APP_ALLOWED_HOSTS: "flightmap.local, flightmap.local,127.0.0.1",
      APP_ALLOWED_ORIGINS: "https://flightmap.example, https://flightmap.example",
      APP_ACCESS_TOKEN: "a-long-random-access-token"
    });
    expect(config.allowedHosts).toEqual(["flightmap.local", "127.0.0.1"]);
    expect(config.allowedOrigins).toEqual(["https://flightmap.example"]);
    expect(config.accessToken).toBe("a-long-random-access-token");
  });

  it("rejects production wildcard hosts and placeholder credentials", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        APP_ALLOWED_HOSTS: "*"
      })
    ).toThrow();
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://flightmap:replace-with-a-long-random-password@db/flightmap"
      })
    ).toThrow();
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        APP_ACCESS_TOKEN: ""
      })
    ).toThrow();
  });
});
