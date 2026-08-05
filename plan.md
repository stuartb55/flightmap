# Flightmap — User Experience Enhancement Plan

Prioritised backlog of user-facing improvements for the delivered v1 application.
Authentication and security work is deliberately out of scope; the deployment
model (trusted LAN, reverse proxy for remote access) is unchanged.

Phase 1 — tiers 0 and 1, items 1–12 — is complete and has moved to
[`docs/delivered-enhancements.md`](docs/delivered-enhancements.md). The original
v1 build specification is [`docs/v1-build-plan.md`](docs/v1-build-plan.md) and
remains the reference for existing behaviour.

## How to use this document

Each item is self-contained and independently shippable. Work top to bottom
within a tier; tiers are ordered by value per unit of effort. Tick the checkbox
when the acceptance criteria pass and `npm run typecheck && npm run lint && npm run test`
is clean.

Effort key: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

Item numbers are stable identifiers used in branch names and pull request
titles. Numbers 8, 11, and 19 belonged to items dropped before implementation
(notifications, onboarding, multi-receiver) and are not reused.

---

## Tier 2 — Depth and polish

Phase 2. Items 22–25 are new, added now that phase 1 has landed and the gaps it
exposed are visible.

### 22. In-app navigation without full page reloads — **S**

- [x] Implement

**Problem.** Three internal links bypass the client router and reload the whole
document:

1. `InsightsPage.tsx:571` — the activity chart drill-through assigns
   `window.location.href`.
2. `InsightsPage.tsx:302` — `LeaderList` renders a raw `<a href="/aircraft/…">`
   / `<a href="/history?…">`.
3. `InsightsPage.tsx:627` — the coverage cell aircraft links do the same.

Each one tears down the SPA, drops the live WebSocket (`LiveContext.tsx:80`),
and refetches the bundle, so a drill-down costs a cold start. The router
already exports `Link` and `navigate` (`apps/web/src/lib/router.tsx`), and
`RadarMap`'s popup links use them correctly — this is drift, not a design
choice. Item 17 adds more drill-downs, so fix the pattern first.

**Approach.** Replace internal anchors with `Link` and programmatic navigation
with `navigate()`. `Link` already stands aside for modifier and middle clicks
and for `target="_blank"` (`router.tsx:69`), so opening in a new tab keeps
working. Leave the download anchors alone — `exportHref` targets
(`InsightsPage.tsx:464`) and the session exports (`HistoryPage.tsx:1029`) are
server responses, not routes, and must stay plain anchors with `download`.

Add an ESLint `no-restricted-syntax` rule for `apps/web/src` covering
`window.location.href =` assignment and `JSXAttribute[name.name='href']` with a
string literal starting `/` and no `download` sibling, so the pattern cannot
silently return.

**Files.** `InsightsPage.tsx`, `eslint.config.mjs`, plus any anchor the sweep
turns up.

**Acceptance.**
- No internal link causes a document navigation; an e2e test asserts the live
  connection survives a chart drill-through.
- Lint fails on a reintroduced raw internal anchor, and the rule's message names
  the replacement.
- Modifier-click, middle-click, and "open in new tab" still work on every
  converted link.
- Download anchors are unaffected and still carry `download`.

---

### 15. Saved views: defaults and pinning — **S**

- [x] Implement

**Problem.** Saved views exist for Live, History, and Insights
(`SavedViewsControl.tsx`) but every visit starts from the built-in default, and
reaching a view takes two clicks through a menu that hides behind a popover. A
user with one habitual configuration re-applies it every session.

**Approach.** Add two fields to `saved_views`: `is_default boolean` and
`pinned_at timestamptz`. Enforce the invariants in the database — a partial
unique index on `(surface) WHERE is_default`, and the "at most three pins per
surface" cap in the same advisory-locked transaction that already enforces the
20-view limit (`saved-views-repository.ts:29`). New migration `014`.

Extend `savedViewSchema` (`contracts.ts:550`) and `savedViewPatchSchema`
(`contracts.ts:581`). On the client, each surface applies its default on mount
unless the URL already carries explicit parameters; pinned views render as
chips beside the Saved views button and are registered as commands
(`lib/app-commands.ts`).

