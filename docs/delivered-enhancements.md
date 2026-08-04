# Delivered UX enhancements — phase 1

The first phase of the post-v1 user-experience backlog, delivered in full.
Items are kept here in their original form as the record of what was specified
and accepted; the code is the reference for how it behaves today.

The remaining backlog lives in [`../plan.md`](../plan.md). The original v1 build
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

## Notes on numbering

Items 8, 11, and 19 were dropped before implementation (notifications,
onboarding, and multi-receiver support) in commit `cf7caf3`. The gaps in the
numbering are deliberate: the surviving numbers are stable identifiers used in
branch names and pull request titles.
