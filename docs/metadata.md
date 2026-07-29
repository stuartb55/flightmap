# Aircraft metadata

Flightmap uses a local aircraft database; it does not make one external API call
per aircraft. The default source is the readsb-compatible compressed CSV from
the [`csv` branch of tar1090-db](https://github.com/wiedehopf/tar1090-db/tree/csv),
the database format recommended by
[readsb](https://github.com/wiedehopf/readsb/blob/dev/README.md).

The source URL, weekly check interval, request timeout, minimum row count, and
compressed/uncompressed size limits are configured on the Settings page and
persisted with the rest of the application settings.

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
4. rejects invalid rows and validates the resulting row count against the
   configured minimum;
5. replaces `aircraft_metadata` in one database transaction;
6. records source URL, validators, version/date, row count, and import time in
   `aircraft_metadata_import`.

An HTTP, decompression, parse, or validation failure rolls back the transaction.
The prior active metadata remains searchable, and the failure is exposed through
the status API and structured logs.

The source format is maintained outside this project and can change. Do not
lower the minimum row setting merely to make a failed import pass; first
inspect the file and parser expectations.

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
docker compose logs --since=15m app
```

Check the metadata card on the System page. An unchanged dataset after the
server returned `304` is a successful refresh check. To switch sources, update
the URL in Settings and run a manual refresh. Use only a source compatible with
the readsb/tar1090 CSV columns.

## Offline installations

Existing imported rows continue to work when the host has no outbound access.
Disable automatic metadata updates in Settings to avoid repeated failed checks.
A completely new offline installation starts with no registration/type/operator
enrichment until a compatible source is made reachable and a refresh succeeds.
