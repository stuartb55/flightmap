# Backup and restore

PostgreSQL data lives in the named Docker volume `flightmap-db-v18`. A volume is
not a backup: accidental deletion, filesystem corruption, and host failure
affect it too. Keep versioned database dumps on separate storage.

## Create a logical backup

The helper streams a compressed PostgreSQL custom archive to the host, validates
its table of contents, then atomically publishes it. It also writes a SHA-256
file when the host provides `sha256sum` or `shasum`.

```sh
./infra/scripts/backup.sh
./infra/scripts/backup.sh /mnt/backup/flightmap
```

The default destination is `./backups/flightmap-UTC_TIMESTAMP.dump`. Backups
include schema, partitions, summaries, configuration, and detailed telemetry.
They do not include `.env`; preserve that separately in a secure location.

Copy the resulting `.dump` and `.sha256` off-host. Periodically test restoration
on a disposable installation. A backup that has never been restored is only an
assumption.

## Restore

Restore replaces the current database. First take a fresh backup if the current
state may still be useful:

```sh
./infra/scripts/backup.sh
./infra/scripts/restore.sh /mnt/backup/flightmap/flightmap-20260101T020000Z.dump --confirm
```

The explicit `--confirm` is required. The helper:

1. starts PostgreSQL if needed and validates the archive;
2. stops the app to remove database writers;
3. drops and recreates the database from the archive;
4. starts the app, which applies migrations newer than the backup.

If restore fails, the app stays stopped. Inspect `docker compose logs db` before
making another change.

After a successful restore:

```sh
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
```

Confirm the oldest/newest sample timestamps, summary counts, watchlist, metadata
date, and current collection. `current_aircraft` may initially describe state
from backup time; fresh receiver snapshots replace it after startup.

## Disaster recovery on a new host

1. Install Docker and copy the repository at the desired application version.
2. Restore the saved `.env`.
3. Start only PostgreSQL: `docker compose up -d db`.
4. Run the restore helper with the archive and `--confirm`.
5. Verify readiness and retention status.

Use an application version equal to or newer than the version that created the
backup. PostgreSQL custom archives are portable across common host CPU
architectures; restoring with the same or a newer supported PostgreSQL major
version is the safest path.
