# Database model

All timestamps are `timestamptz` values interpreted as UTC. ICAO identifiers are
normalized to lowercase six-character values before persistence. Receiver
fields that are unavailable remain null; `alt_baro: "ground"` is stored as
`on_ground=true` with no fabricated airborne altitude.

The canonical, checksum-protected migrations are in
`apps/server/src/db/migrations`. `schema_migrations` and a PostgreSQL advisory
lock make startup migrations serial and restart-safe.

## Retention classes

| Table | Purpose | Retention |
| --- | --- | --- |
| `position_samples` | One positioned sample per ICAO and unique snapshot | UTC daily partitions, 30 days by default |
| `track_sessions` | Five-minute-gap track sessions and extrema | 30 days after the session ends |
| `receiver_samples` | Minute receiver health/statistics | 30 days |
| `hourly_aircraft_activity` | Compact per-aircraft/hour report and session rollups | Detailed-history retention |
| `daily_coverage_cells` | Positioned reports grouped into fixed 0.05-degree cells | Indefinite |
| `alert_events` | Emergency and watchlist events | 30 days |
| `current_aircraft` | Latest normalized state for restart/reconnect | Current state only |
| `aircraft_summary` | First/last seen and lifetime counters | Indefinite |
| `daily_aircraft_summary` | Compact per-aircraft/day activity | Indefinite |
| `aircraft_metadata` | Active local ICAO enrichment | Until atomically replaced |
| `aircraft_metadata_import` | Active import version/freshness | Current status |
| `watchlist` | User watch configuration | Indefinite |
| `saved_views` | Up to 20 strict Live/History/Insights configurations | Indefinite |
| `insight_backfill_state` | Resumable daily aggregate-backfill checkpoint | Current state |
| `receiver_state` | Receiver coordinates/version | Current state only |
| `collector_checkpoint` | Duplicate/restart-safe snapshot cursor | Current state only |
| `maintenance_log` | Recent maintenance audit | Operational record |

## Position partitions and indexes

`position_samples` is range-partitioned on `recorded_at`. The
`ensure_position_partition(timestamptz)` function creates a UTC daily child
within bounded safety limits. Index definitions on the partitioned parent are
propagated to children:

- `(icao, recorded_at DESC)` for aircraft history;
- `(session_id, recorded_at)` for replay;
- `(recorded_at DESC)` for bounded time scans.

The primary key `(recorded_at, icao)` enforces at most one row for an aircraft in
one receiver snapshot timestamp. Every snapshot is inserted in one transaction,
along with current state, sessions, summaries, alerts, hourly activity, and
coverage cells. Aircraft are grouped by geographic cell before transactional
upserts, limiting write amplification at high aircraft counts.

Track/session and summary indexes support time and ICAO lookup. GIN/trigram
indexes support callsign and metadata search without sequentially scanning all
identity rows.

## Metadata replacement

Imports use transaction-local staging. Validation occurs before the active table
is changed; the active `aircraft_metadata` rows and
`aircraft_metadata_import` status commit together. A thrown error rolls the
entire transaction back, preserving the previous successful import.

## Operational invariants

- Detailed retention must never delete `aircraft_summary` or
  `daily_aircraft_summary`.
- First and last sightings are retained in `aircraft_summary` without creating alerts.
- A callsign change updates a session and does not split it.
- No positioned report for five minutes closes a session.
- Position inserts calculate receiver-relative nautical miles and true bearing.
- A malformed aircraft record is rejected individually; other rows in the
  snapshot may still commit.
- Coverage aggregates are analytical summaries and never replace exact retained
  track points.
- Aggregate backfill advances in idempotent UTC-day batches after readiness and
  resumes from `insight_backfill_state` after interruption.

See [maintenance](maintenance.md) for partition inspection and manual recovery.
