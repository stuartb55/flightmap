# Flightmap — User Experience Enhancement Plan

Prioritised backlog of user-facing improvements for the delivered v1 application.
Authentication and security work is deliberately out of scope; the deployment
model (trusted LAN, reverse proxy for remote access) is unchanged.

Phases 1 and 2 — tiers 0 and 1 (items 1–12) and the first seven items of tier 2
(22, 15, 16, 13, 23, 25, 17) — are complete and have moved to
[`docs/delivered-enhancements.md`](docs/delivered-enhancements.md). The original
v1 build specification is [`docs/v1-build-plan.md`](docs/v1-build-plan.md) and
remains the reference for existing behaviour.

Phase 3 is what is left: three tier-2 items and two tier-3 bets.

## How to use this document

Each item is self-contained and independently shippable. Work top to bottom
within a tier; tiers are ordered by value per unit of effort. Tick the checkbox
when the acceptance criteria pass and `npm run typecheck && npm run lint && npm run test`
is clean.

Effort key: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

Item numbers are stable identifiers used in branch names and pull request
titles. Numbers 8, 11, and 19 belonged to items dropped before implementation
(notifications, onboarding, multi-receiver) and are not reused.

File and line references were re-checked against `5157db3` when phase 3 was
written. Lines drift; treat them as a pointer to the right place, not a
contract.

---

## Tier 2 — Depth and polish

The remainder of tier 2, elaborated for phase 3. Item 18 is self-contained web
work; items 14 and 24 both add data to server paths and each deserves its own
release.

---

### 14. Airport and runway layer — **M**

- [ ] Implement

**Problem.** The map shows configurable arrival and departure fixes
(`apps/server/src/default-waypoints.ts`, `apps/web/src/components/waypoints.ts`)
but no airports, so tracks converge on nothing visible and a descending approach
has no context.

**Approach.** Three decisions carry this item.

*Build time, never runtime.* A new CLI beside `metadata-cli.ts` reads an
OurAirports CSV export (`airports.csv`, `runways.csv`) from a local path or a
configured URL, filters to a radius of the receiver, and writes the result. It
runs when an operator asks it to, exactly like `npm run metadata:refresh` does
today, and the app never fetches airport data at runtime. Add
`npm run airports:build` alongside the existing script. The CLI must be
deterministic: same input files and radius, byte-identical output, so a
regenerated dataset produces a reviewable diff.

*Delivered as an endpoint, not as page config.* `mapWaypoints` reaches the
client inside the `flightmap-config` meta tag that the server injects into
`index.html` (`app.ts:249`), URI-encoded. That is fine for 11 waypoints and
wrong for a few thousand airport and runway records: it would land in every page
load and in the page cache. Serve the dataset from a new
`GET /api/v1/airports` with a strong `ETag` and a long `max-age`, add a
`StaleWhileRevalidate` runtime cache entry for it in `vite.config.ts`, and let
the layer render empty until the response arrives. The settings row stays the
source of truth so a deployment can replace or empty it, as with `mapWaypoints`.

*Storage shape.* A `mapAirports` application setting following `mapWaypoints`
(`settings.ts:55`, `:126`) — an array validated by a new `airportSchema` in
`packages/shared/src/contracts.ts` carrying ICAO/IATA, name, position, elevation,
a size or importance rank for label priority, and a runway list of ident plus
threshold coordinates. Ship the default empty rather than bundling the reference
deployment's airports into the repository; the CLI populates it. A deployment
that never runs the CLI sees no layer and no error.

*Rendering.* A new `airports` GeoJSON source and three layers in `RadarMap.tsx`,
inserted below the aircraft symbol layers so traffic always wins:

- runway centrelines (line) above roughly zoom 11;
- airport symbols from mid zoom;
- airport labels with `text-allow-overlap: false` and a `symbol-sort-key` driven
  by the importance rank, so when two labels collide the major airport survives
  rather than whichever sorted first.

