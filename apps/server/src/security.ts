import type { Config } from "./config.js";

function normaliseHost(value: string): string {
  const input = value.trim().toLowerCase();
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    return end >= 0 ? input.slice(0, end + 1) : input;
  }
  return input.split(":", 1)[0] ?? input;
}

export class RequestSecurity {
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;

  constructor(
    private readonly config: Pick<Config, "allowedHosts" | "allowedOrigins">
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
