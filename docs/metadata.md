# Aircraft metadata

Flightmap uses a local aircraft database; it does not make one external API call
per aircraft. The default source is the readsb-compatible compressed CSV from
the [`csv` branch of tar1090-db](https://github.com/wiedehopf/tar1090-db/tree/csv),
the database format recommended by
[readsb](https://github.com/wiedehopf/readsb/blob/dev/README.md).

Default:

```dotenv
METADATA_URL=https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz
METADATA_CHECK_INTERVAL_MS=604800000
METADATA_TIMEOUT_MS=30000
METADATA_MIN_ROWS=100000
METADATA_MAX_DOWNLOAD_BYTES=50000000
METADATA_MAX_UNCOMPRESSED_BYTES=250000000
METADATA_UPDATES_ENABLED=true
```

## Update behavior

At startup and then at the configured interval, the updater makes a conditional
HTTP request using the prior successful ETag and Last-Modified values. A `304`
response records a successful check without rewriting the table.

For a changed file, the updater:

1. streams the download into a private temporary file with a compressed-byte
   limit;
2. streams decompression and CSV parsing with a separate uncompressed-byte
   limit into a temporary staging table;
3. normalizes ICAO identifiers to lowercase six-character hexadecimal values;
4. rejects invalid rows and validates the resulting row count against
   `METADATA_MIN_ROWS`;
5. replaces `aircraft_metadata` in one database transaction;
6. records source URL, validators, version/date, row count, and import time in
   `aircraft_metadata_import`.

An HTTP, decompression, parse, or validation failure rolls back the transaction.
The prior active metadata remains searchable, and the failure is exposed through
the status API and structured logs.

The source format is maintained outside this project and can change. Do not
lower `METADATA_MIN_ROWS` merely to make a failed import pass; first inspect the
file and parser expectations.

## Manual refresh

The scheduled updater remains the normal path. To request an immediate refresh:

```sh
docker compose exec -T app npm run metadata:refresh
```

If the app is stopped:

```sh
docker compose run --rm app npm run metadata:refresh
```

Then inspect:

```sh
curl --fail http://127.0.0.1:8080/api/v1/status
docker compose logs --since=15m app
```

If the response is unchanged because the server returned `304`, that is a
successful refresh check. To switch sources, update `METADATA_URL`, recreate the
app container, and run a manual refresh. Use only a source compatible with the
readsb/tar1090 CSV columns.

## Offline installations

Set `METADATA_UPDATES_ENABLED=false` when the host intentionally has no outbound
access. Existing imported rows continue to work. A completely new offline
installation starts with no registration/type/operator enrichment until a
compatible source is made reachable and a refresh succeeds.
