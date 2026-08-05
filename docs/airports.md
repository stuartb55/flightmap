# Airports and runways

The map can draw airports near the receiver, with runway centrelines at high
zoom, so a descending track converges on something visible instead of on empty
space.

The data is **built by an operator, never fetched at runtime**. Flightmap has no
runtime dependency on a third-party API in its default configuration, and this
does not introduce one: `npm run airports:build` reads local CSV files and
writes an application setting, in exactly the way `npm run metadata:refresh`
refreshes the aircraft registry.

A deployment that never runs the build has no airport data. That is a supported
state, not an error: the layer is not created, nothing is logged, and the
**Airports** toggle in the map layer menu is disabled with the reason shown.

## Source and licence

[OurAirports](https://ourairports.com/data/) — a public-domain community
database of airports and runways.

> "All of the data on this site is dedicated to the public domain."
> — <https://ourairports.com/data/>

The project asks for a credit, which the map gives: the airport GeoJSON source
carries an OurAirports attribution, so the credit appears in the map's
attribution control whenever the layer has data, and therefore in exported
snapshots too — the snapshot compositor reads its attribution from the rendered
control rather than from a constant.

No attribution is added when there is no airport data, because the source is
never created in that case.

The CSV exports are published at:

- <https://davidmegginson.github.io/ourairports-data/airports.csv>
- <https://davidmegginson.github.io/ourairports-data/runways.csv>

The build itself is offline — it only reads the files.

## Building the dataset

Fetch the two exports on any machine with internet access:

```sh
curl -sLO https://davidmegginson.github.io/ourairports-data/airports.csv
curl -sLO https://davidmegginson.github.io/ourairports-data/runways.csv
```

### In Docker, which is the normal deployment

The app container has a read-only root filesystem, so the CSV files are
bind-mounted into a throwaway container rather than copied in. Run this from the
directory holding `docker-compose.yml` and the two CSV files; `.env` already
supplies the database credentials.

```sh
docker compose run --rm --no-deps \
  -v "$PWD/airports.csv:/data/airports.csv:ro" \
  -v "$PWD/runways.csv:/data/runways.csv:ro" \
  app node apps/server/dist/airports-cli.js \
    --airports /data/airports.csv --runways /data/runways.csv

docker compose restart app
```

`--no-deps` keeps it from touching the running services; the database has to be
up already, which it normally is. The command prints a summary and reminds you
about the restart:

```json
{"airports":137,"runways":175,"byRank":{"large":23,"medium":74,"small":40},
 "payloadBytes":41940,"gzippedBytes":9278,"radiusNm":250,"written":true,
 "note":"Restart the application for a running instance to serve this"}
```

Add `--dry-run` to see that summary without writing anything. With `--latitude`
and `--longitude` given as well, a dry run needs no database at all, which makes
it a cheap way to try a radius or a runway threshold before committing to one.

### Outside Docker

For a checkout with `DATABASE_URL` pointing at the database:

```sh
npm run airports:build -- --airports ./airports.csv --runways ./runways.csv
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--airports PATH` | required | OurAirports `airports.csv` |
| `--runways PATH` | none | OurAirports `runways.csv`; without it there are no centrelines |
| `--latitude N` / `--longitude N` | receiver position | Centre of the radius |
| `--radius-nm N` | `250` | How far out to include |
| `--min-runway-ft N` | `3281` (1,000 m) | Length a *small* airport needs to qualify |
| `--dry-run` | off | Print the summary; write nothing |

The result is written to the `mapAirports` application setting, like
`mapWaypoints`. A deployment can replace or empty it through the settings API.

**Restart the application afterwards.** The build writes the settings row
directly, which is what lets it run while the application is stopped; a running
instance holds its settings in memory and keeps serving the previous dataset
until it restarts. The command says so in its output.

```sh
docker compose restart app
```

### What gets included

Radius alone is the wrong filter: it pulls in every grass strip, farm airfield
and private helipad in the area, which is noise on the map and most of the
payload. The rule is:

- **Large and medium airports** are kept unconditionally — those are where the
  traffic this receiver hears is actually going.
- **Small airports** are kept only if they have a runway of at least
  `--min-runway-ft`, so a licensed aerodrome qualifies and a farm strip does not.
- **Heliports, seaplane bases and closed airports** are always excluded.
- **Closed runways** are excluded from the centrelines, and a runway with no
  published threshold coordinates is skipped — the airport still appears, it
  just gets no centreline.

Each airport carries a rank (3 large, 2 medium, 1 small) which drives the label
collision order, so where two labels cannot both be drawn the major airport is
the one that survives.

### Determinism

The same input files and the same options produce byte-identical output. Airports
are sorted by ICAO, runways by ident, and every coordinate is rounded to six
decimal places (about 10 cm — far finer than a threshold is surveyed to). A
regenerated dataset is therefore a reviewable diff rather than a reshuffle, and
an unchanged rebuild does not invalidate anyone's cached copy.

## Delivery and size

The dataset is served from `GET /api/v1/airports`, not injected into the page.
The `flightmap-config` meta tag the server puts in `index.html` is URI-encoded
into every page load and into the page cache, which is fine for eleven waypoints
and wrong for a few thousand airport and runway records.

The endpoint carries a strong `ETag` over the response body and
`cache-control: public, max-age=300, must-revalidate`. The ETag does the work:
the body crosses the wire once and every later request is conditional, answered
with `304` and no body. The service worker adds a `StaleWhileRevalidate` runtime
cache, so after the first load the layer paints from cache — including on a
receiver with no internet access — while that revalidation happens behind it.

The max-age is five minutes rather than a day on purpose. The URL carries no
content hash, so a long max-age would leave an operator who had just rebuilt the
dataset staring at the old one until tomorrow; a conditional request every few
minutes costs a few hundred bytes and nobody waits for it.

### Reference deployment

Measured for the reference receiver (53.61, −2.31, near Manchester) against the
OurAirports export of 5 August 2026, at the default 250 nm radius and 1,000 m
runway threshold:

| | |
| --- | --- |
| Airports | 137 (23 large, 74 medium, 40 small) |
| Runway centrelines | 175 |
| **Response body, as sent** | **41,940 bytes** |
| Gzipped, for comparison | 9,278 bytes |

Flightmap does not compress API responses — it serves one trusted LAN, where the
CPU is worth more than the bytes — so 41,940 bytes is what actually crosses the
wire, once. The plan's working budget was 250 kB gzipped; this is comfortably
inside it uncompressed, and about 3.7% of it if a reverse proxy in front of the
app does compress. The gzipped figure is the one the build command reports, so
the two can be compared directly.

Runway centrelines are a small enough share of that to be worth including in the
same fetch rather than gated behind a second, higher-zoom request. A test
asserts the response stays inside the budget.

## Rendering

Three layers, all inserted below the traffic so an aircraft is never hidden
behind ground context:

| Layer | From zoom | What it draws |
| --- | --- | --- |
| `airport-runways` | 11 | Centrelines. Below this a runway is a hairline and says nothing. |
| `airport-markers` | 7 | A circle per airport. |
| `airport-labels` | 7.5 | IATA code where there is one, else ICAO. |

Labels use `text-allow-overlap: false` with `symbol-sort-key` set from the rank,
so they declutter rather than overprint, and a collision is resolved in favour of
the larger airport.

These are display-only reference points. **They are not intended for
navigation.**
