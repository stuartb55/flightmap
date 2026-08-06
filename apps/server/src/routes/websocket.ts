import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { LiveHub } from "../realtime/live-hub.js";
import {
  FixedWindowRateLimiter,
  RequestSecurity
} from "../security.js";

/** Every open socket receives every delta, so concurrency is capped as well
 *  as connection rate. A LAN install has a handful of clients. */
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_IP = 8;

export async function registerWebSocketRoute(
  app: FastifyInstance,
  hub: LiveHub,
  security: RequestSecurity,
  connectionLimiter: FixedWindowRateLimiter,
  limits: { total?: number; perIp?: number } = {}
): Promise<void> {
  const maxConnections = limits.total ?? MAX_CONNECTIONS;
  const maxPerIp = limits.perIp ?? MAX_CONNECTIONS_PER_IP;
  let openConnections = 0;
  const openByIp = new Map<string, number>();

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
      const ip = request.ip;
      if (
        openConnections >= maxConnections ||
        (openByIp.get(ip) ?? 0) >= maxPerIp
      ) {
        socket.close(1013, "Too many live connections");
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

      openConnections += 1;
      openByIp.set(ip, (openByIp.get(ip) ?? 0) + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        openConnections -= 1;
        const remaining = (openByIp.get(ip) ?? 1) - 1;
        if (remaining > 0) openByIp.set(ip, remaining);
        else openByIp.delete(ip);
      };

      const unsubscribe = hub.subscribe((message, encoded) => {
        if (socket.readyState === socket.OPEN) {
          if (socket.bufferedAmount > 1024 * 1024) {
            socket.close(1013, "Client is too slow; resnapshot");
            return;
          }
          try {
            socket.send(encoded);
          } catch {
            socket.terminate();
            return;
          }
          /*
           * The hub declines to subscribe a client whose `since` it cannot
           * serve, so nothing further will ever arrive on this socket. Left
           * open it would hold a connection slot — and one of this address's
           * eight — while silent. The client resnapshots and redials.
           */
          if (message.type === "resync_required") {
            socket.close(1000, "Resynchronise and reconnect");
          }
        }
      }, since);
      /*
       * Ping, and require an answer. Without the liveness half, a peer that
       * vanished without a TCP close — asleep, off the network — keeps its
       * slot until the kernel eventually gives up on the socket.
       */
      let awaitingPong = false;
      socket.on("pong", () => {
        awaitingPong = false;
      });
      const keepalive = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        if (awaitingPong) {
          socket.terminate();
          return;
        }
        awaitingPong = true;
        socket.ping();
      }, 30_000);
      keepalive.unref();
      const teardown = (): void => {
        clearInterval(keepalive);
        unsubscribe();
        release();
      };
      socket.once("close", teardown);
      socket.once("error", teardown);
    }
  );
}
