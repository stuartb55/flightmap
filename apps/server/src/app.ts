import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply
} from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { RepositoryInputError } from "./db/repository.js";
import { registerApiRoutes, type ApiDependencies } from "./routes/api.js";
import { registerWebSocketRoute } from "./routes/websocket.js";
import {
  FixedWindowRateLimiter,
  RequestSecurity
} from "./security.js";
import { SettingsNotLoadedError } from "./settings.js";

export type BuildAppOptions = {
  config: Config;
  dependencies: ApiDependencies;
  logger?: boolean | {
    level: string;
    redact?: string[];
  };
  loggerInstance?: FastifyBaseLogger;
};

/**
 * The map styles are the only remote origins the client contacts, so the
 * policy names them instead of allowing all of `http:` and `https:`. A style
 * hosted on one origin but serving tiles, sprites or glyphs from another needs
 * that origin adding here.
 *
 * Both the dark and the light style are listed, because either can be in force
 * depending on the reader's theme.
 */
export function contentSecurityPolicy(...mapStyleUrls: string[]): string {
  const origins = new Set<string>();
  for (const mapStyleUrl of mapStyleUrls) {
    try {
      const url = new URL(mapStyleUrl);
      if (["http:", "https:"].includes(url.protocol)) origins.add(url.origin);
    } catch {
      // An unusable style URL simply contributes no origin.
    }
  }
  const mapOrigin = [...origins].map((origin) => ` ${origin}`).join("");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${mapOrigin}`,
    `connect-src 'self' ws: wss:${mapOrigin}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export function validationErrorMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The request was invalid";
  const field = issue.path.length > 0 ? issue.path.join(".") : null;
  return field
    ? `Check ${field}: ${issue.message}`
    : `The request was invalid: ${issue.message}`;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : {
          logger:
            options.logger ??
            {
              level: options.config.logLevel,
              redact: ["req.headers.authorization", "req.headers.cookie"]
            }
        }),
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
    trustProxy: options.config.trustProxy
  });
  const security = new RequestSecurity(options.config);
  const rateWindowMs = options.config.rateLimitWindowMs;
  const apiLimiter = new FixedWindowRateLimiter(
    options.config.apiRateLimit,
    rateWindowMs
  );
  const mutationLimiter = new FixedWindowRateLimiter(
    options.config.mutationRateLimit,
    rateWindowMs
  );
  const websocketLimiter = new FixedWindowRateLimiter(
    options.config.websocketRateLimit,
    rateWindowMs
  );
  const retryAfterSeconds = String(Math.max(1, Math.ceil(rateWindowMs / 1_000)));

  app.addHook("onRequest", async (request, reply) => {
    if (!security.hostAllowed(request.headers.host)) {
      return reply.code(421).send({
        error: {
          code: "HOST_NOT_ALLOWED",
          message: "The request host is not allowed"
        }
      });
    }
    if (request.url.startsWith("/api/") && !apiLimiter.consume(request.ip)) {
      reply.header("retry-after", retryAfterSeconds);
      return reply.code(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many API requests"
        }
      });
    }
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(
      request.method
    );
    if (isMutation) {
      if (!mutationLimiter.consume(request.ip)) {
        reply.header("retry-after", retryAfterSeconds);
        return reply.code(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many state-changing requests"
          }
        });
      }
      // Fail closed: a mutation without an Origin header is rejected too.
      if (!security.originAllowed(request.headers.origin, request.headers.host)) {
        return reply.code(403).send({
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: "The request origin is not allowed"
          }
        });
      }
    }
  });

  /*
   * The policy depends only on the two style URLs, but the config object it
   * reads them from is mutated in place when settings are saved — that is how a
   * changed style takes effect without a restart. So it is recomputed when they
   * change and not once per reply: this hook runs for health checks, static
   * assets and the 1 Hz polls alike, and building it means parsing two URLs and
   * joining ten directives every time.
   */
  let policy: { key: string; value: string } | null = null;
  const currentPolicy = (): string => {
    const key = `${options.config.mapStyleUrl}\n${options.config.mapStyleUrlLight}`;
    if (policy?.key !== key) {
      policy = {
        key,
        value: contentSecurityPolicy(
          options.config.mapStyleUrl,
          options.config.mapStyleUrlLight
        )
      };
    }
    return policy.value;
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("content-security-policy", currentPolicy());
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    return payload;
  });

  // Install this before @fastify/websocket and every route. The websocket
  // plugin captures the active handler while it wraps routes.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: validationErrorMessage(error),
          details: error.flatten()
        }
      });
    }
    if (error instanceof RepositoryInputError) {
      return reply.code(400).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }
    // Retryable rather than wrong: the same request succeeds once boot
    // finishes, which is what /health/ready is already reporting.
    if (error instanceof SettingsNotLoadedError) {
      reply.header("retry-after", "5");
      return reply.code(503).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }
    const fastifyError =
      typeof error === "object" && error !== null
        ? (error as {
            statusCode?: unknown;
            code?: unknown;
            message?: unknown;
          })
        : null;
    const httpStatus =
      fastifyError && typeof fastifyError.statusCode === "number"
        ? fastifyError.statusCode
        : null;
    if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
      const code =
        fastifyError?.code === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? "PAYLOAD_TOO_LARGE"
          : fastifyError?.code === "FST_ERR_CTP_INVALID_JSON_BODY"
            ? "INVALID_JSON"
            : "BAD_REQUEST";
      return reply.code(httpStatus).send({
        error: {
          code,
          message:
            typeof fastifyError?.message === "string"
              ? fastifyError.message
              : "The request could not be processed"
        }
      });
    }
    request.log.error({ error }, "Unhandled request error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred"
      }
    });
  });

  await registerWebSocketRoute(
    app,
    options.dependencies.hub,
    security,
    websocketLimiter
  );
  await registerApiRoutes(app, options.dependencies);

  const indexFile = join(options.config.webDistDir, "index.html");
  const indexTemplate = existsSync(indexFile)
    ? readFileSync(indexFile, "utf8")
    : null;
  /*
   * Rendered when the injected settings change rather than per request, for the
   * same reason as the policy above: the config object is live, but the values
   * only move when settings are saved, and this re-serialises the waypoint list
   * and rewrites the document every time it runs.
   */
  let rendered: { key: string; value: string | null } | null = null;
  const renderedIndex = (): string | null => {
    const settings = {
      mapStyleUrl: options.config.mapStyleUrl,
      mapStyleUrlLight: options.config.mapStyleUrlLight,
      receiverName: options.config.receiverName,
      receiverLatitude: options.config.receiverLatitude,
      receiverLongitude: options.config.receiverLongitude,
      displayTimeZone: options.config.displayTimeZone,
      rangeRingsNm: options.config.rangeRingsNm,
      // `mapAirports` is deliberately absent. This blob is URI-encoded
      // into every page load and into the page cache, which is fine for
      // eleven waypoints and wrong for a few thousand airport and runway
      // records; those come from GET /api/v1/airports, fetched once and
      // served from a runtime cache after that.
      mapWaypoints: options.config.mapWaypoints
    };
    const key = JSON.stringify(settings);
    if (rendered?.key !== key) {
      rendered = {
        key,
        value:
          indexTemplate?.replace(
            "</head>",
            `<meta name="flightmap-config" content="${encodeURIComponent(key)}"></head>`
          ) ?? null
      };
    }
    return rendered.value;
  };
  if (options.config.serveWeb && existsSync(indexFile)) {
    await app.register(fastifyStatic, {
      root: options.config.webDistDir,
      prefix: "/",
      wildcard: false,
      index: false,
      immutable: true,
      maxAge: "1y",
      // The service worker precaches /index.html as its offline shell, so that
      // document has to carry the same injected settings as `/`. Left to the
      // static handler it would serve the unrendered build template — no
      // receiver name, map style, waypoints or time zone — and pin it for a
      // year, so the route below answers for it instead.
      globIgnore: ["index.html"],
      setHeaders(reply, path) {
        // These stable filenames must always be revalidated or an installed
        // client can remain pinned to an old application release for a year.
        if (
          path.endsWith("/sw.js") ||
          path.endsWith("/manifest.webmanifest") ||
          path.endsWith("/registerSW.js")
        ) {
          reply.header("cache-control", "no-cache");
        }
      }
    });
    const sendRenderedIndex = (reply: FastifyReply) => {
      reply.header("cache-control", "no-cache");
      return reply.type("text/html").send(renderedIndex());
    };
    app.get("/", async (_request, reply) => sendRenderedIndex(reply));
    // Workbox fetches this during install and aborts precaching on anything
    // other than a 200, so it stays an explicit route rather than falling
    // through to the not-found handler.
    app.get("/index.html", async (_request, reply) => sendRenderedIndex(reply));
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (
      options.config.serveWeb &&
      indexTemplate !== null &&
      request.method === "GET" &&
      !request.url.startsWith("/api/") &&
      !request.url.startsWith("/health/")
    ) {
      reply.header("cache-control", "no-cache");
      return reply.type("text/html").send(renderedIndex());
    }
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found"
      }
    });
  });

  return app;
}
