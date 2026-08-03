# Flightmap — User Experience Enhancement Plan

Prioritised backlog of user-facing improvements for the delivered v1 application.
Authentication and security work is deliberately out of scope; the deployment
model (trusted LAN, reverse proxy for remote access) is unchanged.

The original v1 build specification has moved to
[`docs/v1-build-plan.md`](docs/v1-build-plan.md) and remains the reference for
existing behaviour.

## How to use this document

Each item is self-contained and independently shippable. Work top to bottom
within a tier; tiers are ordered by value per unit of effort. Tick the checkbox
when the acceptance criteria pass and `npm run typecheck && npm run lint && npm run test`
is clean.

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

- [ ] Implement

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

- [ ] Implement

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

### 7. Local alert notifications and sound — **M**

- [ ] Implement

**Problem.** Alerts are in-app only. If the tab is in the background — the
normal state for a wall-mounted or second-monitor dashboard — an emergency
squawk or watchlist arrival is missed entirely. v1 deliberately excluded
external notification services; the browser Notification API is local and does
not reintroduce that dependency.

**Approach.** Opt-in, off by default, configured in Settings:
- Browser notifications via the existing service worker, for chosen alert kinds
  and severities.
- An optional short audio cue with a distinct tone per severity, generated with
  the Web Audio API so no asset is shipped or fetched.
- Respect the page's visibility state — no notification while the tab is
  focused and the alert is already on screen.
- Rate-limit to avoid a burst during a receiver recovery.

**Files.** New `apps/web/src/lib/notifications.ts`, `LiveContext.tsx` (alert
subscription), `SettingsPage.tsx`, service worker registration in
`apps/web/src/main.tsx`.

**Acceptance.**
- No permission is requested until the user enables the feature.
- Clicking a notification focuses the tab and opens that alert's aircraft.
- Sound respects an explicit mute and never plays before a user gesture has
  unlocked audio.
- Disabled by default; existing in-app banner behaviour is unchanged.

---

### 8. Live list virtualisation and render budget — **M**

- [ ] Implement

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

- [ ] Implement

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

- [ ] Implement

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

### 11. First-run onboarding — **S**

- [ ] Implement

**Problem.** A fresh install shows an empty dark map and "The latest receiver
snapshot contains no current aircraft" (`LivePage.tsx:415`) until someone
discovers that Settings needs a receiver URL. The README explains this; the
application does not.

**Approach.** When the receiver URL is unset or has never produced a snapshot,
show a guided panel over the Live page: set the receiver URL, confirm
coordinates, verify the connection, and a link to the fake receiver for anyone
evaluating without hardware. Add a "Test connection" action to Settings that
fetches the configured endpoint and reports what it found (aircraft count,
receiver version, coordinates) before saving.

**Files.** New `apps/web/src/components/SetupGuide.tsx`, `LivePage.tsx`,
`SettingsPage.tsx`, a validation endpoint in `apps/server/src/routes/api.ts`
backed by the existing collector fetch logic.

**Acceptance.**
- The guide appears only when the receiver has genuinely never delivered data,
  never during a transient outage (which keeps the existing connection banner).
- "Test connection" reports actionable failures — DNS, timeout, non-JSON,
  missing fields — not a generic error.
- Dismissible, and does not reappear once data has flowed.

---

### 12. Theme, density, and display preferences — **M**

- [ ] Implement

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

## Tier 2 — Depth and polish

### 13. Multi-track profile comparison — **S**

- [ ] Implement

`FlightProfile` renders only the focused track (`HistoryPage.tsx:905`).
Overlay up to four selected tracks on one altitude/speed axis, colour-matched to
their map lines, so approaches to the same runway can be compared directly.

**Acceptance.** Overlay is legible with four tracks; the accessible data table
that backs the chart lists every series; single-track behaviour is unchanged.

---

### 14. Airport and runway layer — **M**

- [ ] Implement