**Files.** New `apps/server/src/db/migrations/014_saved_view_defaults.sql`,
`saved-views-repository.ts`, `routes/api.ts`, `packages/shared/src/contracts.ts`,
`SavedViewsControl.tsx`, `LivePage.tsx`, `HistoryPage.tsx`, `InsightsPage.tsx`,
`lib/app-commands.ts`.

**Acceptance.**
- The default applies before the surface's first data fetch, so there is no
  visible flash of the built-in state.
- A URL with explicit parameters always wins over the default.
- Setting a new default clears the previous one atomically; concurrent requests
  cannot leave two defaults on one surface.
- The fourth pin on a surface is refused with a message naming the limit, not a
  generic error.
- Pinned chips are keyboard reachable, appear in the command palette, and are
  labelled as pinned to a screen reader.

---

### 16. Map snapshot and share — **S**

- [x] Implement

**Problem.** The URL already describes the view on Live and History, but nothing
in the UI says so, and there is no way to save a picture of what the map is
showing — the thing people actually want to send to someone.

**Approach.** Two buttons in the existing `.map-controls` cluster
(`RadarMap.tsx:1340`).

*Copy link* writes the current viewport into the URL on demand — `getViewport()`
is already exposed through the imperative handle (`RadarMap.tsx:748`) — then
copies it. Writing the viewport on demand rather than continuously keeps the
history stack clean.

*Download image* is not a one-liner: the map is constructed without
`preserveDrawingBuffer` (`RadarMap.tsx:755`), so `canvas.toDataURL()` returns
blank. Prefer forcing a synchronous redraw and reading inside a
`map.once('render')` callback over enabling the flag permanently; if the flag
proves necessary, measure it against the load smoke before keeping it. Compose
the result onto a 2D canvas with a caption strip: receiver name, timestamp in
the display time zone, aircraft count, and the attribution text the compact
`AttributionControl` shows (`RadarMap.tsx:775`).

**Files.** `RadarMap.tsx`, new `apps/web/src/lib/map-snapshot.ts` (also used by
item 17), `LivePage.tsx`, `HistoryPage.tsx`, `styles/live.css`.

**Acceptance.**
- The copied link restores an identical view — viewport, filters, selection, and
  replay position where applicable.
- The PNG carries the tile provider attribution (OpenFreeMap, OpenMapTiles,
  OpenStreetMap) legibly at the exported size.
- Frame cost is unchanged when no snapshot is being taken; if
  `preserveDrawingBuffer` is enabled, the load smoke shows under 5% regression.
- Copy reports success and failure through an `aria-live` region, and falls back
  to a selectable read-only input where the clipboard API is unavailable — a
  non-secure-context LAN deployment is the normal case, not an edge case.

---

### 13. Multi-track profile comparison — **S**

- [x] Implement

**Problem.** Up to eight tracks can be selected and drawn on the History map
(`HistoryPage.tsx:518`), but `FlightProfile` renders only the focused one
(`HistoryPage.tsx:1046`). Comparing two approaches to the same runway means
clicking *Profile* back and forth (`HistoryPage.tsx:1028`) and holding the shape
in your head.

**Approach.** Take `tracks: TrackResponse[]` plus the focused id instead of a
single track. Two x-axis modes: absolute time (default, matching
`SessionTimeline`) and *align on start*, which is what makes approach profiles
comparable. Cap the overlay at four series — beyond that the chart stops
answering the question — and offer the rest through the existing focus control.

Colour has to change meaning when comparing: the per-point ramp
(`track-colour.ts`) is unreadable across four overlaid lines, so in comparison
mode each series takes its map line's identity colour and the ramp is retained
only for the single-track case. The focused series draws last, at full width;
the others sit at reduced opacity.

**Files.** `FlightProfile.tsx`, `HistoryPage.tsx`, `lib/track-colour.ts`
(per-track identity colours, shared with the map and `SessionTimeline.tsx`),
`styles/history.css`.

**Acceptance.**
- Four overlaid tracks stay legible in both themes and are distinguishable
  without relying on colour alone — a dash pattern or an inline series label.
- The accessible data table added under the chart (item 23) lists every series.
- Single-track rendering, including the per-point colour ramp, is unchanged.
- Axis mode is captured in the URL and in saved views.
- The shared crosshair reports the focused series' values; scrubbing still
  drives replay for all selected tracks.

---

### 23. Chart accessibility and data-table parity — **S**

