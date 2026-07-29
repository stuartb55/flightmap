import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

const SESSION_COOKIE = "flightmap_session";

function normaliseHost(value: string): string {
  const input = value.trim().toLowerCase();
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    return end >= 0 ? input.slice(0, end + 1) : input;
  }
  return input.split(":", 1)[0] ?? input;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

export class RequestSecurity {
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;

  constructor(
    private readonly config: Pick<
      Config,
      | "allowedHosts"
      | "allowedOrigins"
      | "accessToken"
      | "sessionHours"
      | "nodeEnv"
    >
  ) {
    this.allowedHosts = new Set(config.allowedHosts.map(normaliseHost));
    this.allowedOrigins = new Set(
      config.allowedOrigins.map((origin) => {
        try {
          return new URL(origin).origin.toLowerCase();
        } catch {
          return origin.toLowerCase();
        }
      })
    );
  }

  get authRequired(): boolean {
    return this.config.accessToken !== null;
  }

  hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    return this.allowedHosts.has(normaliseHost(hostHeader));
  }

  originAllowed(
    originHeader: string | undefined,
    hostHeader: string | undefined
  ): boolean {
    if (!originHeader || !hostHeader || !this.hostAllowed(hostHeader)) {
      return false;
    }
    try {
      const origin = new URL(originHeader);
      if (!["http:", "https:"].includes(origin.protocol)) return false;
      if (this.allowedOrigins.has(origin.origin.toLowerCase())) return true;
      return origin.host.toLowerCase() === hostHeader.trim().toLowerCase();
    } catch {
      return false;
    }
  }

  authenticated(request: FastifyRequest): boolean {
    if (!this.authRequired) return true;
    const cookie = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!cookie) return false;
    const separator = cookie.indexOf(".");
    if (separator < 1) return false;
    const expires = Number(cookie.slice(0, separator));
    const signature = cookie.slice(separator + 1);
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Math.floor(Date.now() / 1000)
    ) {
      return false;
    }
    return constantTimeEqual(signature, this.sessionSignature(expires));
  }

  tokenMatches(value: unknown): boolean {
    return (
      typeof value === "string" &&
      this.config.accessToken !== null &&
      constantTimeEqual(value, this.config.accessToken)
    );
  }

  setSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
    if (!this.config.accessToken) return;
    const secure = request.protocol === "https" ? "; Secure" : "";
    const maxAge = this.config.sessionHours * 3600;
    const expires = Math.floor(Date.now() / 1000) + maxAge;
    const value = `${expires}.${this.sessionSignature(expires)}`;
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
    );
  }

  clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
    const secure = request.protocol === "https" ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
    );
  }

  private sessionSignature(expires: number): string {
    if (!this.config.accessToken) return "";
    return createHmac("sha256", this.config.accessToken)
      .update(`flightmap-browser-session-v1:${expires}`)
      .digest("base64url");
  }
}

type Bucket = { startedAt: number; count: number };

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  consume(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      if (this.buckets.size > 10_000) this.prune(now);
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(key);
    }
  }
}
