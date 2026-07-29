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
larger SSD volume or reduce `HISTORY_RETENTION_DAYS`. The 250-aircraft test is a
throughput acceptance case and does not imply that a 40 GB volume can retain 250
aircraft continuously for 30 days.

## Measure database use

The system page and `GET /api/v1/status` expose total database use and retained
bounds. Set `DATABASE_VOLUME_CAPACITY_BYTES` to the usable capacity of the
PostgreSQL volume so the system page can also show utilization and degrade
health at 90%. For a table breakdown:

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
docker compose exec -T db df -h /var/lib/postgresql/data
```

Container-layer use shown by `docker system df` is not a substitute for checking
the filesystem that backs the named volume.

## Capacity policy

Alert before the database filesystem reaches 80% use. Investigate immediately at
90%. PostgreSQL needs working space for WAL and queries; waiting until 100% can
turn routine pruning into an outage.

If growth is unexpectedly high:

1. confirm `HISTORY_RETENTION_DAYS`;
2. verify daily maintenance is succeeding;
3. check for partitions older than the cutoff;
4. measure the current average positioned-aircraft count;
5. inspect long-running transactions that may delay cleanup.

Lowering retention takes effect on the next maintenance run. Create a backup
first, then run `./infra/scripts/maintenance.sh`. Do not delete the Docker volume
to reclaim space unless the explicit goal is to discard all history.