- [x] Implement

**Problem.** Insights sets the pattern — every chart has a keyboard-reachable
`details.chart-data-table` fallback (`InsightsPage.tsx:173`, `:608`). Four charts
never adopted it:

- the flight profile (`FlightProfile.tsx:158`) — `role="img"` with one label;
- the range profile (`RangeProfile.tsx:22`) — same;
- the activity pattern grid (`ActivityPattern.tsx:24`) — per-cell labels, no
  table, and the percentage-change annotation lives only in a `title`;
- the aircraft profile activity bars (`AircraftProfilePage.tsx:25`) — `title`
  attributes only, which a keyboard user never reaches.

The cross-cutting requirements demand this, so it is a standing regression
rather than a new feature.

**Approach.** Extract the existing markup into a shared `ChartDataTable` taking
a caption, columns, rows, and an optional row cap, then adopt it in Insights
(no visual change) and in the four charts above. Values format through the
existing helpers so unit preferences apply automatically. Replace
`title`-only tooltips with content that is also reachable by keyboard.

**Files.** New `apps/web/src/components/ChartDataTable.tsx`, `InsightsPage.tsx`,
`FlightProfile.tsx`, `RangeProfile.tsx`, `ActivityPattern.tsx`,
`AircraftProfilePage.tsx`, `styles/insights.css`.

**Acceptance.**
- Every chart in the app has a keyboard-reachable table of the values it plots.
- Tables honour unit preferences and render unavailable values as `—`.
- Capped tables state the cap, as the coverage table already does at 50 rows.
- The `@axe-core/playwright` pass stays clean on Insights, History, and the
  aircraft profile, in both themes.

---

### 25. Receiver records — **S**

- [x] Implement

**Problem.** Insights reports maxima for the selected range only. The receiver's
all-time records — farthest contact, highest, closest approach, busiest day,
longest session, most-observed airframe — are the numbers a hobbyist actually
shows people, and they already exist in aggregates that are retained
indefinitely (`aircraft_summary`, `daily_aircraft_summary`,
`daily_range_histogram`, `daily_coverage_cells`) long after detailed tracks
expire. Nothing surfaces them.

**Approach.** One endpoint, `GET /api/v1/insights/records`, returning a small
fixed set of records, each with the ICAO and timestamp behind it so it can link
onward. Render as a compact panel at the top of Insights, above the date range
controls, explicitly labelled as all-time and range-independent — otherwise it
reads as a bug when the numbers do not move with the date picker.

Every figure must come from an indexed aggregate; nothing here may scan
`position_samples`.

**Files.** `apps/server/src/db/insights-repository.ts`,
`apps/server/src/routes/api.ts`, `packages/shared/src/contracts.ts`,
`apps/web/src/lib/api.ts`, `InsightsPage.tsx`, `styles/insights.css`.

**Acceptance.**
- The records query stays under 100 ms against a year of aggregates and is
  index-backed — verified with `EXPLAIN` in the repository test.
- Each record links to the aircraft profile, and to History when the session is
  still within detailed retention; records whose track has expired still show,
  with the link degraded to the profile.
- A receiver with no data yet shows an explained empty state, not a row of
  zeros.
- Figures follow unit preferences and the display time zone.

---

### 17. Insights drill-down and export polish — **S**

- [ ] Implement

**Problem.** The activity chart drills through to History
(`InsightsPage.tsx:571`) and the leader lists link out (`:302`), but the range
profile (`RangeProfile.tsx`) and the pattern grid (`ActivityPattern.tsx`) are
dead ends, the activity chart has no per-series show/hide (reports, positioned
reports, and availability are drawn unconditionally), and export is CSV and
GeoJSON only.

**Approach.**
- *Pattern grid cell → History*: filter to that weekday-hour across the current
  range. `sessionQuerySchema` (`contracts.ts:857`) already carries `from`/`to`,
  so this needs either repeated ranges in the query or a new weekday-hour
  parameter — prefer the parameter, and back it with the existing start-time
  index.
- *Range sector → coverage, not History*: the sector data comes from
  `daily_range_histogram`, which is aggregated and cannot name the sessions it
  counted. Land the sector drill-down on the coverage map filtered to that
  bearing wedge instead of inventing a History query that would return a
  different set from the one the chart shows. Say this in the UI copy.
