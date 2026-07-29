# Troubleshooting

Start with:

```sh
docker compose ps
docker compose logs --since=15m app
docker compose logs --since=15m db
curl --show-error http://127.0.0.1:8080/api/v1/status
```

If `APP_ACCESS_TOKEN` is configured, sign in for command-line API checks:

```sh
curl --cookie-jar /tmp/flightmap-cookie \
  --header 'Content-Type: application/json' \
  --header 'Origin: http://127.0.0.1:8080' \
  --data '{"token":"YOUR_APP_ACCESS_TOKEN"}' \
  http://127.0.0.1:8080/api/v1/auth/login
curl --cookie /tmp/flightmap-cookie http://127.0.0.1:8080/api/v1/status
```

Logs are structured JSON. Preserve the timestamp, `errorCode`, and component
fields when reporting a problem.

## App is running but not ready

Check PostgreSQL first:

```sh
docker compose exec -T db sh -c \
  'pg_isready --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"'
```

Common causes are a mismatched password between `POSTGRES_PASSWORD` and
`DATABASE_URL`, a migration failure, or a full volume. Remember that changing
`POSTGRES_PASSWORD` does not alter the role in an existing volume.

Inspect applied migrations without editing them:

```sh
docker compose exec -T db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --command="TABLE schema_migrations;"'
```

If a checksum mismatch is reported, restore the migration file that was
originally applied and add a new migration. Never update its checksum manually.

## Receiver is degraded or offline

Test from inside the app container, because host connectivity alone does not
prove container connectivity:

```sh
docker compose exec -T app node -e \
  "fetch(process.env.RECEIVER_BASE_URL + '/receiver.json').then(async r => { console.log(r.status, await r.text()) }).catch(e => { console.error(e); process.exit(1) })"
```

Check that `RECEIVER_BASE_URL` points to the directory, not directly to
`aircraft.json`. Docker Desktop and Linux bridge networks may have different
routes to the LAN. Also check receiver firewall rules, HTTP port, and whether
the receiver advertises HTTPS redirects that the container cannot follow.

Timeouts or invalid JSON are counted and retried with backoff; they do not stop
the app. The receiver becomes offline after 15 seconds and returns to one-second
polling after the first valid recovery snapshot.

## No aircraft appear

- Verify `aircraft.json` contains an `aircraft` array and its `now` value moves.
- Aircraft without a fresh position appear in the table but not on the map.
- A frozen or lower `now` value is intentionally rejected as duplicate or
  out-of-order.
- Confirm receiver coordinates, or set both `RECEIVER_LAT` and `RECEIVER_LON`.
- Check rejected-record counts for malformed ICAO, latitude, or longitude values.

Use the fake receiver to separate receiver problems from app problems; see
`infra/fake-receiver/README.md`.

## History stopped recording

Check the newest retained sample and partition list in
[maintenance](maintenance.md). An error mentioning “no partition found” means
partition creation did not run before the UTC boundary. Run:

```sh
./infra/scripts/maintenance.sh
```

Then verify database free space. Collection is transactional per snapshot, so a
failed batch is not partly committed.

## Database volume is nearly full

Follow [disk sizing](disk-sizing.md). Take a backup before changing retention.
After lowering `HISTORY_RETENTION_DAYS`, recreate the app and run maintenance.
Do not run `VACUUM FULL` on a nearly full volume; it needs additional space.

If PostgreSQL has already stopped because the filesystem is full, free space
outside the database first (old image layers or safely copied backups), start
only `db`, then run maintenance. Do not remove files from
`/var/lib/postgresql/data` by hand.

## Metadata is stale

Run a manual refresh and inspect logs:

```sh
docker compose exec -T app npm run metadata:refresh
docker compose logs --since=15m app
```

A `304 Not Modified` is healthy. For download, parsing, row-count, or schema
errors, the last successful table remains active. See [metadata](metadata.md).

## Map is blank but aircraft table updates

The browser fetches the configured OpenFreeMap style and tiles directly. Check
browser developer tools for blocked outbound requests, content blockers, DNS,
or a restrictive firewall. Collection and historical APIs do not depend on map
tiles. Keep the required map attribution visible when changing styles.

## Live view freezes after a proxy is added

The direct Compose deployment serves UI, REST, and WebSocket from one origin. A
reverse proxy must support WebSocket upgrade for `/api/v1/live`, preserve the
host, and use timeouts longer than idle heartbeat intervals. After any sequence
gap the client deliberately obtains a new REST snapshot.

Add the public hostname to `APP_ALLOWED_HOSTS` and, only if the browser origin
differs from that host, add its full origin to `APP_ALLOWED_ORIGINS`. A rejected
upgrade closes with WebSocket policy code 1008; rejected HTTP hosts return 421.

## Restore failed

The restore helper deliberately leaves the app stopped. Preserve the database
logs and the archive. Confirm the archive with:

```sh
docker compose exec -T db pg_restore --list < /path/to/backup.dump > /dev/null
```

Restore with the same or a newer supported PostgreSQL major version. If a
pre-restore database is still needed, do not retry destructive steps until its
volume or a logical backup has been preserved.
