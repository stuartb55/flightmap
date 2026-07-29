import { describe, expect, it, vi } from "vitest";
import type {
  FastifyReply,
  FastifyRequest
} from "fastify";
import { loadConfig } from "../src/config.js";
import {
  FixedWindowRateLimiter,
  RequestSecurity
} from "../src/security.js";

function security() {
  return new RequestSecurity(
    loadConfig({
      NODE_ENV: "test",
      APP_ALLOWED_HOSTS: "flightmap.local,127.0.0.1",
      APP_ALLOWED_ORIGINS: "https://dashboard.example",
      APP_ACCESS_TOKEN: "a-secure-test-access-token"
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
  });

  it("exchanges the access token for an HttpOnly strict session cookie", () => {
    const guard = security();
    const header = vi.fn();
    guard.setSessionCookie(
      { protocol: "https" } as FastifyRequest,
      { header } as unknown as FastifyReply
    );
    const value = String(header.mock.calls[0]?.[1]);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Strict");
    expect(value).toContain("Secure");
    const cookie = value.split(";", 1)[0];
    expect(
      guard.authenticated({
        headers: { cookie }
      } as FastifyRequest)
    ).toBe(true);
    expect(guard.tokenMatches("wrong-token-value")).toBe(false);
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
});
