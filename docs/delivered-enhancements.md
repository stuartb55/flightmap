# Delivered UX enhancements — phases 1 to 3

The delivered phases of the post-v1 user-experience backlog: tiers 0, 1 and 2 in
full, and the parts of tier 3 that have shipped since.
Items are kept here in their original form as the record of what was specified
and accepted; the code is the reference for how it behaves today.

What remains of the two tier-3 bets lives in [`../plan.md`](../plan.md). The original v1 build
specification is [`v1-build-plan.md`](v1-build-plan.md).

Effort key: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

---

## Tier 0 — Daily-use wins

These change what a user sees every time they open the app, and each is
contained to the web workspace.

### 1. Category-aware aircraft icons on the map — **M**

- [x] Implement

**Problem.** Every aircraft on the map is the same 34 px plane glyph
(`planeImage` in `apps/web/src/components/RadarMap.tsx:125`), differing only by
altitude colour. A helicopter, an A380, a Cessna, and a ground vehicle are
visually identical, so the map cannot be read at a glance.

**Approach.** The ADS-B emitter category already reaches the client
(`Aircraft.category`, `apps/web/src/types.ts:57`) but is used only as a raw
filter value. Add a category → shape mapping and generate one icon per
(shape × altitude band) pair at style load:

| Category | Shape | Notes |
| --- | --- | --- |
| A1 | Light single-engine | Smaller glyph, straight wings |
| A2 / A3 | Standard airliner | Current glyph, A3 slightly larger |
| A4 / A5 | Heavy / super-heavy | Wider glyph, four engine marks |
| A7 | Rotorcraft | Rotor disc glyph, no track rotation smoothing |
| B1–B4 | Glider / balloon / parachute / ultralight | Simple diamond |
| B6 / B7 | UAV / space vehicle | Chevron |
| C0–C3 | Surface vehicle | Square, always rendered at ground colour |
| unknown | Current glyph | Fallback |

Fall back to the type-code prefix (`metadata.typeCode`) where category is
absent — `H` prefixes and known heavy types are a cheap improvement.

**Files.** `RadarMap.tsx` (icon generation, `liveAircraftData` icon key),
new `apps/web/src/lib/aircraft-category.ts` (mapping + human labels),
`AircraftFilters.tsx` (show "A3 · Large" instead of "A3").

**Acceptance.**
- Rotorcraft, light aircraft, heavies, and surface vehicles are distinguishable
  at default zoom without reading labels.
- Icon count stays bounded (shapes × 8 altitude bands, generated once per style
  load, not per render).
- Unknown/absent categories render exactly as they do today.
- The category filter dropdown shows human-readable labels.
- Map legend documents the shapes alongside the existing altitude scale.

---

### 2. Short trails for every aircraft — **M**

- [x] Implement

**Problem.** Trails only render for the selected aircraft
(`LivePage.tsx:228`, the `trail` memo). Users coming from tar1090/PiAware expect
every aircraft to leave a short trail — it is what makes traffic flow legible
and shows which direction an aircraft came from before you click it.

**Approach.** Accumulate positions client-side from the WebSocket deltas already
arriving each second. Keep a bounded ring buffer per ICAO in `LiveContext`
(default 5 minutes, capped by aircraft count), feed it into a new
`all-aircraft-trails` GeoJSON source rendered below the existing track layer at
low opacity. No server work required — this is display of data the client
already receives.

Add a trail mode to `MapLayerPreferences`: `off` / `selected` (today's
behaviour, the default) / `all`. Reuse the existing `mapDisplay.trailMinutes`
control for length.

**Files.** `apps/web/src/state/LiveContext.tsx` and `live-reducer.ts` (buffer),
`RadarMap.tsx` (source + layer), `apps/web/src/lib/map-preferences.ts`,
`MapLayerMenu.tsx`, `packages/shared/src/contracts.ts` (preference schema).

**Acceptance.**
- With trail mode `all` and 250 aircraft, the map holds ≥ 30 fps on the target
  host and memory stays flat over a 30-minute session (bounded buffer, verified
  by point count assertion in a unit test).
