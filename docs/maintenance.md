# Database maintenance and retention

Core positions are UTC daily range partitions. The canonical migrations live in
`apps/server/src/db/migrations`; they create the parent table, local indexes, and
initial partitions. The app ensures the current and upcoming partitions before
inserting telemetry.

Automatic daily maintenance:

- creates upcoming `position_samples_YYYYMMDD` partitions;
- closes sessions with no positioned report for five minutes (the collector
  also sweeps these once per minute);
- drops complete position partitions older than
  `HISTORY_RETENTION_DAYS` (30 by default);
- removes expired detailed sessions, alerts, and receiver samples;
- preserves `aircraft_summary`, `daily_aircraft_summary`, metadata, and the
  watchlist indefinitely;
- records the outcome in `maintenance_log`.

Dropping a partition is intentionally used instead of deleting millions of
individual position rows. The cutoff follows UTC partition boundaries, so the
oldest sample may be up to almost one day older than the exact retention
interval.

## Manual recovery

Run the same idempotent maintenance path after prolonged downtime, a full disk,
or an operator-disabled schedule:

```sh
./infra/scripts/maintenance.sh
```

Do not manually drop a partition that overlaps the configured window. Do not
delete from indefinite summary tables to solve detailed-history disk growth.

## Inspect partitions

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="
    SELECT
      child.relname AS partition,
      pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size,
      pg_get_expr(child.relpartbound, child.oid) AS bounds
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = inhparent
    JOIN pg_class child ON child.oid = inhrelid
    WHERE parent.relname = '\''position_samples'\''
    ORDER BY child.relname;
  "'
```

Inspect recent maintenance results:

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="
    SELECT *
    FROM maintenance_log
    ORDER BY ran_at DESC
    LIMIT 10;
  "'
```

## Inspect retained bounds and counts

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="
    SELECT
      min(recorded_at) AS oldest_sample,
      max(recorded_at) AS newest_sample,
      count(*) AS position_rows
    FROM position_samples;

    SELECT
      count(*) AS aircraft,
      min(first_seen_at) AS earliest_ever_sighting,
      max(last_seen_at) AS latest_sighting
    FROM aircraft_summary;
  "'
```

The second result should remain stable across detail pruning except for new
observations. That is the important proof that indefinite sighting history was
not removed.

## PostgreSQL housekeeping

PostgreSQL autovacuum manages non-partitioned update-heavy tables. Do not schedule
`VACUUM FULL`: it requires heavyweight locks and temporarily needs additional
disk. If ordinary vacuum falls behind, diagnose long-running transactions first:

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="
    SELECT pid, now() - xact_start AS age, state, wait_event_type, wait_event
    FROM pg_stat_activity
    WHERE xact_start IS NOT NULL
    ORDER BY xact_start;
  "'
```

Use `REINDEX CONCURRENTLY` only for a measured index problem and one index at a
time. Take a backup before manual structural maintenance.
