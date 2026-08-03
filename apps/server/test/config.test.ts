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

  it("defaults the rate-limit budgets to the interactive values", () => {
    const config = loadConfig({});
    expect(config.apiRateLimit).toBe(300);
    expect(config.mutationRateLimit).toBe(90);
    expect(config.websocketRateLimit).toBe(30);
    expect(config.rateLimitWindowMs).toBe(60_000);
  });

  it("allows automated suites to raise the rate-limit budgets", () => {
    const config = loadConfig({
      API_RATE_LIMIT: "100000",
      MUTATION_RATE_LIMIT: "5000",
      WEBSOCKET_RATE_LIMIT: "1000",
      RATE_LIMIT_WINDOW_MS: "30000"
    });
    expect(config.apiRateLimit).toBe(100_000);
    expect(config.mutationRateLimit).toBe(5_000);
    expect(config.websocketRateLimit).toBe(1_000);
    expect(config.rateLimitWindowMs).toBe(30_000);
  });

  it("rejects a rate-limit budget that would disable the safeguard", () => {
    expect(() => loadConfig({ API_RATE_LIMIT: "0" })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: "10" })).toThrow();
  });

  it("normalises host and origin allowlists", () => {
    const config = loadConfig({
      APP_ALLOWED_HOSTS: "flightmap.local, flightmap.local,127.0.0.1",
      APP_ALLOWED_ORIGINS: "https://flightmap.example, https://flightmap.example"
    });
    expect(config.allowedHosts).toEqual(["flightmap.local", "127.0.0.1"]);
    expect(config.allowedOrigins).toEqual(["https://flightmap.example"]);
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
  });
});
