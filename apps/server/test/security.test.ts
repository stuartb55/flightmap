import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
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