- *Per-series toggles* on the activity chart, persisted with the other insights
  preferences and captured in the saved view configuration.
- *Chart image export* reusing the compositor from item 16: serialise the SVG to
  a canvas, caption it with the receiver name and range.

**Files.** `InsightsPage.tsx`, `ActivityPattern.tsx`, `RangeProfile.tsx`,
`lib/map-snapshot.ts`, `HistoryPage.tsx`, `packages/shared/src/contracts.ts`,
`apps/server/src/db/history-repository.ts`, `apps/server/src/routes/api.ts`.

**Acceptance.**
- Every drill-down lands on a query that returns exactly the population the
  chart element counted — asserted against a seeded dataset, not checked by eye.
  Where that is not possible, the drill-down goes somewhere it *is* true and the
  UI says what it is showing.
- Series visibility persists across reloads and is captured in saved views.
- Exported chart PNGs are legible in both themes and carry the range and
  receiver name.
- Drill-downs navigate without a document reload (item 22).

---

### 18. In-app help — **S**

- [ ] Implement

**Problem.** Operational documentation lives in `docs/` and the README,
reachable only from the repository. Meanwhile the UI shows terms it never
explains: NIC / NACp / NACv / SIL (`AircraftDetailPanel.tsx:251`), the ADS-B
versus MLAT source (`:248`), emitter category, the retention model, and
"detailed track expired". The shortcut list exists only inside the `?` dialog
(`KeyboardShortcuts.tsx:24`).

**Approach.** A `/help` route added to the known paths (`App.tsx:46`), reachable
from the nav and from the `?` dialog. Sections: keyboard shortcuts, field
glossary, retention and what expiry means, unit and export conventions, and map
data provenance. Render the shortcut table from the same exported array the
dialog uses, so the two cannot drift.

The page must work offline from the PWA shell — it is exactly the page someone
opens when something is not working. Check it against the workbox
`globPatterns` in `vite.config.ts:71`.

**Files.** New `apps/web/src/pages/HelpPage.tsx`, `App.tsx`, `AppShell.tsx`,
`KeyboardShortcuts.tsx` (export the shortcut list), `vite.config.ts` if
precaching needs adjusting, cross-links from `docs/operations.md`.

**Acceptance.**
- Every jargon term rendered in the detail panel and the map legend appears in
  the glossary — asserted by a test that walks the panel's `<dt>` labels rather
  than by a hand-maintained list.
- The page loads with the network disabled after one visit.
- The shortcut table and the `?` dialog are generated from one source.
- Nav placement does not push the primary nav into overflow on a phone.

---

### 14. Airport and runway layer — **M**

- [ ] Implement

**Problem.** The map shows configurable arrival and departure fixes
(`apps/server/src/default-waypoints.ts`, `apps/web/src/components/waypoints.ts`)
but no airports, so tracks converge on nothing visible and a descending approach
has no context.

**Approach.** Bundle a small dataset — ICAO/IATA, name, position, elevation,
runway idents and thresholds — filtered to a configurable radius of the
receiver. Generate it at import time through a CLI beside the existing
`metadata-cli.ts`, never at runtime: this keeps the offline-first rule the
metadata pipeline already follows (`docs/metadata.md`). OurAirports is the
obvious source (public domain); record the choice and its licence in `docs/`.

Ship it as an application setting in the same shape as `mapWaypoints`, so a
deployment can replace or empty it. Render as a toggleable layer in the layer
menu (`MapLayerMenu.tsx:5`): airport symbol and label from mid zoom, runway
centrelines above a higher threshold.

**Files.** New `apps/server/src/airports-cli.ts` (or an extension of
`metadata-cli.ts`), `apps/server/src/settings.ts`,
`packages/shared/src/contracts.ts`, `apps/web/src/components/RadarMap.tsx`,
`MapLayerMenu.tsx`, `apps/web/src/lib/map-preferences.ts`, new `docs/airports.md`.

**Acceptance.**
- The layer toggles alongside the others and is captured in saved views.
- Bundled data stays within a stated budget — 250 kB gzipped for a 250 nm radius
  is the working target; document the actual figure.
- Labels declutter: no overlapping airport labels at any zoom, on either theme.
- The data source and licence are documented and surfaced in the map
  attribution.
- A deployment with no airport data renders no layer and no error.

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