- Trails clear when an aircraft ages out of the live set.
- Existing selected-aircraft server-backed trail behaviour is unchanged in
  `selected` mode.
- Preference persists across reloads and is captured by saved views.

---

### 3. Live table: vertical trend, more columns, and column choice — **M**

- [x] Implement

**Problem.** The table exposes four columns — Aircraft, Altitude, Speed, Range
(`AircraftTable.tsx:18`). Vertical rate is the single most useful missing field
for spotting arrivals versus departures, and it is already in the payload
(`Aircraft.verticalRate`). Squawk, operator, track, and type are also carried
but only visible after selecting an aircraft.

**Approach.**
- Add a climb/descend/level indicator beside altitude (arrow + rate, reusing
  `formatVerticalRate`), always visible — this needs no column chooser.
- Add optional columns: Vertical rate, Squawk, Track, Operator, Type, Age.
- Add a column chooser to the table header, persisted per browser under
  `flightmap.aircraft-columns.v1`, alongside the existing filter persistence.
- Extend `AircraftSortKey` to cover the new sortable columns.

**Files.** `AircraftTable.tsx`, `apps/web/src/lib/aircraft-filter.ts` (sort
keys), new `apps/web/src/lib/table-columns.ts`, `styles/live.css`.

**Acceptance.**
- Climb/descend state is visible without opening the detail panel.
- Column choice persists across reloads and degrades to defaults on corrupt
  storage (mirroring `storedFilters` in `LivePage.tsx:50`).
- Every column is sortable, with `aria-sort` maintained.
- Mobile sheet keeps a sensible reduced column set regardless of desktop choice.

---

### 4. Unit preferences — **M**

- [x] Implement

**Problem.** Units are hardcoded aviation units throughout
(`apps/web/src/lib/format.ts`): feet, knots, nautical miles, ft/min. This is
correct for aviation but wrong for a household member who thinks in kilometres,
and there is no way to change it.

**Approach.** Introduce a unit preference set — altitude (ft / m), speed
(kt / km/h / mph), distance (nm / km / mi), vertical rate (ft/min / m/s) — with
an `aviation` and a `metric` preset. Route every display through the existing
`format.ts` helpers so the change is a single-layer edit; the helpers become
preference-aware exactly as they already are time-zone-aware.

Store per browser (`localStorage`, like map preferences) rather than in the
server settings, so different viewers can differ. Surface the control in the
existing Settings page under "Map and display", reading from local storage.

**Files.** `apps/web/src/lib/format.ts`, new
`apps/web/src/lib/unit-preferences.ts`, `SettingsPage.tsx`, plus every caller
via the shared formatters. Exports (CSV/GeoJSON) stay in canonical aviation
units — note this in the export UI.

**Acceptance.**
- Switching preset updates altitude, speed, distance, and vertical rate
  everywhere — table, detail panel, history, insights, map labels — without a
  reload.
- Range rings, filter inputs, and their suffixes follow the preference, with
  filter values converted rather than reinterpreted.
- Existing `format.test.ts` cases pass under the aviation default; new cases
  cover metric conversion and rounding.
- Exports remain ft/kt/nm and say so.

---

### 5. Command palette (`Cmd`/`Ctrl` + `K`) — **S**

- [x] Implement

**Problem.** Finding a specific aircraft means navigating to Live, focusing
search with `/`, and typing — and there is no way to jump to History for a
callsign, open a saved view, or reach Settings without using the nav.

**Approach.** A single overlay that searches live aircraft (callsign,
registration, ICAO, operator, type), saved views, and static destinations
(pages, "toggle coverage layer", "fit aircraft", "centre receiver"). Selecting
an aircraft routes to `/?aircraft=<icao>`; a modifier opens its profile.

Reuse the existing modal focus-trap pattern (`useModalFocus`,
`LivePage.tsx:71`) — extract it to `apps/web/src/lib/use-modal-focus.ts` so both
callers share it rather than duplicating.

**Files.** New `apps/web/src/components/CommandPalette.tsx`, mounted in
`AppShell.tsx`; extracted `use-modal-focus.ts`; `KeyboardShortcuts.tsx`
shortcut list.

