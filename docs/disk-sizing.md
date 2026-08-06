# Disk sizing

Reserve at least 40 GB of free space for the PostgreSQL volume. That is a minimum
for a modest receiver, not a guarantee for every traffic level. One positioned
aircraft creates one row per unique one-second receiver snapshot.

Estimate rows:

```text
rows = average positioned aircraft × 86,400 × retention days
```

Examples at 30 days:

| Average positioned aircraft | Position rows |
| ---: | ---: |
| 10 | 25.9 million |
| 25 | 64.8 million |
| 50 | 129.6 million |
| 100 | 259.2 million |
| 250 | 648.0 million |

Actual bytes per row depend on nullability, text/array values, PostgreSQL tuple
overhead, and three telemetry indexes. Measure the real installation after at
least several representative days. For initial planning, 350–700 bytes per
position row including indexes is a useful conservative range; add at least 25%
headroom for WAL, temporary queries, maintenance, metadata, and backups in
progress.

At sustained high aircraft counts, 40 GB is insufficient. Either provide a much
larger SSD volume or reduce detailed-history retention in Settings. The
250-aircraft test is a throughput acceptance case and does not imply that a
40 GB volume can retain 250 aircraft continuously for 30 days.

## The indefinite tables

Lowering retention bounds `position_samples` and the other 30-day tables. It
does not bound the aggregates, which are kept indefinitely by design and go on
growing after detailed tracks have been dropped.

`aircraft_summary` and `daily_aircraft_summary` grow with the number of
distinct airframes heard, which for a fixed receiver flattens out within a few
months. `daily_coverage_cells` and `daily_range_histogram` are bounded per day
by the geometry of the receiver's coverage, not by traffic.

`daily_coverage_cell_aircraft` is the one to watch. It holds one row per day,
0.05-degree cell, and aircraft, so it grows with traffic every day and is never
pruned — the coverage map's unique-aircraft counts read it, and a 366-day
window can sit anywhere in history, so no row ever becomes unreadable. Estimate:

```text
rows per day ≈ distinct aircraft per day × cells each is seen in
```

A receiver hearing 3,000 distinct aircraft a day, each crossing 40 cells, adds
about 120,000 rows a day — roughly 44 million rows and a few GB a year
including the primary-key index. Measure yours with the table breakdown below
after a representative week and multiply. If that growth is not wanted, the
supported way to reclaim it is to delete rows older than the oldest coverage
window you intend to query, accepting that unique-aircraft counts before that
date become zero.

## Measure database use

The system page and `GET /api/v1/status` expose total database use and retained
bounds. Set database volume capacity in Settings so the system page can also
show utilization and degrade health at 90%. For a table breakdown:

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="
    SELECT
      relname,
      pg_size_pretty(pg_total_relation_size(relid)) AS total,
      pg_size_pretty(pg_relation_size(relid)) AS table_only,
      pg_size_pretty(pg_indexes_size(relid)) AS indexes
    FROM pg_catalog.pg_statio_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 25;
  "'
```

Database total:

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --tuples-only --command="SELECT pg_size_pretty(pg_database_size(current_database()));"'
```

Filesystem free space:

```sh
docker compose exec -T db sh -c 'df -h "$PGDATA"'
```

Container-layer use shown by `docker system df` is not a substitute for checking
the filesystem that backs the named volume.

## Capacity policy

Alert before the database filesystem reaches 80% use. Investigate immediately at
90%. PostgreSQL needs working space for WAL and queries; waiting until 100% can
turn routine pruning into an outage.

If growth is unexpectedly high:

1. confirm detailed-history retention in Settings;
2. verify daily maintenance is succeeding;
3. check for partitions older than the cutoff;
4. measure the current average positioned-aircraft count;
5. inspect long-running transactions that may delay cleanup.

Lowering retention takes effect on the next maintenance run. Create a backup
first, then run `./infra/scripts/maintenance.sh`. Do not delete the Docker volume
to reclaim space unless the explicit goal is to discard all history.