**Approach.** Extend the live snapshot query (`live-repository.ts:46`) with one
more `LEFT JOIN` onto `aircraft_summary` — it already joins `watchlist`,
`alert_events`, and `aircraft_metadata` in a single statement, so this costs a
join, not a round trip. Carry `firstSeenAt` on `liveAircraftSchema`
(`contracts.ts:44`) and derive "new" on the client against a threshold
preference (since this session started / last 24 hours).

Deriving it client-side matters for the delta path: `LiveAircraftDiff` suppresses
rows whose JSON is byte-identical to the previous tick
(`aircraft-diff.ts:16`). A static `firstSeenAt` rides along on rows already
being sent and costs nothing; a server-computed `isNew` boolean, or anything
relative to `now`, would flip and force otherwise-unchanged rows onto the wire
every second.

Surface as: a badge in the table's aircraft cell and in the detail panel, a
filter for new sightings, and an optional map emphasis. No sound, no nav badge,
no alert feed entry.

**Files.** `apps/server/src/db/live-repository.ts`,
`packages/shared/src/contracts.ts`, `apps/web/src/lib/aircraft-filter.ts`,
`AircraftTable.tsx`, `AircraftFilters.tsx`, `AircraftDetailPanel.tsx`,
`apps/web/src/lib/unit-preferences.ts` or a sibling for the threshold
preference.

**Acceptance.**
- The added join does not measurably slow the 1 Hz snapshot at 1,000 aircraft —
  asserted against the existing load smoke.
- The delta payload is unchanged in size and frequency for aircraft whose
  telemetry has not changed.
- An aircraft with no summary row renders as unknown (`—`), never as "new".
- No `alert_events` row is written under any circumstance, and the alert rule
  constraint from migration 009 is untouched.
- The badge meets AA contrast in both themes and is not conveyed by colour
  alone.

---

## Tier 3 — Larger bets

Worth doing, but each is a project rather than a feature. Scope properly before
starting.

### 20. Aircraft photographs — **M**

The single most-requested feature in comparable apps, and the one that breaks
the offline-first rule: it requires a runtime external API. If pursued, make it
explicitly opt-in, cache aggressively in PostgreSQL, degrade silently when
offline, and state in Settings that enabling it sends ICAO addresses to a third
party.

### 21. Route inference — **L**

Origin/destination is not in the ADS-B payload and cannot be derived from the
receiver alone. Deriving probable routes from observed track geometry and
repeated callsign patterns against the local history is feasible and stays
offline, but it is a modelling exercise with an accuracy contract to define.

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

1. **Sprint 1 — foundations and quick wins.** Items 22, 23, 15. The navigation
   fix and the shared chart table are prerequisites for later items; saved-view
   defaults are the highest-value small feature.
2. **Sprint 2 — share and compare.** Items 16, 13, 25. The snapshot compositor
   from 16 is reused by 17, and 13 depends on the chart table from 23.
3. **Sprint 3 — analysis reach.** Items 17, 18. Drill-downs assume 22 and 16 are
   in place; the help page documents everything shipped by then.
4. **Sprint 4 — new data.** Items 14, 24. Both touch server data paths and
   deserve their own release.

## Cross-cutting requirements

Every item inherits the standards the v1 build already meets, and regressions
against them block a merge:

- Keyboard operable, visible focus, correct ARIA, and `prefers-reduced-motion`
  respected. The `@axe-core/playwright` e2e pass must stay clean in both themes.
- Every chart has a keyboard-reachable table of its values (item 23 makes this
  true; keep it true).
- Desktop and mobile layouts both covered — the mobile bottom-sheet pattern in
  `LivePage.tsx` is the reference.
- Both themes checked, including any colour that carries meaning.
- All displayed measurements route through the `format.ts` helpers so unit
  preferences and the display time zone apply; exports stay in ft/kt/nm and say
  so.
- Internal navigation uses the router, never a document load.
- Unavailable values render as `—`, never as `0`, `null`, or `NaN`.
- New preferences fail safe: corrupt or absent storage falls back to defaults
  without blocking live data (see `storedFilters`, `LivePage.tsx:50`).
- Unit and component tests alongside the change; e2e coverage for anything that
  alters a primary user flow.
- `npm run typecheck`, `npm run lint`, `npm run test:coverage`, and
  `npm run build` all pass.