**Acceptance.**
- Opens from any page, closes on `Escape`, restores prior focus.
- Fully keyboard-driven with roving `aria-activedescendant` and an
  `aria-live` result count.
- Results rank exact ICAO/callsign matches first; no result state is explained,
  not blank.
- Does not intercept the shortcut while focus is in a form control
  (`isFormTarget`).

---

### 6. Selection and navigation polish — **S**

- [x] Implement

**Problem.** Three small frictions in the core interaction loop:

1. Selecting an aircraft always re-centres and zooms the map
   (`RadarMap.tsx:880`), yanking the view even when the aircraft is already
   comfortably visible — which makes selecting from the table feel violent.
2. The aircraft list cannot be walked with the keyboard. `A` focuses the first
   row (`LivePage.tsx:305`) and then arrow keys do nothing useful.
3. The `keydown` effect in `LivePage.tsx:298` has no dependency array, so the
   listener is torn down and re-registered on every 1 Hz render.

**Approach.**
1. Only ease to the aircraft when it is outside the current viewport (or inside
   an edge margin); otherwise leave the camera alone. Keep the existing
   behaviour for the follow toggle.
2. Add `↑`/`↓` to move the selection through the filtered list, `Enter` to open
   details, `Home`/`End` to jump. Scroll the active row into view.
3. Give the effect a proper dependency list.

**Files.** `RadarMap.tsx`, `LivePage.tsx`, `AircraftTable.tsx`,
`KeyboardShortcuts.tsx`.

**Acceptance.**
- Selecting a visible aircraft does not move the map; selecting an off-screen
  one brings it into view.
- Arrow-key navigation works from the table and from the command palette
  results, honouring `prefers-reduced-motion` for scroll behaviour.
- The keydown listener registers once per dependency change, not per render.

---

## Tier 1 — Substantial improvements

### 7. Live list virtualisation and render budget — **M**

- [x] Implement

**Problem.** `AircraftTable` renders every filtered row into the DOM. Rows are
memoised (`AircraftTable.tsx:30`) so updates are cheap, but with the 250+
aircraft the load test targets, the initial mount and every filter change build
a large tree, and `filterAircraft`/`sortAircraft` re-run on each 1 Hz snapshot.

**Approach.**
- Windowed rendering of table rows (a small hand-rolled windowing hook is
  enough — no new dependency needed for a single fixed-height list).
- Move filter/sort off the snapshot critical path: keep the sort comparator
  stable and only re-sort when the sort key, the filter set, or the aircraft
  identity set changes, not when telemetry values change.
- Add a render-cost check to the existing load smoke script
  (`infra/scripts/load-smoke.mjs`).

**Files.** `AircraftTable.tsx`, new `apps/web/src/lib/use-window-list.ts`,
`LivePage.tsx`, `infra/scripts/load-smoke.mjs`.

**Acceptance.**
- With 1,000 aircraft from the fake receiver, scrolling stays smooth and
  selection latency stays under 100 ms.
- Keyboard navigation and `aria-rowcount`/`aria-rowindex` semantics survive
  virtualisation — a screen reader still reports the true total.
- Existing `AircraftTable.test.tsx` assertions still hold for small lists.

---

### 9. Map interaction depth — **M**

- [x] Implement

**Problem.** The map supports hover (a transient card, `RadarMap.tsx:942`) and
click-to-select, and nothing else. There is no way to interrogate the map
directly: no persistent popup, no click-to-filter on the altitude legend, no
measuring, and no way to dismiss a selection by clicking empty space.

**Approach.**
- Persistent popup on click with the key telemetry and links to profile/history,
  as an alternative to the side panel on wide screens.
- Make the altitude legend interactive: click a band to isolate it, which writes
  through to the existing altitude filter so the table and map stay consistent.
