# Flightmap

Flightmap is a self-hosted ADS-B dashboard for a trusted home LAN. It polls one
readsb/dump1090 receiver every second, renders a responsive live aviation map,
stores 30 days of one-second tracks in PostgreSQL, and keeps compact sighting
history indefinitely.

## Highlights

- Dark MapLibre live map with altitude colouring, freshness, range rings,
  Manchester arrival/departure fixes, receiver-relative distance/bearing,
  synchronized table and aircraft details.
- Restart-safe collector with receiver health, malformed-record isolation,
  duplicate/out-of-order snapshot rejection, and outage recovery.
- Five-minute-gap track sessions, historical search, adaptive track resolution,
  multi-track display, and animated replay.
- In-app alerts for 7500/7600/7700 squawks, explicit emergencies, first-ever
  sightings, and watchlist matches.
- Local registration/type/operator enrichment from the readsb-compatible
  tar1090 aircraft database.
- Daily PostgreSQL partitions, automated 30-day detail retention, indefinite
  aircraft/day summaries, a system health view, and persistent in-app admin
  settings.
- One multi-architecture application image serving the UI, REST API, WebSocket,
  collector, and scheduled work; PostgreSQL stays private to Compose.

## Quick start

Requirements: Docker Engine with Docker Compose v2, a reachable
readsb/dump1090 JSON endpoint, and at least 40 GB free on an SSD-backed database
volume.

```sh
cp .env.example .env
```

Edit `.env`:

1. Replace `POSTGRES_PASSWORD` with a long URL-safe random value.
2. For LAN access, bind `APP_BIND_ADDRESS` to the host's trusted LAN IP and
   add the address/hostname users enter to `APP_ALLOWED_HOSTS`.

Then:

```sh
docker compose up -d --build
docker compose ps
```

Open `http://HOST:8080`, then open **Settings** and set the receiver data URL.
Receiver, display, retention, alerting, and metadata options are saved in
PostgreSQL and can be changed in the running app. PostgreSQL is not published
on a host port. The app applies pending migrations before it becomes ready.

```sh
curl --fail http://127.0.0.1:8080/health/ready
docker compose logs --follow app
```

Receiver coordinates are discovered from `receiver.json`; both can be
overridden together in Settings. Dates are persisted in UTC and displayed in
`Europe/London` by default.

## Development

The repository is an npm workspace requiring Node.js 24:

```sh
npm install
npm run dev
```

Common checks:

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run build
```

The web development server runs on port 5173 and proxies `/api` (including the
WebSocket) to the Fastify server on port 8080. Start a local PostgreSQL instance
and set `DATABASE_URL`, or run only the Compose database:

```sh
docker compose up -d db
npm run build
npm run db:migrate
```

## Container images

GitHub Actions builds the application for `linux/amd64` and `linux/arm64`.
Pull requests validate the image without publishing it. A successful `main` CI
run publishes `main`, `latest`, and an immutable `sha-<commit>` tag to
`ghcr.io/<owner>/<repository>`. Tags such as `v1.2.3` additionally publish
semantic-version tags. A manual workflow run can optionally publish only its
commit-addressed tag.

```sh
docker pull ghcr.io/OWNER/REPOSITORY:latest
```

## Dependency updates

[Renovate](https://github.com/apps/renovate) manages npm packages, Docker image
digests, GitHub Actions, lockfile maintenance, and Node.js 24 updates according
to [`renovate.json`](renovate.json). Install the hosted Renovate app for the
GitHub repository after its first push; the checked-in configuration skips the
onboarding configuration PR.

## Fake receiver

A dependency-free controllable readsb fixture covers normal polling, timeout,
invalid JSON, partial records, duplicate/out-of-order time, receiver restart,
outage/recovery, stale data, empty sky, custom snapshots, and up to 1,000
generated aircraft.

```sh
PORT=8081 node infra/fake-receiver/server.mjs
```

Set the receiver data URL in Settings to `http://127.0.0.1:8081/data`. See
[the fake receiver guide](infra/fake-receiver/README.md) for its control API and
Compose testing profile.

## API

The primary routes are:

- `GET /api/v1/status`
- `GET /api/v1/aircraft/live`
- `GET /api/v1/aircraft/:icao`
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id/track` with bounded `resolution`, `from`, `tail`,
  and `limit` query options
- `GET /api/v1/summaries`
- `GET /api/v1/alerts`, `POST /api/v1/alerts/:id/dismiss`, and bulk
  `POST /api/v1/alerts/dismiss`
- `GET /api/v1/watchlist`, `PUT /api/v1/watchlist/:icao`, and
  `DELETE /api/v1/watchlist/:icao`
- `GET /api/v1/settings` and `PATCH /api/v1/settings`
- `WS /api/v1/live`

Clients take a complete REST snapshot before applying ordered WebSocket deltas
and resnapshot after any sequence gap. API timestamps are ISO-8601 UTC and
unavailable values are null.

## Operations

- [Deployment, configuration, health, and security](docs/operations.md)
- [Database model and retention classes](docs/database.md)
- [Daily maintenance and partition recovery](docs/maintenance.md)
- [Disk sizing and capacity checks](docs/disk-sizing.md)
- [Aircraft metadata refresh](docs/metadata.md)
- [Backup and restore](docs/backup-restore.md)
- [Upgrade and rollback](docs/upgrade.md)
- [Troubleshooting](docs/troubleshooting.md)

Flightmap has no built-in authentication. It retains strict host/origin checks,
request rate limits, and a restrictive browser security policy. Keep port 8080
on a trusted LAN and do not expose it directly to the internet; use an
authenticated TLS reverse proxy for remote access.
