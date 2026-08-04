import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { appSettingsPatchSchema } from "../src/settings.js";
import {
  FixedWindowRateLimiter,
  RequestSecurity
} from "../src/security.js";

function security() {
  return new RequestSecurity(
    loadConfig({
      NODE_ENV: "test",
      APP_ALLOWED_HOSTS: "flightmap.local,127.0.0.1,[::1]",
      APP_ALLOWED_ORIGINS: "https://dashboard.example,not an origin"
    })
  );
}

describe("request security", () => {
  it("allows only configured hosts and same/explicit origins", () => {
    const guard = security();
    expect(guard.hostAllowed("flightmap.local:8080")).toBe(true);
    expect(guard.hostAllowed("evil.example")).toBe(false);
    expect(
      guard.originAllowed(
        "http://flightmap.local:8080",
        "flightmap.local:8080"
      )
    ).toBe(true);
    expect(
      guard.originAllowed(
        "https://dashboard.example",
        "flightmap.local:8080"
      )
    ).toBe(true);
    expect(
      guard.originAllowed("https://evil.example", "flightmap.local:8080")
    ).toBe(false);
    expect(guard.hostAllowed("[::1]:8080")).toBe(true);
    expect(guard.hostAllowed("[broken")).toBe(false);
    expect(guard.hostAllowed(undefined)).toBe(false);
    expect(guard.originAllowed(undefined, "flightmap.local:8080")).toBe(false);
    expect(
      guard.originAllowed("ftp://flightmap.local", "flightmap.local")
    ).toBe(false);
    expect(guard.originAllowed("not a URL", "flightmap.local")).toBe(false);
  });
});

describe("fixed-window rate limiting", () => {
  it("resets each key after the configured window", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.consume("client", 0)).toBe(true);
    expect(limiter.consume("client", 1)).toBe(true);
    expect(limiter.consume("client", 2)).toBe(false);
    expect(limiter.consume("other", 2)).toBe(true);
    expect(limiter.consume("client", 1_001)).toBe(true);
  });

  it("prunes expired client buckets after sustained key growth", () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    for (let index = 0; index <= 10_000; index += 1) {
      expect(limiter.consume(`client-${index}`, 0)).toBe(true);
    }
    expect(limiter.consume("current-client", 1_001)).toBe(true);
  });
});

describe("content security policy", () => {
  it("allows the configured map style origin instead of all of http and https", () => {
    const policy = contentSecurityPolicy("https://tiles.openfreemap.org/styles/dark");
    expect(policy).toContain("connect-src 'self' ws: wss: https://tiles.openfreemap.org");
    expect(policy).toContain("img-src 'self' data: blob: https://tiles.openfreemap.org");
    expect(policy).not.toContain(" http:");
  });

  it("names the light map style origin as well, since either can be in force", () => {
    const policy = contentSecurityPolicy(
      "https://tiles.openfreemap.org/styles/dark",
      "https://tiles.example.net/styles/bright"
    );
    expect(policy).toContain(
      "connect-src 'self' ws: wss: https://tiles.openfreemap.org https://tiles.example.net"
    );
  });

  it("lists a shared origin once when both styles come from it", () => {
    const policy = contentSecurityPolicy(
      "https://tiles.openfreemap.org/styles/dark",
      "https://tiles.openfreemap.org/styles/bright"
    );
    expect(policy).toContain(
      "img-src 'self' data: blob: https://tiles.openfreemap.org;"
    );
  });

  it("falls back to same-origin only when the map style URL is unusable", () => {
    const policy = contentSecurityPolicy("not a url");
    expect(policy).toContain("connect-src 'self' ws: wss:;");
  });
});

describe("settings URL schemes", () => {
  it("accepts http and https and rejects everything else", () => {
    expect(
      appSettingsPatchSchema.safeParse({
        receiverBaseUrl: "http://receiver.local/data"
      }).success
    ).toBe(true);
    expect(
      appSettingsPatchSchema.safeParse({
        receiverBaseUrl: "file:///etc/passwd"
      }).success
    ).toBe(false);
    expect(
      appSettingsPatchSchema.safeParse({
        metadataUrl: "gopher://example.test/db.csv"
      }).success
    ).toBe(false);
  });
});

describe("proxy trust", () => {
  it("is off by default and configurable for a reverse proxy deployment", () => {
    expect(loadConfig({ NODE_ENV: "test" }).trustProxy).toBe(false);
    expect(
      loadConfig({ NODE_ENV: "test", APP_TRUST_PROXY: "true" }).trustProxy
    ).toBe(true);
    expect(
      loadConfig({
        NODE_ENV: "test",
        APP_TRUST_PROXY: "10.0.0.0/8"
      }).trustProxy
    ).toBe("10.0.0.0/8");
  });
});
