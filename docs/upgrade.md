# Upgrade

Application migrations are forward-only and run automatically before the server
accepts traffic. Treat every upgrade as a database change even when a release
contains only UI work.

## Standard procedure

From the repository root:

```sh
./infra/scripts/backup.sh
docker compose build --pull app
docker compose up -d app
docker compose ps
```

When deploying from Git, update the working tree to the exact reviewed tag or
commit before `docker compose build --pull app`. Do not upgrade directly from an
unreviewed moving branch.

Watch startup:

```sh
docker compose logs --follow --since=2m app
```

The expected sequence is database readiness, advisory-lock acquisition,
pending migrations, collector recovery, and readiness. In a second terminal:

```sh
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/api/v1/status
```

Check that:

- the reported application version is the intended release;
- receiver polling advances once per second;
- the newest retained sample advances;
- database and metadata statuses are healthy;
- a browser reload receives the live REST snapshot and WebSocket deltas.

## Manual migration

Normal container startup already migrates. To run the same idempotent path
explicitly:

```sh
./infra/scripts/migrate.sh
```

Multiple app instances and manual migration are serialized by a PostgreSQL
advisory lock. Do not edit `schema_migrations` by hand.

## PostgreSQL image upgrades

Changing the `postgres:` major tag is not an application upgrade. A PostgreSQL
data directory cannot simply be started by a different major version.

For a major database upgrade:

1. Create and copy off-host a logical backup.
2. Stop the stack.
3. Create a new empty volume using the new PostgreSQL image.
4. Restore the logical archive.
5. Start the app and run migrations.
6. Retain the old volume until validation and a new backup succeed.

Never remove the old volume as part of the first upgrade command.

## Rollback

Rebuilding the previous application image is safe only if that version can read
the upgraded schema. Migrations are not automatically reversed. If the release
notes do not explicitly guarantee schema compatibility, restore the pre-upgrade
backup into a fresh database volume and run the older application against it.

Keep the failed database volume until the incident is understood; it may contain
new telemetry absent from the pre-upgrade backup.
