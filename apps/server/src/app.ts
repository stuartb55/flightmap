import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance
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
 * The map style is the only remote origin the client contacts, so the policy
 * names it instead of allowing all of `http:` and `https:`. A style hosted on
 * one origin but serving tiles, sprites or glyphs from another needs that
 * origin adding here.
 */
export function contentSecurityPolicy(mapStyleUrl: string): string {
  let mapOrigin = "";
  try {
    const url = new URL(mapStyleUrl);
    if (["http:", "https:"].includes(url.protocol)) mapOrigin = ` ${url.origin}`;
  } catch {
    mapOrigin = "";
  }
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
  const apiLimiter = new FixedWindowRateLimiter(300, 60_000);
  const mutationLimiter = new FixedWindowRateLimiter(90, 60_000);
  const websocketLimiter = new FixedWindowRateLimiter(30, 60_000);

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
      reply.header("retry-after", "60");
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
        reply.header("retry-after", "60");
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

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header(
      "content-security-policy",
      contentSecurityPolicy(options.config.mapStyleUrl)
    );
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
  const renderedIndex = () =>
    indexTemplate?.replace(
        "</head>",
        `<meta name="flightmap-config" content="${encodeURIComponent(
          JSON.stringify({
            mapStyleUrl: options.config.mapStyleUrl,
            receiverName: options.config.receiverName,
            receiverLatitude: options.config.receiverLatitude,
            receiverLongitude: options.config.receiverLongitude,
            displayTimeZone: options.config.displayTimeZone,
            rangeRingsNm: options.config.rangeRingsNm,
            mapWaypoints: options.config.mapWaypoints
          })
        )}"></head>`
      ) ?? null;
  if (options.config.serveWeb && existsSync(indexFile)) {
    await app.register(fastifyStatic, {
      root: options.config.webDistDir,
      prefix: "/",
      wildcard: false,
      index: false,
      immutable: true,
      maxAge: "1y",
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
    app.get("/", async (_request, reply) => {
      reply.header("cache-control", "no-cache");
      return reply.type("text/html").send(renderedIndex());
    });
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
