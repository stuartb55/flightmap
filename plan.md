# ADS-B Live Map and 30-Day Flight History

## Summary

Build a responsive, LAN-only web application that:

- Polls the existing readsb/dump1090 receiver every second.
- Displays live aircraft on a polished dark aviation map.
- Retains one-second core telemetry for positioned aircraft for 30 days.
- Preserves compact aircraft and daily sighting summaries indefinitely.
- Provides aircraft search, historical tracks, and animated replay.
- Generates focused in-app alerts for emergency squawks, explicit emergency states, and watchlist matches.
- Runs as a Docker Compose stack on a desktop/server-class LAN host.

The empty workspace will become a TypeScript monorepo using React, MapLibre, Fastify, and PostgreSQL.

## Architecture and Data Collection

### Application stack

- React + TypeScript + Vite for the responsive web interface.
- MapLibre GL JS for aircraft, track, receiver, and range-ring layers.
- Fastify + TypeScript for REST, WebSocket, ingestion, and scheduled maintenance.
- PostgreSQL with native daily partitions for high-volume telemetry.
- Shared Zod schemas for receiver validation and API contracts.
- A single application container will serve the compiled UI, API, WebSocket endpoint, and collector; PostgreSQL remains a separate internal container.
- Use a multi-stage Docker build with ARM64 and x86-64 support.

### Receiver integration

- Read `aircraft.json` every 1,000 ms using its `now` timestamp and message count to reject duplicate or out-of-order snapshots.
- Read `receiver.json` at startup and periodically to obtain receiver coordinates, software version, and advertised refresh interval.
- Read `stats.json` every 60 seconds for message rate, accepted/bad messages, signal/noise, CPU time, and receiver health.
- Use short request timeouts and exponential retry backoff while disconnected, returning to one-second polling immediately after recovery.
- Mark the receiver degraded after 5 seconds without a valid snapshot and offline after 15 seconds.
- Never allow malformed aircraft records to terminate ingestion; reject the affected record, count it, and continue.
- Preserve UTC internally and display dates in `Europe/London`.

### Recording rules

- For every new receiver snapshot, insert one telemetry row for each aircraft with a valid latitude and longitude.
- Retain core fields: source timestamp, ICAO hex, callsign, coordinates, barometric/geometric altitude, ground/indicated/true airspeed, Mach, track/headings, vertical rates, squawk, emergency state, category, RSSI, message count, `seen`, `seen_pos`, navigation targets, and ADS-B quality/source indicators.
- Treat fields as nullable and support special source values such as `alt_baro: "ground"`.
- Aircraft without positions update current state, identity, first/last-seen information, and alerts, but do not create duplicate position rows.
- Start a track session on the first positioned report; close it after five minutes without a positioned report. A callsign change updates the session but does not split it unless the gap threshold is crossed.
- Calculate receiver distance and bearing during ingestion for range display and historical summaries.
- Batch each snapshot into one database transaction.

### Storage model

- `position_samples`: daily range-partitioned one-second telemetry, indexed by `(icao, recorded_at)`, session/time, and time; delete partitions older than 30 days.
- `track_sessions`: session start/end, callsigns, sample count, altitude/speed extrema, closest range, and last known state; retain detailed session records for 30 days.
- `aircraft_summary`: indefinite first/last seen, total observations, session count, closest range, and latest known identity.
- `daily_aircraft_summary`: indefinite compact per-aircraft/day statistics so older activity remains searchable after track deletion.
- `current_aircraft`: latest normalized state used for restart recovery and initial live snapshots.
- `receiver_samples`: minute-level health statistics retained for 30 days.
- `aircraft_metadata`: local ICAO lookup containing registration, type code, description, operator/owner, and country.
- `watchlist` and `alert_events`: watchlist configuration is indefinite; alert events are retained for 30 days.
- Run partition creation and retention pruning daily, with a manual maintenance command for recovery.
- Document a minimum recommended 40 GB free database volume and expose database size/retention status in system health.

### Aircraft metadata

