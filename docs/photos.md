# Aircraft photographs

Flightmap can show a photograph of the airframe on the aircraft profile. This is
the only feature in the application that fetches something from a third party at
runtime and stores what it sends back, so it is **off by default and stays off
until an operator configures a source**.

A default installation makes no outbound request to any photo host, ever. There
is no vendor named in the code and no URL shipped in the defaults.

## Choosing a source, and recording its terms

Set `aircraftPhotoSourceUrl` to a JSON endpoint that takes an ICAO hex address
and returns a photograph. `{icao}` in the URL is replaced with the lowercase
six-character address:

```text
https://example.test/api/photos/hex/{icao}
```

The adapter expects the shape the common public ICAO-hex photo APIs return: a
body carrying an image URL, a photographer credit, and a link back to the
photograph's page. It walks the response rather than indexing it, so a provider
that returns one object at the top level works as well as one that nests a
`photos` array. The keys it looks for are `thumbnail_large`, `thumbnail`,
`image` or `url` for the image; `photographer` or `credit`; and `link` or
`page`.

**This project cannot verify anyone's licence terms and does not try to.**
Photographs are usually licensed by the photographer rather than by the API, and
redisplaying and caching them may or may not be permitted. Before turning this
on, read the source's terms and record here what they are:

| | |
| --- | --- |
| Source | *not configured* |
| Terms reviewed on | — |
| Redisplay permitted | — |
| Caching permitted | — |
| Attribution required | — |

The credit and the link the source returns are stored alongside the image and
shown with it, which is what most terms require. If a source requires attribution
in a form the profile does not produce, do not enable it.

## What is stored, and why

The image itself is cached in PostgreSQL and served back from
`GET /api/v1/aircraft/:icao/photo`, on this server's own origin. The alternative
— storing the URL and letting each browser fetch it — was rejected for three
reasons:

- it puts **every viewer's browser** in touch with the third party on every
  view, rather than this server once per airframe;
- it shows nothing at all on a receiver with no internet access, even for a
  photograph that has already been seen;
- it rots on the upstream's schedule.

One row per ICAO address, holding the bytes, the content type and dimensions
read from those bytes, the credit, the link, and when it was fetched.

## How a fetch is triggered

Only by someone opening an aircraft profile for an airframe with no unexpired
row. Nothing is fetched on a receiver tick, nothing is joined into the live
snapshot, and the profile response never waits on a download — it reports what
is cached, queues the fetch, and returns. The image endpoint answers `404` until
the row lands, and the client picks the photograph up on the next view.

Fetches run one at a time behind a short queue. A burst of profile views is a
handful of upstream requests spread out, not a burst of them.

## What happens when the source misbehaves

Every failure ends as a cached row, because the alternative is re-asking upstream
forever for the airframes that fail most often.

| Upstream behaviour | Stored as | Retried after |
| --- | --- | --- |
| A photograph | `present` | `aircraftPhotoTtlDays` (30) |
| `404`, or a body with no image URL | `absent` | `aircraftPhotoNegativeTtlDays` (7) |
| An image over 200 kB | `absent` | 7 days |
| Bytes that are not JPEG, PNG or WebP | `absent` | 7 days |
| `5xx`, a timeout, an unreachable host | `failed` | 7 days |

The 200 kB per-image cap and the 10 second timeout are fixed in code rather than
exposed as settings, for the same reason the airport import's limits are: no
operator can judge a sensible byte cap, and the only thing a wrong one does is
turn a hostile or broken URL into a memory problem.

The content type is **sniffed from the bytes**, never trusted from the
`content-type` header. A photo API that has fallen over commonly answers `200`
with an HTML error page under an image content type; storing that would put a
broken image on the profile rather than nothing. SVG is rejected along with
everything else that is not one of the three types above — it is a script
container and has no business being served back from this origin.

## Storage and eviction

The cache is bounded by entry count as well as by age. `aircraftPhotoCacheEntries`
(2,000 by default) at the 200 kB cap is a 400 MB worst case, and a good deal
less in practice — a thumbnail from a photo API is tens of kilobytes. See
[disk sizing](disk-sizing.md).

The daily maintenance run deletes expired rows first, then deletes the
least-recently-served rows beyond the entry cap. "Served" means the bytes were
handed to a browser, so a photograph nobody looks at is the one that goes when
the cache is full. Both counts are recorded in `maintenance_log`.

## Offline receivers

Supported and unchanged. Nothing is fetched unless the feature is enabled, a
cached photograph still renders with no internet access, and an airframe without
one renders as an absent panel rather than as an error. An expired photograph is
still served — expiry decides when to re-ask upstream, not what may be shown —
so a receiver that loses its internet access goes on showing the photographs it
already has until maintenance drops them.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `aircraftPhotosEnabled` | `false` | Master switch. Nothing is fetched while this is off. |
| `aircraftPhotoSourceUrl` | `""` | JSON endpoint with `{icao}` substituted. Empty means off. |
| `aircraftPhotoTtlDays` | `30` | How long a photograph is kept before it is re-asked. |
| `aircraftPhotoNegativeTtlDays` | `7` | How long a miss or a failure is kept. |
| `aircraftPhotoCacheEntries` | `2000` | How many rows the cache may hold. |

These are server-managed: they are set through `PATCH /api/v1/settings` and have
no field on the Settings page yet.

## Turning it off

Set `aircraftPhotosEnabled` to `false`. Fetching stops immediately, including for
anything already queued. Cached photographs are still served — to stop that as
well, and to reclaim the space, drop the cache:

```sh
docker compose exec -T db psql -U flightmap -c 'TRUNCATE aircraft_photos'
```