The layer toggle is a new `airports` key on `mapLayerPreferencesSchema`
(`contracts.ts:388`). That object is `.strict()`, so the key must carry
`.default(false)` for the same reason `allTrails` does (`contracts.ts:397`):
every saved view and every stored preference written before this item must still
parse. Add it to `defaultMapLayers` (`map-preferences.ts:10`) and to the
`MapLayerMenu` options list (`MapLayerMenu.tsx:5`).

*Attribution.* OurAirports data is dedicated to the public domain; record the
source, the export date, and the licence claim in a new `docs/airports.md`, and
add a credit to the map attribution string (`RadarMap.tsx:840`). The snapshot
compositor reads its attribution from the rendered control
(`RadarMap.tsx:836`–`:842`), so exported PNGs pick the credit up with no extra
work — verify that rather than assume it.

**Files.** New `apps/server/src/airports-cli.ts`, new
`apps/server/src/default-airports.ts` (empty default plus the type),
`apps/server/src/settings.ts`, `apps/server/src/routes/api.ts`,
`packages/shared/src/contracts.ts`, new `apps/web/src/components/airports.ts`
(GeoJSON assembly, mirroring `waypoints.ts`), `RadarMap.tsx`,
`MapLayerMenu.tsx`, `apps/web/src/lib/map-preferences.ts`,
`apps/web/vite.config.ts`, `package.json` (script), new `docs/airports.md`.

**Acceptance.**
- The layer toggles alongside the others, persists, and is captured in saved
  views; a saved view written before this item still parses.
- The payload stays within a stated budget — 250 kB gzipped for a 250 nm radius
  is the working target. Document the actual figure for the reference deployment
  in `docs/airports.md`, and assert the endpoint's response size in a test.
- The dataset is fetched once and served from cache on subsequent loads; the
  index.html config blob is unchanged in size.
- Labels declutter: no overlapping airport labels at any zoom, on either theme,
  and the major airport wins a collision against a nearby airfield.
- The source and licence are documented and appear in the map attribution and in
  an exported snapshot.
- A deployment with no airport data renders no layer, logs nothing, and shows no
  error; the layer toggle is either hidden or disabled with an explanation.
- The CLI runs offline against local CSV files and produces identical output on
  a second run.

**Open questions to settle before starting.**
- Radius, or a bounding box, or "airports with a runway over N metres" — radius
  alone pulls in a lot of grass strips.
- Whether runway data justifies its share of the budget at all, or whether
  centrelines should be a separate, higher zoom-gated fetch.

---

### 24. New-to-this-receiver sightings — **M**

- [ ] Implement

**Problem.** `aircraft_summary.first_seen_at` is the canonical record of when
this receiver first heard each airframe (`001_initial.sql:138`), retained
indefinitely, and nothing in the live UI uses it. Seeing an airframe for the
first time is the moment most worth noticing, and today you cannot tell.