The map shows configurable arrival/departure fixes
(`default-waypoints.ts`) but no airports, so tracks converge on nothing visible.
Ship a small bundled dataset of airports within a configurable radius of the
receiver (ICAO, name, position, runway thresholds), rendered as a toggleable
layer. Keep it local — no runtime external lookup, matching the offline-first
metadata approach.

**Acceptance.** Layer toggles with the others, is bounded in size, labels
declutter at low zoom, and the data source and licence are documented in
`docs/`.

---

### 15. Saved views: defaults and pinning — **S**

- [ ] Implement

Saved views exist for Live, History, and Insights
(`SavedViewsControl.tsx`) but every visit starts from the built-in default.
Allow marking one view per surface as the default applied on load, and pinning
up to three to the header for one-click switching.

**Acceptance.** Default applies on load without a visible flash of the built-in
state; a URL with explicit parameters always wins over the default.

---

### 16. Map snapshot and share — **S**

- [ ] Implement

Add "Copy link" and "Download image" to the map controls. The link already
exists in the URL for both Live and History — it just is not discoverable. The
image uses the MapLibre canvas with an overlaid caption (receiver, timestamp,
aircraft count).

**Acceptance.** Copied link restores the identical view including viewport;
downloaded PNG includes attribution required by the tile provider.

---

### 17. Insights drill-down and export polish — **S**

- [ ] Implement

Insights has strong data and CSV export
(`GET /api/v1/exports/insights`). Add chart image export, per-series
show/hide, and click-through from any chart element to a pre-filtered History
search for that bucket.

**Acceptance.** Every drill-down lands on a History query that returns the
sessions the chart element counted.

---

### 18. In-app help — **S**

- [ ] Implement

Operational documentation lives in `docs/` and the README, reachable only from
the repository. Add a Help page covering the shortcut reference, field
glossary (NIC, NACp, SIL, emitter category, MLAT versus ADS-B), retention model,
and what "detailed track expired" means — the concepts the UI already surfaces
but never explains.

**Acceptance.** Every jargon term shown in the detail panel appears in the
glossary; the page works offline from the PWA shell.

---

## Tier 3 — Larger bets

Worth doing, but each is a project rather than a feature. Scope properly before
starting.

### 19. Multiple receivers — **L**

The data model, collector, and status view assume one receiver
(`docs/v1-build-plan.md`, "Assumptions"). Supporting two or more means a
receiver dimension through ingestion, storage, aggregates, and the UI, plus
per-receiver coverage comparison. High value if a second receiver is ever added;
no value until then.

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

---

## Suggested sequencing

1. **Sprint 1 — visual legibility.** Items 1, 3, 6. Highest visible change for
   the least risk; all confined to the web workspace.
2. **Sprint 2 — control and reach.** Items 2, 4, 5. Trails and units both touch
   shared preference plumbing, so land them together.
3. **Sprint 3 — attention and scale.** Items 7, 8, 11. Notifications and
   onboarding make the dashboard usable unattended and from cold.
4. **Sprint 4 — analysis.** Items 9, 10, 13. The history and map interrogation
   work compounds.
5. **Sprint 5 — accessibility and polish.** Items 12, 14–18.

## Cross-cutting requirements

Every item inherits the standards the v1 build already meets, and regressions
against them block a merge:

- Keyboard operable, visible focus, correct ARIA, and `prefers-reduced-motion`
  respected. The `@axe-core/playwright` e2e pass must stay clean.
- Desktop and mobile layouts both covered — the mobile bottom-sheet pattern in
  `LivePage.tsx` is the reference.
- Unavailable values render as `—`, never as `0`, `null`, or `NaN`.
- New preferences fail safe: corrupt or absent storage falls back to defaults
  without blocking live data (see `storedFilters`, `LivePage.tsx:50`).
- Unit and component tests alongside the change; e2e coverage for anything that
  alters a primary user flow.
- `npm run typecheck`, `npm run lint`, `npm run test:coverage`, and
  `npm run build` all pass.
