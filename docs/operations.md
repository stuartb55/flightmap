# Operations and deployment

Flightmap is designed for one trusted LAN and one readsb/dump1090 receiver. The
browser, API, WebSocket collector, and scheduled jobs share one app container;
PostgreSQL is reachable only from the Compose network.

## Requirements

- A current Docker Engine with Docker Compose v2.
- An x86-64 or ARM64 desktop/server-class host.
- SSD-backed persistent storage with at least 40 GB free for PostgreSQL.
- Network access from the Docker host to the receiver.
- Internet access for map tiles in the browser and weekly aircraft metadata
  updates. Collection and existing history continue without internet access.

Before deployment, confirm the receiver endpoints from the Docker host:

```sh
curl --fail --show-error http://192.168.1.118:81/data/receiver.json
curl --fail --show-error http://192.168.1.118:81/data/aircraft.json
curl --fail --show-error http://192.168.1.118:81/data/stats.json
```

## First start

```sh
cp .env.example .env
```

Edit `.env` and set:

- `RECEIVER_BASE_URL` to the directory containing the three JSON files.
- A long random `POSTGRES_PASSWORD`.
- The same password in `DATABASE_URL`.
- For LAN access, `APP_BIND_ADDRESS` to the trusted LAN address.
- Every address or hostname users enter in `APP_ALLOWED_HOSTS` (without ports).
- A long random `APP_ACCESS_TOKEN`. The token is exchanged for an HttpOnly,
  SameSite session cookie and is never stored in browser JavaScript.

Receiver latitude/longitude normally come from `receiver.json`. Set both
`RECEIVER_LAT` and `RECEIVER_LON` only when the receiver does
not advertise correct coordinates.
`RECEIVER_NAME` controls the receiver label, and `MAP_STYLE_URL` is injected
safely into the served UI at runtime.

Validate and start:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The default bind is `127.0.0.1`; network exposure therefore requires an
intentional configuration change. Open `http://HOST:8080`. The app container
waits for PostgreSQL, applies all
pending migrations under an advisory lock, then starts collection. A new
installation may need up to a minute to build partitions and become ready.

## Health and logs

- `GET /health/live` confirms that the process event loop is serving requests.
- `GET /health/ready` confirms that required dependencies and migrations are
  ready.
- `GET /api/v1/status` reports collector state, receiver latency and last poll,
  rejected records, ingestion rate, database size and retained bounds, metadata
  freshness, and retention configuration.

Useful commands:

```sh
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/api/v1/status
docker compose logs --since=15m app
docker compose logs --since=15m db
docker compose ps
```

Application logs are newline-delimited structured JSON with error stack
serialization and credential redaction. Use timestamps and
fields such as `component`, `icao`, `snapshotTimestamp`, and `errorCode` instead
of relying on message text.

Receiver health has deliberate hysteresis:

- degraded after 5 seconds without a valid snapshot;
- offline after 15 seconds;
- immediately polling at the configured cadence after recovery.

The app remains available while the receiver is offline.

## Configuration changes

After editing `.env`, recreate the app so Docker applies the environment:

```sh
docker compose up -d --force-recreate app
```

Changes to PostgreSQL credentials do not alter an already initialized database.
To rotate credentials without replacing data, change the role password inside
PostgreSQL first, then update both `POSTGRES_PASSWORD` and `DATABASE_URL`.

## Graceful stop and restart

```sh
docker compose stop
docker compose start
```

Compose gives the collector 30 seconds to stop polling, flush the in-flight
snapshot transaction, and close sockets. PostgreSQL receives 60 seconds. Avoid
`docker compose kill` except when a process cannot terminate normally.

## Network security

Do not expose port 8080 to the public internet, a guest Wi-Fi network, or an
untrusted reverse proxy. PostgreSQL has no published host port. Flightmap
rejects unlisted Host and browser Origin values and cross-origin WebSocket
upgrades. `APP_ALLOWED_ORIGINS` should only contain explicit trusted
scheme/host/port origins when a same-host deployment is not possible.

`APP_ACCESS_TOKEN` is required in production; development mode may omit it.
Rotate it by changing `.env` and recreating the app; existing browser sessions
are invalidated immediately. A reverse proxy should terminate
TLS, preserve the original Host header, and only proxy configured origins.
Flightmap also applies fixed-window request/login/WebSocket rate limits, but
these are safeguards rather than an internet-facing identity system.

When `DATABASE_SSL=true`, certificate verification remains enabled. Set
`DATABASE_SSL_CA_FILE` to a mounted private CA bundle when the server is not
covered by the operating system trust store. Set
`DATABASE_VOLUME_CAPACITY_BYTES` to expose database utilization in system
health.

MapLibre attribution remains visible because the configured OpenFreeMap style
requires it. If outbound internet is blocked, the app and collection still run,
but uncached background tiles and metadata updates will be unavailable.

## Routine schedule

- Every second: aircraft snapshot polling (when healthy).
- Every minute: receiver statistics.
- Daily: create upcoming UTC partitions, close stale sessions, aggregate
  summaries, and remove expired detail.
- Weekly: conditional metadata check using ETag/Last-Modified.
- Daily or weekly: an operator-managed backup copied off the database volume.

See [maintenance](maintenance.md), [backup and restore](backup-restore.md), and
[upgrade](upgrade.md) for the corresponding commands.