- Import the readsb-compatible `tar1090-db` compressed CSV recommended by the readsb project, rather than making per-aircraft external API calls. [readsb database documentation](https://github.com/wiedehopf/readsb)
- Check weekly using HTTP ETag/Last-Modified; download to staging, validate columns and row counts, then atomically replace the active metadata table.
- Keep the previous successful import if download or validation fails.
- Make the metadata URL and update schedule configurable and show its version/date in the UI.

## User Experience and Interfaces

### Live dashboard

- Default to a modern dark radar layout centered on the receiver at `53.61, -2.31`.
- Use MapLibre with the configurable OpenFreeMap dark vector style; its hosted service supports MapLibre without an API key and includes required attribution. [OpenFreeMap guide](https://openfreemap.org/quick_start/)
- Render aircraft as WebGL map symbols rotated to ground track, coloured by altitude, faded by freshness, and visually distinguished for selected, watched, stale, and emergency aircraft.
- Show the receiver marker, configurable nautical-mile range rings, scale, zoom controls, and “fit active aircraft.”
- Desktop: map with collapsible aircraft table and detail panel.
- Mobile: full map with bottom sheets for filters, aircraft list, and aircraft details.
- The live table supports sorting and filtering by callsign/registration/ICAO, altitude, distance, speed, category, source, freshness, and alert state.
- Selecting an aircraft synchronizes the map, table, detail sheet, recent trail, and metadata.
- Details show telemetry, signal/quality indicators, navigation targets, receiver-relative distance/bearing, metadata, first/last seen, and watchlist control.
- Aircraft with no current position remain visible in the table but are not placed on the map.
- Use aviation units throughout: feet, knots, nautical miles, feet per minute, and hPa.

### History and replay

- Search by date/time, ICAO, callsign, registration, type, operator, or alert state.
- Results list track sessions with start/end, duration, callsigns, extrema, closest approach, and sample count.
- Selecting sessions draws altitude-coloured trails and opens a time slider.
- Replay interpolates marker movement between stored one-second samples while retaining actual points as the source of truth.
- Support play/pause, speed controls, scrubbing, follow-aircraft mode, and simultaneous replay of filtered sessions.
- Default history responses use adaptive downsampling for quick display; exact one-second data is available for a single session or bounded six-hour query.
- Older indefinite summaries remain searchable but clearly show that the detailed track expired.
- Do not implement CSV or GeoJSON exports in v1.

### Alerts

- Create alerts for squawks 7500, 7600, and 7700, explicit non-`none` emergency states, and watchlist matches. Record first sightings in receiver history without creating alerts.
- Deduplicate each rule per track session; emergency state changes may create a new alert.
- Display a persistent alert badge/feed, map highlighting, and dismissible in-app banners.
- No email, browser push, Discord, or other external notifications in v1.
- First and last sightings remain available from the indefinite aircraft summary after detailed tracks expire.

### API and real-time contract

- `GET /api/v1/status`: receiver, collector, database, retention, metadata, and application health.
- `GET /api/v1/aircraft/live`: complete current snapshot for initial load and reconnect.
- `GET /api/v1/aircraft/:icao`: live state, metadata, summary, recent sessions, and alerts.
- `GET /api/v1/sessions`: cursor-paginated historical search and filters.
- `GET /api/v1/sessions/:id/track?resolution=auto|1s|5s|15s|60s`: track points and session metadata.
- `GET /api/v1/summaries`: older daily/aircraft summary search.
- `GET /api/v1/alerts` and `POST /api/v1/alerts/:id/dismiss`.
- `GET /api/v1/watchlist`, `PUT /api/v1/watchlist/:icao`, and `DELETE /api/v1/watchlist/:icao`.
- `WS /api/v1/live`: sequenced aircraft upserts/removals, receiver state, and alerts. Clients obtain a REST snapshot first, apply ordered deltas, and resnapshot after a sequence gap.
- Return ISO-8601 UTC timestamps, lowercase six-character ICAO identifiers, nullable unavailable values, and stable machine-readable error codes.
- Validate query ranges and cap unbounded history requests to prevent accidental multi-million-row responses.

## Operations, Security, and Configuration

- Docker Compose exposes only the application port, default `8080`; PostgreSQL is reachable only on the Compose network.
- Configuration lives in `.env`, with a checked-in `.env.example` containing:
  - `RECEIVER_BASE_URL=http://192.168.1.118:81/data`
  - `POLL_INTERVAL_MS=1000`
  - `HISTORY_RETENTION_DAYS=30`
  - `DISPLAY_TIME_ZONE=Europe/London`
  - `MAP_STYLE_URL=https://tiles.openfreemap.org/styles/dark`
  - Metadata URL/schedule, database credentials, timeouts, and application port.
- Receiver coordinates are discovered automatically, with optional environment overrides.
- Serve UI and API from one origin, avoiding receiver CORS and mixed-origin browser issues.
- Do not add login/authentication in v1; bind to the LAN interface and document that the deployment assumes a trusted home network.
- Include liveness/readiness checks, structured logs, graceful shutdown, database migration commands, and restart-safe collection.
- Provide setup, upgrade, metadata refresh, backup/restore, disk-sizing, and troubleshooting documentation.
- Add a read-only system page showing receiver latency, last successful polls, rejected records, ingestion rate, database use, oldest/newest retained sample, and metadata freshness.

## Test and Acceptance Plan

- Unit-test parsing of full, sparse, MLAT, stale, ground, malformed, missing-position, and unknown-field aircraft records.
- Test duplicate snapshot rejection, UTC conversion, distance/bearing calculations, session boundaries, summary aggregation, first-sighting history, emergency/watchlist deduplication, and retention cutoffs.
- Integration-test against a controllable fake receiver for normal polling, timeouts, invalid JSON, partial records, out-of-order timestamps, receiver restart, outage, and recovery.
- Verify daily partition creation, 30-day pruning, indefinite summary preservation, metadata atomic replacement, and failed-import rollback.
- Contract-test every REST schema and WebSocket snapshot/delta/reconnect flow.
- Component-test aircraft filtering, synchronized selection, stale/offline states, alerts, responsive panels, and unavailable fields.
- End-to-end test live tracking, watchlist alerts, historical search, multi-track display, replay controls, and expired-track messaging on desktop and mobile viewports.
- Load-test ingestion and live display with at least 250 simultaneous aircraft at one-second cadence; collection must remain current and the UI responsive.
- Benchmark bounded track queries and adaptive replay so an ordinary single-session replay begins rendering within two seconds on the target server/LAN.
- Confirm the UI reports receiver failure within 15 seconds and resumes automatically without losing application availability.
- Verify accessibility with keyboard navigation, visible focus states, adequate contrast, semantic table/detail controls, and reduced-motion handling.

## Assumptions and Defaults

- The application monitors one receiver in v1.
- The receiver remains reachable from the Docker host at the supplied LAN address.
- Detailed retention means every fresh positioned aircraft is sampled once per unique one-second receiver snapshot; it does not mean storing the complete raw JSON object.
- Compact aircraft and daily summaries remain indefinitely, while positions, detailed sessions, receiver statistics, and alert events expire after 30 days.
- The host is a desktop/server-class machine with SSD-backed persistent storage.
- Internet access is available for map tiles and weekly metadata refresh; live collection and database history remain functional if internet access is lost.
- No observer notes, photos, manual sightings, external notifications, exports, public access, or multi-user permissions are included in v1.
