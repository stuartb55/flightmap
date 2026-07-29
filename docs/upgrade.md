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
```

Check that:

- the reported application version is the intended release;
- receiver polling advances once per second;
- the newest retained sample advances;
- database and metadata statuses are healthy;
- a browser reload receives the live REST snapshot and WebSocket deltas.

## Upgrade to database-backed settings

The release that introduces the Settings page creates an
`application_settings` row with safe defaults. Before that first upgrade, note
any receiver, display, polling, retention, first-seen alert, metadata, or
database-capacity values customized in the old `.env`. After the app is ready,
transfer those values to **Settings**, then remove the obsolete entries from
`.env`. The new `.env.example` is the authoritative list of the four remaining
deployment values.

Subsequent upgrades retain these application settings in PostgreSQL. They are
included in normal Flightmap database backups and restores.

Compose continues to honor an existing custom `POSTGRES_DB`, `POSTGRES_USER`,
or `DATABASE_URL` for upgrade compatibility. Keep those advanced overrides
only when the installation intentionally differs from the standard database
layout.

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
Flightmap uses PostgreSQL 18's versioned data layout and mounts the named volume
at `/var/lib/postgresql`; PostgreSQL 17 installations used the legacy
`/var/lib/postgresql/data` layout.

The PostgreSQL 18 Compose service uses a new `flightmap-db-v18` volume so that
an existing PostgreSQL 17 `flightmap-db` volume remains intact. Before checking
out this change, create and copy off-host a logical backup with the PostgreSQL
17 stack. After starting PostgreSQL 18, restore that archive before resuming
normal collection. Do not delete the PostgreSQL 17 volume until the restored
database and a new PostgreSQL 18 backup have both been verified.

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
