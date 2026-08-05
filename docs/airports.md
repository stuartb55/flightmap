# Airports and runways

The map can draw airports near the receiver, with runway centrelines at high
zoom, so a descending track converges on something visible instead of on empty
space.

The dataset is **built when an operator asks for it, never while the map
renders**. That is the same arrangement as the aircraft registry: a source is
configured in Settings, the server downloads and validates it on request, and
the result is stored as an application setting. The map layer reads the stored
result from `GET /api/v1/airports` and never reaches outside.

A deployment that has never downloaded it has no airport data. That is a
supported state, not an error: the layer is not created, nothing is logged, and
the **Airports** toggle in the map layer menu is disabled with the reason
shown.

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

Download them on a machine with internet access; the build itself is offline.

## Building the dataset

### From the Settings page

**Settings → Airports → Download now.** The server fetches both OurAirports
files, keeps what is in range, and applies the result to itself — the map has
the new airports immediately, with no restart and nothing to run on a command
line.

The card shows what is on the map now and when it was last downloaded, and
reports what each download produced or why it failed. Four things are
configurable there, and saved with the rest of the settings:

| Field | Default | Meaning |
| --- | --- | --- |
| Radius | 250 nm | How far from the receiver to include |
| Smallest runway to include | 3,281 ft (1,000 m) | What a *small* airfield needs to qualify |
| Airports file | OurAirports `airports.csv` | Where the airport list comes from |
| Runways file | OurAirports `runways.csv` | Where the centrelines come from |

The centre of the radius is the receiver position: the Settings override if one
is set, otherwise the position the receiver advertises in `receiver.json`. If
neither is known the download stops and says so rather than guessing.

Downloading needs internet access **on the server**. The download itself is
bounded — 60 seconds and 64 MB per file, fixed rather than configurable, because
those are limits rather than choices — and a file too small to be an OurAirports
export is rejected. Every failure leaves the existing dataset alone: a map still
showing yesterday's airports is a better answer than one that has lost them.

### Without internet access on the server

A receiver with no route to the internet can still have airports, by carrying
the files in and running the CLI. This is the only reason the CLI exists.

```sh
curl -sLO https://davidmegginson.github.io/ourairports-data/airports.csv
curl -sLO https://davidmegginson.github.io/ourairports-data/runways.csv
```

Against a Compose deployment — the app container's root filesystem is read-only,
so the files are bind-mounted rather than copied in:

```sh
docker compose run --rm --no-deps \
  -v "$PWD/airports.csv:/data/airports.csv:ro" \
  -v "$PWD/runways.csv:/data/runways.csv:ro" \
  app node apps/server/dist/airports-cli.js \
    --airports /data/airports.csv --runways /data/runways.csv

docker compose restart app
```

Or, from a checkout with `DATABASE_URL` set:

```sh
npm run airports:build -- --airports ./airports.csv --runways ./runways.csv
```

**The restart is only needed for this path.** The CLI writes the settings row
directly, which is what lets it run while the application is stopped, so a
running instance keeps serving the previous dataset until it reloads. The
Settings page has no such problem, because the running server does the work.

| Option | Default | Meaning |
| --- | --- | --- |
| `--airports PATH` | required | OurAirports `airports.csv` |
| `--runways PATH` | none | OurAirports `runways.csv`; without it there are no centrelines |
| `--latitude N` / `--longitude N` | receiver position | Centre of the radius |
| `--radius-nm N` | `250` | How far out to include |
| `--min-runway-ft N` | `3281` (1,000 m) | Length a *small* airport needs to qualify |
| `--dry-run` | off | Print the summary; write nothing |

With `--dry-run` and an explicit centre the CLI needs no database at all, which
makes it a cheap way to try a radius before committing to one.

Both paths share the same selection code, so they produce identical datasets
from identical inputs.

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