Note the history: a first-seen *alert* existed and was deliberately removed as
noise in migration `009_focused_alerts.sql` ("a new ICAO address is routine
receiver history, not an event requiring attention"). That judgement stands.
This item is the passive alternative — a marker you can go looking for, never a
notification, never an `alert_events` row.

**Approach.** The plumbing is half built already, which shrinks the server side
of this item and pins down exactly where the edits go:

- `Aircraft.firstSeenAt` already exists on the client type (`types.ts:70`);
- the detail adapter populates it from the summary (`adapters.ts:230`), and
  `AircraftDetailPanel.tsx:418` already prefers `summary?.firstSeenAt ??
  aircraft.firstSeenAt`;
- the live adapter hardcodes `firstSeenAt: null` (`adapters.ts:82`) because the
  live payload does not carry it.

So: add one more `LEFT JOIN aircraft_summary` to the snapshot query
(`live-repository.ts:57` already joins `watchlist`, `alert_events`, and
`aircraft_metadata` in a single statement, so this costs a join, not a round
trip), add `firstSeenAt` to `liveAircraftSchema` (`contracts.ts:44`–`:87`) as a
nullable ISO timestamp, and replace the hardcoded `null` in the live adapter.

*Why the client derives "new", not the server.* `LiveAircraftDiff` suppresses
rows whose `JSON.stringify` is byte-identical to the previous tick
(`aircraft-diff.ts:16`). A static `firstSeenAt` rides along on rows already being
sent and changes nothing; a server-computed `isNew`, or anything relative to
`now`, would flip and push otherwise-unchanged rows onto the wire every second.
Cover this with a diff test that runs two identical snapshots carrying
`firstSeenAt` and asserts the second yields no rows.

*Threshold preference.* Off / since this session started / last 24 hours / last
7 days, defaulting to *since this session started*. Store it in a new
`apps/web/src/lib/sighting-preferences.ts` following the `unit-preferences.ts`
pattern, and fail safe on corrupt storage. "Since this session started" needs an
anchor that survives a reload but not a new tab-session: write the timestamp to
`sessionStorage` on first mount and read it from there.

*Filter.* Add `newOnly: boolean` to `AircraftFilters`
(`aircraft-filter.ts:16`) and `defaultAircraftFilters`. The trap: the live saved
view schema mirrors that object and is `.strict()`
(`contracts.ts:457`–`:471`), so the new key must be added there with
`.default(false)` or every previously saved live view fails to parse. Add a
regression test that parses a saved-view payload without the key.

*Surfaces.* A short text badge ("NEW") in the table's aircraft cell and in the
detail panel, the filter above, and an optional map emphasis. Emphasis
precedence where an aircraft is more than one thing: emergency, then alert, then
watchlist, then new — new sightings must never mask an alert. No sound, no nav
badge, no alert feed entry.

**Files.** `apps/server/src/db/live-repository.ts`,
`packages/shared/src/contracts.ts`, `apps/web/src/lib/adapters.ts`,
`apps/web/src/lib/aircraft-filter.ts`, new
`apps/web/src/lib/sighting-preferences.ts`, `AircraftTable.tsx`,
`AircraftFilters.tsx`, `AircraftDetailPanel.tsx`, `RadarMap.tsx` (map emphasis),
`SettingsPage.tsx` (threshold control), `styles/live.css`.

**Acceptance.**
- The added join does not measurably slow the 1 Hz snapshot at 1,000 aircraft —
  asserted against the existing load smoke (`npm run test:load`).
- The delta payload is unchanged in size and frequency for aircraft whose
  telemetry has not changed, asserted by the `LiveAircraftDiff` test above.
- An aircraft with no summary row renders as unknown (`—`), never as "new".
- A live saved view written before this item still parses, and the filter round
  trips through save and apply.
- No `alert_events` row is written under any circumstance, and the alert rule
  constraint from migration 009 is untouched.
- The badge meets AA contrast in both themes, is not conveyed by colour alone,
  and is announced by a screen reader as part of the aircraft's row label.
- An aircraft that is both new and alerting shows the alert emphasis on the map.

---

## Tier 3 — Larger bets

Worth doing, but each is a project rather than a feature. Neither should start
until it has been scoped into numbered items of its own; the notes below are the
input to that scoping, not a specification.

### 20. Aircraft photographs — **M**

The single most-requested feature in comparable apps, and the one that breaks the
offline-first rule: it requires a runtime external API. Every other data source
in the app is either local or refreshed by an operator-run CLI.

If pursued: explicitly opt-in and off by default, cached aggressively in
PostgreSQL (image bytes or a URL plus an expiry, not a fetch per view), silently
degraded when the fetch fails or the host is offline, and stated plainly in
Settings that enabling it sends ICAO addresses to a third party.

**Scope before starting.**
- Which source, and on what licence terms for redisplay and for caching. This is
  the decision the whole item turns on; a source whose terms forbid caching makes
  the feature incompatible with the deployment model.
- Storage budget and eviction — `docs/disk-sizing.md` sets the expectations this
  would change.
- Where a photograph appears: the aircraft profile only, or the detail panel too.
  The panel is on the 1 Hz path and is the riskier answer.
- Behaviour on a receiver with no internet access, which is a supported
  configuration today.

### 21. Route inference — **L**

Origin/destination is not in the ADS-B payload and cannot be derived from the
receiver alone. Deriving probable routes from observed track geometry and
repeated callsign patterns against the local history is feasible and stays
offline, but it is a modelling exercise with an accuracy contract to define
before any UI is drawn.

**Scope before starting.**
- The accuracy contract: what confidence is shown, how it is computed, and what
  the UI does with a low-confidence answer. A guess presented as fact is worse
  than nothing here.
- Whether item 14's airport dataset is a prerequisite — inferring "arriving at
  EGCC" needs to know EGCC exists and where its runways point. It probably is.
- Where inference runs: a scheduled job over closed sessions, not the live path.
- How it is evaluated. Without a labelled sample there is no way to tell whether
  a change helped, and the receiver's own history is the only sample available.

---

## Explicitly not planned

- Authentication, user accounts, and per-user permissions — deployment model
  unchanged, and out of scope by request.
- External notification transports (email, push services, Discord, webhooks).
- Public/internet-facing hosting affordances.
- Any runtime dependency on a third-party API in the default configuration.
- Notifications, including any revival of first-seen alerting (migration
  `009_focused_alerts.sql`). Item 24 is passive marking, not alerting.

---

## Suggested sequencing

Phase 3, in order:

1. **Item 18 — in-app help.** Self-contained web work, no migration, no server
   data path. It documents everything phases 1 and 2 shipped, so doing it first
   means the glossary is written while that work is still fresh.
2. **Item 24 — new sightings.** One join, one schema field, and a client-side
   derivation. Smaller than item 14 and shares no files with it, so the two can
   run in either order or in parallel if that suits.
3. **Item 14 — airport layer.** The largest remaining item, and a prerequisite
   for item 21 if that bet is ever taken. It adds a new data pipeline, so give it
   its own release and update `docs/operations.md` with the CLI.

Then stop and decide whether tier 3 is wanted at all. Both items trade away a
property the app currently holds — offline-first for item 20, "everything shown
is observed" for item 21 — and that is a product decision, not a scheduling one.

## Cross-cutting requirements

Every item inherits the standards the v1 build already meets, and regressions
against them block a merge:

- Keyboard operable, visible focus, correct ARIA, and `prefers-reduced-motion`
  respected. The `@axe-core/playwright` e2e pass must stay clean in both themes.
- Every chart has a keyboard-reachable table of its values, through the shared
  `ChartDataTable` component. This is true today; keep it true.
- Internal navigation uses the router, never a document load — enforced by the
  `no-restricted-syntax` rules in `eslint.config.mjs` and the
  `router-lint.test.ts` sweep.
- Desktop and mobile layouts both covered — the mobile bottom-sheet pattern in
  `LivePage.tsx` is the reference.
- Both themes checked, including any colour that carries meaning.
- All displayed measurements route through the `format.ts` helpers so unit
  preferences and the display time zone apply; exports stay in ft/kt/nm and say
  so.
- Unavailable values render as `—`, never as `0`, `null`, or `NaN`.
- New preferences fail safe: corrupt or absent storage falls back to defaults
  without blocking live data (see `storedFilters`, `LivePage.tsx:50`).
- Any addition to a `.strict()` shared schema carries a default, so saved views
  and stored preferences written before it still parse (`allTrails`,
  `contracts.ts:397`, is the precedent).
- Unit and component tests alongside the change; e2e coverage for anything that
  alters a primary user flow.
- `npm run typecheck`, `npm run lint`, `npm run test:coverage`, and
  `npm run build` all pass.