- Click on empty map space clears the selection.
- Optional ruler tool: click two points for distance and bearing, using the
  existing great-circle helpers (`destinationPoint`, `RadarMap.tsx:186`, and the
  server's `domain/geo.ts` as the reference implementation).

**Files.** `RadarMap.tsx`, `MapLayerMenu.tsx`, `styles/live.css`.

**Acceptance.**
- Legend filtering and drawer filtering stay in sync in both directions.
- Popup is keyboard-dismissible and does not trap focus.
- Ruler is opt-in and does not interfere with selection clicks.

---

### 10. History: session timeline, sorting, and track colouring — **M**

- [x] Implement

**Problem.** History results are a flat card list ordered newest-first with no
sort control — `sort: 'started_desc'` is hardcoded in the saved-view payload
(`HistoryPage.tsx:852`). Overlap between sessions is only surfaced as a
sentence ("Tracks overlap in time and can be replayed together",
`HistoryPage.tsx:901`). Tracks are always coloured by altitude
(`altitudeColour`), so speed and climb structure are invisible.

**Approach.**
- A compact timeline strip above the map: one lane per selected session, drawn
  against the replay bounds, with the replay cursor overlaid. Clicking a lane
  focuses that track's profile; dragging scrubs.
- A sort control for the session list (start time, duration, closest approach,
  maximum altitude, sample count) wired through to the API and the saved view.
- A colour-by control for tracks: altitude (default), ground speed, or vertical
  rate, with the legend updating to match.

**Files.** `HistoryPage.tsx`, new
`apps/web/src/components/SessionTimeline.tsx`, `RadarMap.tsx` (colour
expression), `apps/web/src/lib/format.ts` (speed and vertical-rate ramps),
`apps/server/src/db/history-repository.ts` and `routes/api.ts` if the sort
needs server support.

**Acceptance.**
- Timeline makes temporal overlap between up to eight tracks obvious at a
  glance and stays legible on a narrow screen.
- Sort choice is captured in the URL and in saved views, so a shared link
  reproduces the same ordering.
- Colour-by choice applies to both the map and the flight profile chart.

---

### 12. Theme, density, and display preferences — **M**

- [x] Implement

**Problem.** The interface is dark-only (`color-scheme: dark`,
`styles/base.css:4`). A dark radar map is the right default, but the app is
unreadable in a bright room, and there is no control over text size or density
beyond browser zoom — which breaks the fixed-height app shell
(`html, body, #root { overflow: hidden }`).

**Approach.**
- Extract the existing palette into semantic tokens (it is already
  token-driven — `--bg`, `--panel`, `--text` etc.), then add a light theme by
  overriding the token values only.
- Theme choice: system / dark / light, persisted per browser. Pair the light
  theme with a light map style URL so the map does not fight the chrome.
- A comfortable/compact density toggle driving `--type-body`, `--type-control`,
  and row padding.

**Files.** `styles/base.css` (tokens), each page stylesheet (replace any
remaining literal colours), new `apps/web/src/lib/theme.ts`, `AppShell.tsx`,
`SettingsPage.tsx`.

**Acceptance.**
- Both themes meet WCAG AA contrast for body text and interactive controls;
  verified by the existing `@axe-core/playwright` e2e pass run in both themes.
- No flash of the wrong theme on load.
- Alert, emergency, and altitude-band colours remain distinguishable in light
  mode — these carry meaning and must be re-checked, not merely inverted.
- Existing dark appearance is byte-for-byte unchanged as the default.

---

## Phase 2 — depth and polish

Tier 2 of the backlog, in the order the items were specified. Items 22–25 were
added at the start of the phase, once phase 1 had landed and the gaps it exposed
were visible.

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

- [x] Implement

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

## Phase 3 — the rest of tier 2

The last two tier-2 items. Both added data to a server path and each took its own
release. Item 18, in-app help, was dropped before implementation.

### 24. New-to-this-receiver sightings — **M**

- [x] Implement

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

### 14. Airport and runway layer — **M**

- [x] Implement

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

**How they were settled.** Radius *and* a size rule, both adjustable on the CLI:
large and medium airports are kept unconditionally, a small one only with a
runway over 1,000 m (`--min-runway-ft`), and heliports, seaplane bases and closed
fields never. Runways earn their place in the same fetch — the reference
deployment's whole dataset, 137 airports and 175 centrelines, is 41,940 bytes or
about 9 kB gzipped against a 250 kB budget, so a second zoom-gated request would
have been complexity for nothing. See [`airports.md`](airports.md).

---

## Notes on numbering

Items 8, 11, 18 and 19 were dropped before implementation (notifications,
onboarding, in-app help, and multi-receiver support); the first three of those in
commit `cf7caf3` and item 18 in `33f3230`. The gaps in the
numbering are deliberate: the surviving numbers are stable identifiers used in
branch names and pull request titles.

---

## Tier 3 — Larger bets, scoped

The two tier-3 bets were each split into independently shippable items. What is
here has shipped; the rest is still in [`../plan.md`](../plan.md).

Aircraft photographs — bet 20 — is complete: item 26 built the cache and item 27
the surface and the disclosure.

### 26. Aircraft photograph cache and fetch service — **M**

- [x] Implement

**Problem.** There is no photograph anywhere in the app, and adding one means the
first runtime dependency on a third-party API in a codebase built to have none.
The whole item is about containing that: off by default, fetched once per
airframe, served from our own origin thereafter, and silent when it fails.

**Approach.** Four decisions carry it.

*Cache the bytes, not the link.* A hotlinked URL puts every viewer's browser in
touch with the third party rather than just the server, breaks on an offline
receiver even for a photograph already seen, and rots on the upstream's schedule.
Store the image in `bytea` and serve it from `GET /api/v1/aircraft/:icao/photo`
with a strong `ETag` and a long `max-age`, the same shape as the airports
endpoint (`api.ts:96`). This is also what makes the disclosure in item 27 true:
the only host that learns which airframes are being viewed is the configured one,
and only once per airframe.

*Never on the 1 Hz path.* Nothing joins `aircraft_photos` into the snapshot query
(`live-repository.ts`) and nothing is fetched on a live tick. A fetch is
triggered only by a profile request for an airframe with no unexpired row, runs
in a service with one request in flight at a time and a bounded queue, and the
profile response never waits on it — the image endpoint 404s until the row lands
and the client re-requests on the next view.

*A miss is a row.* An airframe the source has no photograph for gets a
`status = 'absent'` row with a shorter expiry, or every view of a common
unphotographed airframe re-asks upstream forever. A transport failure gets
`status = 'failed'` with a shorter expiry again, so a temporary outage does not
poison the cache for a month.

*Reuse the download hardening that already exists.* `services/airports.ts` fixes
a maximum download size and a timeout in code rather than in settings, on the
argument that no operator can judge a sensible byte cap and a wrong one turns a
hostile URL into a memory problem. Same reasoning, same pattern, smaller numbers:
a per-image cap of 200 kB, a 10 second timeout, and a rejection of any response
whose content type is not `image/jpeg`, `image/png` or `image/webp` — sniffed
from the bytes, not trusted from the header.

*Storage.* New migration `016_aircraft_photos.sql`:

```
aircraft_photos (
  icao char(6) PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'failed')),
  image bytea, content_type text, bytes integer, width integer, height integer,
  credit text, link_url text, source_url text,
  fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  last_served_at timestamptz NOT NULL DEFAULT now()
)
```

with indexes on `expires_at` and `last_served_at`. The row is keyed on ICAO
address, not registration, because that is what the live path has.

*Settings.* New keys on `settingsShape` (`settings.ts:41`), all server-managed
until item 27 gives them a form: `aircraftPhotosEnabled` (default `false`),
`aircraftPhotoSourceUrl` (default `""`, and therefore not `httpUrlSchema` — a
union with the empty string, validated as http/https when non-empty),
`aircraftPhotoTtlDays` (30), `aircraftPhotoNegativeTtlDays` (7),
`aircraftPhotoCacheEntries` (2,000). Note the split that already exists in the
web client: `apps/web/src/types.ts:248`–`:256` marks server-managed keys optional
and `buildSettings` (`SettingsPage.tsx:59`) omits them, which is safe because the
endpoint is `PATCH` against `appSettingsPatchSchema` (`api.ts:124`). A key with no
form field is therefore fine; a key with a form field must be added to
`buildSettings` or saving the form silently reverts it.

*Eviction.* A new step in `MaintenanceService.run` (`maintenance.ts:63`), beside
the existing retention steps and inside the same advisory lock: delete expired
rows, then delete least-recently-served rows beyond `aircraftPhotoCacheEntries`.
Record the counts in `maintenance_log` (`001_initial.sql:248`) the way the other
steps do, which means a migration column rather than a new table.

**Files.** New `apps/server/src/db/migrations/016_aircraft_photos.sql`, new
`apps/server/src/services/aircraft-photos.ts`, new
`apps/server/src/db/photo-repository.ts`, `apps/server/src/settings.ts`,
`apps/server/src/routes/api.ts`, `apps/server/src/services/maintenance.ts`,
`packages/shared/src/contracts.ts` (photo status response),
`apps/web/src/types.ts`, new `docs/photos.md`, `docs/disk-sizing.md`.

**Acceptance.**
- A default installation makes no outbound request to any photo host, ever;
  asserted by a test that boots with defaults, exercises a profile view, and
  fails on any fetch to an unconfigured host.
- With the feature enabled and a stubbed upstream, viewing the same airframe
  repeatedly produces exactly one upstream request per TTL; the second view is
  served from PostgreSQL and the third from the browser cache via `ETag`.
- An upstream that is slow, 404s, 500s, returns HTML, or returns a 10 MB file
  produces an `absent` or `failed` row and never an unbounded read.
- With the network unplugged, an airframe with a cached photograph still renders
  it, and one without renders nothing and logs nothing at error level.
- `live-repository.ts` gains no join and `npm run test:load` is unchanged at
  1,000 aircraft.
- After a maintenance run the cache holds no expired rows and no more than the
  configured entry count; eviction is least-recently-served.
- `docs/photos.md` states the configured source, the terms the operator recorded
  for it, and the storage budget; `docs/disk-sizing.md` gains the photo cache as
  a named line item.

### 27. Photographs on the aircraft profile — **S**

- [x] Implement

**Problem.** Item 26 builds a cache nothing reads, and leaves the feature
switchable only by someone with database access. This item is the surface and the
disclosure.

**Approach.**

*Profile only.* A new panel on `AircraftProfilePage.tsx`, above the identity
panel (`:161`). The `<img>` points at `/api/v1/aircraft/:icao/photo`, carries
explicit `width`/`height` from the cached dimensions so the panel does not shift
as it loads, and has an `alt` describing the airframe — registration and type
where known, ICAO address otherwise — never "photo". A photograph the cache does
not have renders no panel at all, not an empty frame and not a spinner that never
resolves. The credit line names the photographer and links back, `rel="noreferrer
noopener"`, and is part of the panel rather than a hover affordance.

*A Settings card that tells the truth.* A new card modelled on `AirportData`
(`SettingsPage.tsx:280`) and its download flow (`:424`): the enable switch, the
source URL, the TTL and cache-size fields, a cached-count and cached-bytes
summary, and a "Clear cached photographs" button. Above the controls, in prose
and not in a tooltip: enabling this sends the ICAO address of each aircraft whose
profile is opened to *the configured host, named*, and nothing else leaves this
network. Deriving the host from the configured URL rather than hard-coding a name
is the point — a changed URL changes the sentence.

*Every new operator-editable key goes into `buildSettings`.* Five keys, five form
fields, or the form's next save reverts them. Add the regression test that saves
the form and asserts the photo settings survive the round trip; this trap is
cheap to fall into and invisible until someone else saves Settings.

**Files.** `apps/web/src/pages/AircraftProfilePage.tsx`,
`apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/lib/api.ts`,
`apps/web/src/styles/profile.css` and `settings.css`,
`apps/server/src/routes/api.ts` (cache summary
and clear endpoints), tests alongside each.

**Acceptance.**
- With photographs disabled — the default — the profile is byte-identical to
  today and the Settings card explains what enabling would do.
- The panel holds its space: no layout shift measurable between the profile
  rendering and the image arriving.
- An airframe with no photograph shows no panel, no error, and no empty region.
- The disclosure names the host actually configured, and changes when it changes.
- The photographer credit and the link are present whenever an image is.
- Saving Settings preserves every photo key; asserted by a round-trip test.
- The e2e axe pass stays clean in both themes with the panel present and absent,
  and the credit link is keyboard reachable with a visible focus ring.
