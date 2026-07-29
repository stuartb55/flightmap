import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { LiveHub } from "../realtime/live-hub.js";
import {
  FixedWindowRateLimiter,
  RequestSecurity
} from "../security.js";

export async function registerWebSocketRoute(
  app: FastifyInstance,
  hub: LiveHub,
  security: RequestSecurity,
  connectionLimiter: FixedWindowRateLimiter
): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 1024,
      perMessageDeflate: false
    }
  });

  app.get(
    "/api/v1/live",
    { websocket: true },
    (socket, request) => {
      if (
        !security.hostAllowed(request.headers.host) ||
        !security.originAllowed(
          request.headers.origin,
          request.headers.host
        ) ||
        !connectionLimiter.consume(request.ip)
      ) {
        socket.close(1008, "WebSocket policy rejected");
        return;
      }
      const rawSince = (request.query as { since?: unknown }).since;
      const since =
        typeof rawSince === "string" && /^\d+$/.test(rawSince)
          ? Number(rawSince)
          : undefined;
      if (
        rawSince !== undefined &&
        (since === undefined || !Number.isSafeInteger(since))
      ) {
        socket.close(1008, "Invalid sequence");
        return;
      }

      const unsubscribe = hub.subscribe((message) => {
        if (socket.readyState === socket.OPEN) {
          if (socket.bufferedAmount > 1024 * 1024) {
            socket.close(1013, "Client is too slow; resnapshot");
            return;
          }
          try {
            socket.send(JSON.stringify(message));
          } catch {
            socket.terminate();
          }
        }
      }, since);
      const keepalive = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30_000);
      keepalive.unref();
      socket.once("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
      socket.once("error", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    }
  );
}
