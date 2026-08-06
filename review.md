# Flightmap — Peer Review Findings

Review of the feature work delivered since the v1 build, covering the phase-3
releases through `62f0018`. Item numbers continue from `plan.md`, which stops at
30, so these are stable identifiers usable in branch names and PR titles.

**Baseline.** `npm run typecheck`, `npm run lint` and `npm run test` are all
clean on `main` — 531 tests across 71 files. Nothing below is a broken build;
these are defects and improvements found by reading the delivered code.

Effort key matches `plan.md`: **S** ≈ half a day, **M** ≈ 1–2 days.

Tick the checkbox when the acceptance criteria pass and
`npm run typecheck && npm run lint && npm run test` is clean.

---

## Priority 1 — Defects a reader will hit

### 31. Single-key shortcuts fire while a modifier is held — **S**

- [ ] Implement

**Problem.** The global `keydown` handlers test `event.key` without looking at
`metaKey`, `ctrlKey` or `altKey`, then call `preventDefault()`. Every browser
chord that shares a letter with a shortcut is swallowed:

| Chord | Page | What happens instead |
| --- | --- | --- |
| `Ctrl`/`Cmd`+`A` | Live | Select-all is cancelled; focus jumps to the aircraft list |
| `Ctrl`/`Cmd`+`C` | History | **Copy is cancelled and every selected track is cleared** |
| `Cmd`+`↑`/`↓` | Live | Jump-to-top/bottom is cancelled; the selection moves one row |
| `Ctrl`+`Home`/`End` | Live | Cancelled; the selection moves to the first/last aircraft |

The History case is the serious one: a reader selects a callsign in the session
table, presses `Cmd`+`C`, gets no clipboard and loses up to eight loaded tracks
(`HistoryPage.tsx:787`, which calls `clearTracks`).

`isFormTarget` does not save it — it only stands aside for `INPUT`, `TEXTAREA`,
`SELECT`, `BUTTON` and `contenteditable`. Text selected in a table cell has
`<body>` or the cell as the event target.

**Approach.** The command palette already models the correct test
(`CommandPalette.tsx:92`). Add a shared guard beside `isFormTarget` in
`KeyboardShortcuts.tsx` — a plain-key predicate that is false when any of
`metaKey`, `ctrlKey` or `altKey` is set — and apply it in every unmodified-key
branch. `Shift` must stay allowed: `?` and `/` are the same physical key.

**Files.** `apps/web/src/components/KeyboardShortcuts.tsx` (the predicate and
its `?` handler), `apps/web/src/pages/LivePage.tsx:413`,
`apps/web/src/pages/HistoryPage.tsx:778`, tests alongside each.

**Acceptance.**
- Every chord in the table above performs its browser default, on both pages.
- `?` still opens the guide, and `Shift` is not treated as a blocking modifier.
- `Cmd`+`K` still opens the palette from both pages.
- A test asserts `clearTracks` is not called for `Cmd`+`C` on History.

---

### 32. A theme change resets the map camera — **S**

- [ ] Implement

**Problem.** The map effect depends on `theme` (`RadarMap.tsx:1362`) and a theme
change is a full teardown: `map.remove()` and a fresh `new maplibregl.Map(...)`.
The replacement is constructed from `initialViewportRef.current`
(`RadarMap.tsx:755`, `:939`), which is captured once at mount from the
`initialViewport` prop and never updated. Wherever the reader had panned and
zoomed to is discarded and the map returns to the shared link's viewport, or to
the receiver at zoom 7.7.

The rebuild is correct — a style change does replace every layer, and the
airport layer's `getSource` guard at `RadarMap.tsx:1428` depends on it. Only the
camera is wrong.

This is not just the Settings dropdown. `useResolvedTheme` tracks
`prefers-color-scheme` (`theme.ts`), so under the default-adjacent
`theme: 'system'` an OS light/dark switch at sunset resets the map by itself.

**Approach.** Capture `getViewport()` in the effect's cleanup into a ref, and
prefer that ref over `initialViewportRef` when constructing the replacement. The
first mount has nothing captured and so still honours the shared link.

**Files.** `apps/web/src/components/RadarMap.tsx`, plus a test in
`RadarMap.test.ts`.

**Acceptance.**
- Pan and zoom away from the receiver, switch theme: centre, zoom and bearing
  are unchanged.
- Opening a shared link still lands on the shared viewport with no jump.
- Airport, coverage and trail layers still rebuild against the new style.

---

### 33. Selecting an aircraft pushes history and drops the query string — **S**

- [ ] Implement

**Problem.** `selectAircraft` calls `setSearchParams({ aircraft: icao })`
(`LivePage.tsx:288`) and `closeDetails` calls `setSearchParams({})` (`:296`).
`useSearchParams` builds a **new** `URLSearchParams` from the argument
(`router.tsx:126`) and defaults `replace` to false (`:125`), so each call both
replaces the entire query string and pushes a history entry. Two consequences:

- Opening a shared Live link and clicking one aircraft discards the `view=`
  viewport and every filter parameter the sender put in the link. The map does
  not move — the viewport was applied at construction — but the link in the
  address bar is no longer the link that was shared.
- Clicking through twenty aircraft leaves twenty history entries. Back does not
  leave the Live page; it walks the selection backwards. Selection is not
  navigation.

**Approach.** Merge into the current params rather than replacing them, and pass
`replace = true` for selection and dismissal. The existing signature already
accepts a `URLSearchParams`, so this is a change at the call sites plus a
convenience overload.

**Files.** `apps/web/src/pages/LivePage.tsx`, `apps/web/src/lib/router.tsx`,
tests alongside.

**Acceptance.**
- Selecting and clearing an aircraft adds no history entry; one Back leaves the
  Live page whatever was clicked.
- A shared link's `view=` and filter parameters survive a selection.
- The deep-link precedence in `useDefaultSavedView` (`LivePage.tsx:327`) still
  holds: `?aircraft=` from the palette still outranks the default saved view.

---

### 34. Settings: Download does not use the form, and discards unsaved edits — **S**

- [ ] Implement

**Problem.** Two separate defects in the airport download flow.

*The documented behaviour is not the implemented behaviour.* The `AirportData`
docstring states "pressing Download uses what is in the form, so a changed
radius can be tried without saving first" (`SettingsPage.tsx:271`). It does not.
`api.refreshAirports()` posts no body (`api.ts:457`) and
`AirportImportService.refresh` reads `this.settings.get().settings`
(`services/airports.ts:92`) — the *saved* values. An operator who types a 400 nm
radius and presses Download silently gets 250 nm, and the result panel reports
the radius that was actually used, so the discrepancy is visible but
unexplained.

*A successful download discards unsaved edits.* `downloadAirports` bumps
`retryKey` (`SettingsPage.tsx:432`), which refetches settings, which changes
`response.updatedAt`, which is the form's `key` (`:523`). React unmounts and
remounts the whole form; every uncontrolled `defaultValue` resets. Anything
typed and not yet saved is gone. The comment at `:287` anticipates the remount
but treats it as a feature.

**Approach.** Pick one reading and make both sides agree. The docstring's is the
better one — trying a radius before committing to it is the point of the card —
so send the four airport fields in the POST body, validated against a new schema
in `contracts.ts`, and have `refresh` prefer them over the stored settings.

For the remount, refresh the airport-specific state without changing the form's
key: read the summary the endpoint already returns, and drop `retryKey` from
this path.

**Files.** `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/lib/api.ts`,
`apps/server/src/services/airports.ts`, `apps/server/src/routes/api.ts`,
`packages/shared/src/contracts.ts`, tests alongside each.

**Acceptance.**
- Changing the radius and pressing Download without saving downloads at that
  radius, and the result panel reports it.
- Editing an unrelated field, pressing Download, then Save preserves the edit.
- The endpoint still rejects an out-of-range radius with a 400 rather than
  trusting the body.
- Concurrent downloads still get 409 (`api.ts:123`).

---

### 35. The live alert list grows without bound — **S**

- [ ] Implement

**Problem.** `mergeAlerts` (`live-reducer.ts:119`) unions the incoming alerts
into everything already held and never caps the result. Nothing evicts:
`dismiss-alert` marks `dismissedAt` and keeps the row (`:187`), and only a fresh
snapshot could clear the list — which it does not, because `snapshot` leaves
`alerts` untouched (`:134`).

On the deployment this app is built for — a wall display left up for days — the
array only grows, and every delta carrying an alert rebuilds a `Map` over all of
it and re-sorts (`:121`–`:124`). The `alerts` array is also in the status
context value (`LiveContext.tsx:244`), so each of those allocations re-renders
every status consumer.

**Approach.** Cap the merge, sorted newest-first as it already is. A few hundred
is far more than the banner (`LivePage.tsx:57`) or the Alerts page reads, and the
server remains the source of truth for anything older via `GET /api/v1/alerts`.

**Files.** `apps/web/src/state/live-reducer.ts`, `live-reducer.test.ts`.

**Acceptance.**
- Feeding more alerts than the cap keeps exactly the cap, newest first.
- The emergency banner and the Alerts page are unaffected at normal volumes.
- A dismissed alert still disappears from the banner.

---

## Priority 2 — Robustness and performance

### 36. The History keydown listener is rebuilt on every render — **S**

- [ ] Implement

**Problem.** The effect at `HistoryPage.tsx:777` has no dependency array
(`:796` closes with `})`), so the `document` listener is removed and re-added on
every render. During replay, `setReplayTime` runs once per animation frame
(`:706`), which makes that sixty add/remove pairs a second for the whole
playback.

`LivePage.tsx:443` lists its dependencies and the comment there says exactly
why. This is the same handler shape without the fix.

**Approach.** List the dependencies. `clearTracks` needs `useCallback` first.

**Files.** `apps/web/src/pages/HistoryPage.tsx`.

**Acceptance.**
- The listener is installed once per genuine change, asserted by a test that
  counts `addEventListener` calls across a re-render.
- Space, `/`, `c` and Escape behave as they do today.

---

### 37. The airport import stalls the event loop — **M**

- [ ] Implement

**Problem.** `parseCsv` (`domain/airports.ts:30`) is a character-at-a-time loop
building fields by string concatenation, `csvRecords` (`:68`) then allocates a
~16-key object per row, and `selectAirports` (`:112`) runs
`calculateRangeAndBearing` and `airportSchema.parse` per candidate. All of it is
synchronous, and since item 14 moved the import into the Settings page it runs
**inside the serving process** rather than in the CLI.

Measured against a realistic OurAirports shape — 8.7 MB, 83,000 airport rows,
50,000 runway rows — on this development machine:

```
parse 215 ms | select 106 ms | TOTAL 321 ms
```

On the Raspberry-Pi-class hardware a receiver usually runs on, expect roughly
1 s. For that whole window nothing else runs: the 1 Hz collector poll is
skipped, every connected WebSocket client gets no delta, and `/health/ready`
does not answer.

Not a crisis — it is operator-initiated, infrequent, and a second of stall is
recoverable. But it is a self-inflicted stall in the one process that is
supposed to stay responsive, and the download hardening around it
(`services/airports.ts:55`) shows the intent was to keep a hostile URL from
becoming a process problem.

**Approach.** Yield to the loop between chunks — parse in row batches with an
`await new Promise(setImmediate)` every few thousand rows — which keeps the code
shared with `airports-cli.ts` and needs no worker plumbing. A worker thread is
the alternative if the batching turns out to complicate the CLI path.

**Files.** `apps/server/src/domain/airports.ts`,
`apps/server/src/services/airports.ts`, `apps/server/src/airports-cli.ts`,
`apps/server/test/airports.test.ts`.

**Acceptance.**
- The CLI and the Settings import still produce byte-identical output from
  identical input, per `docs/airports.md`.
- A load test with a running collector shows no dropped 1 Hz tick during an
  import.
- `/health/ready` answers within its normal latency throughout.

---

### 38. Insights overview full-scans the airframe tables on every request — **M**

- [ ] Implement

**Problem.** The `designator_evidence` CTE in `leadersSql`
(`insights-repository.ts`) scans all of `aircraft_summary`, left-joins
`aircraft_metadata`, filters on a regex over `latest_callsign`, and groups by
designator and operator — on every call to `/api/v1/insights/overview`.

It takes no range parameter. The result is identical for every preset, every
custom range, and every Refresh press; the Insights page fires four queries on
mount and again on each preset click (`InsightsPage.tsx:640`), so a reader
comparing 24 hours against 7 days pays for the same scan repeatedly. It grows
with the number of airframes the receiver has ever heard, which is the one table
that never shrinks.

**Approach.** Cache it in the repository keyed on nothing, with a TTL of an hour
or so and invalidation on a metadata refresh — the mapping only moves when
`aircraft_metadata` or `aircraft_summary` changes, and neither is on a hot path.
A materialised view refreshed in `MaintenanceService.run` is the alternative if
the cache proves awkward to invalidate.

**Files.** `apps/server/src/db/insights-repository.ts`,
`apps/server/src/services/maintenance.ts` if the view route is taken,
`apps/server/test/integration/` coverage.

**Acceptance.**
- Operator inference produces the same leaders as today, asserted against the
  existing fixtures.
- A second overview request in the same window issues no designator query.
- A metadata refresh is reflected without a restart.

---

### 39. Response-header work repeated per request — **S**

- [ ] Implement

**Problem.** The `onSend` hook calls `contentSecurityPolicy(...)` for every
reply (`app.ts:154`), which constructs a `Set`, parses two URLs and joins ten
directives — on health checks, on static assets, and on the 1 Hz API polls.
`renderedIndex()` likewise re-runs `String.replace` and re-serialises the config
JSON on every document request (`app.ts:237`).

Both inputs live on the runtime config object that `AppSettingsService.apply`
mutates in place (`settings.ts:298`), so they can change — but only when
settings are saved, not per request.

**Approach.** Memoise both on their inputs: recompute the CSP when either style
URL changes, and the rendered index when any injected value does. A one-entry
cache keyed on the concatenated inputs is enough and keeps the live-update
behaviour that mutation in place provides.

**Files.** `apps/server/src/app.ts`, `apps/server/test/routes.test.ts`.

**Acceptance.**
- The CSP still tracks a style URL changed through `PATCH /api/v1/settings`
  without a restart.
- The injected `flightmap-config` meta tag still reflects saved settings on the
  next document load.

---

### 40. Settings responses bypass schema validation — **S**

- [ ] Implement

**Problem.** `api.settings()` (`api.ts:448`) and `api.updateSettings()` (`:484`)
are the only two calls that pass no schema to `request()`, so the body is cast
with `as T` (`:125`). Every other endpoint gets the version-mismatch message at
`:130`.

The failure mode is poor: a server on a different version returns a settings
object missing `rangeRingsNm`, and the page throws `Cannot read properties of
undefined (reading 'join')` at `SettingsPage.tsx:593` — a blank page and a
console stack, where every other surface would have said which of the two is out
of date.

**Approach.** Export an `appSettingsResponseSchema` from `contracts.ts` and pass
it at both call sites. The shape already exists on the server as
`appSettingsSchema` (`settings.ts:140`); the point is to have the *client*
assert it.

**Files.** `packages/shared/src/contracts.ts`, `apps/web/src/lib/api.ts`,
`apps/web/src/types.ts`, tests alongside.

**Acceptance.**
- A truncated settings response produces the version-mismatch message and the
  Retry button, not a blank page.
- A settings round trip through the real server still parses.

---

### 41. No client-side request timeout — **S**

- [ ] Implement

**Problem.** `request()` (`api.ts:95`) passes no `AbortSignal.timeout`. A server
that accepts a connection and never answers leaves every call pending
indefinitely. `refreshAirports` is the visible case — it takes no signal at all
(`:457`) — so the Settings card sits on "Downloading…" forever with no way back
except a reload.

**Approach.** A default timeout in `request()`, composed with any caller-supplied
signal so both can abort. Generous for the airport refresh, which legitimately
takes tens of seconds; the server's own download timeout is 60 s
(`services/airports.ts:56`) and the client's should exceed it.

**Files.** `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`.

**Acceptance.**
- A never-answering endpoint surfaces a timeout error, not a permanent spinner.
- The airport refresh still succeeds on a slow but working download.
- Caller-supplied abort still works — the Insights page's per-effect controllers
  are unaffected.

---

### 42. Un-abortable and non-reactive request state — **S**

- [ ] Implement

**Problem.** Three smaller instances of the same shape:

- `selectCoverageCell` (`InsightsPage.tsx:730`) issues its request with no
  signal. Click a cell, change the range, and the stale detail lands over the
  new one.
- `loadTrack` (`HistoryPage.tsx:609`) likewise. Toggling a track off while its
  request is in flight still inserts it on arrival.
- `!navigator.onLine` is read during render (`InsightsPage.tsx:824`). It is not
  reactive, so the offline notice neither appears when connectivity drops nor
  clears when it returns — it only reflects whatever was true at the last
  unrelated render.

**Approach.** Carry an `AbortController` for the first two, aborting on the next
selection and on unmount. For the third, subscribe to the `online`/`offline`
window events through a small `useOnline` hook.

**Files.** `apps/web/src/pages/InsightsPage.tsx`,
`apps/web/src/pages/HistoryPage.tsx`, new `apps/web/src/lib/use-online.ts`,
tests alongside.

**Acceptance.**
- A superseded coverage-cell or track request never lands in state.
- The offline notice appears and clears as connectivity changes, without a
  navigation.

---

## Priority 3 — Consistency and hardening

### 43. Chart bars scroll the page when activated with Space — **S**

- [ ] Implement

**Problem.** The activity chart's `<rect role="button" tabIndex={0}>` handlers
(`InsightsPage.tsx:193` and `:218`) call `onSelect` on `Enter` or `' '` but never
`preventDefault()`. `Space` on a non-button element is a page scroll, so a
keyboard reader who activates a bar gets the drill-down *and* a jump down the
page — which, since the drill-down scrolls the result into view, lands them
somewhere neither action intended.

**Approach.** `preventDefault()` on the Space branch. Check the range chart
(`RangeProfile.tsx`) and the pattern grid (`ActivityPattern.tsx`) for the same
shape while in there.

**Acceptance.** The e2e axe pass stays clean, and activating a bar with Space
does not scroll.

---

### 44. The airport dataset cannot refresh into a mounted map — **S**

- [ ] Implement

**Problem.** Two independent guards each prevent a refresh from reaching a map
that is already on screen:

- `useAirports` runs its fetch in an effect with `[]` dependencies
  (`use-airports.ts:46`), so `invalidateAirports()` clearing the module cache has
  no effect on a mounted consumer.
- The airport layer effect returns early if `map.getSource(AIRPORT_SOURCE)`
  exists (`RadarMap.tsx:1428`), so a changed `airports` prop is ignored.

It works today only because the operator downloads on Settings and *navigates*
to Live, which remounts both. That is load-bearing behaviour resting on two
comments that each describe a different reason for the guard. Item 14's own
regression (`42f9374`) was this class of problem.

**Approach.** Give `useAirports` a module-level subscription so
`invalidateAirports` can notify mounted consumers, and make the layer effect
update the source data when `airports` changes rather than returning early — the
`getSource` guard should cover only re-adding layers, not re-supplying data.

**Acceptance.**
- Downloading on Settings updates an already-open Live map in another tab on its
  next read, without a navigation.
- A deployment with no airport data still gets no layer and no OurAirports
  credit, per item 14.

---

### 45. Router location diverges from the address bar — **S**

- [ ] Implement

**Problem.** `HistoryPage.writeUrl` calls `window.history.replaceState` directly
(`HistoryPage.tsx:727`). The Router only listens for `popstate`
(`router.tsx:34`), so its `search` goes stale the moment replay advances. That
is deliberate — routing on it would re-trigger the search — but it means
`useLocation().search` is not the URL, and code that assumes it is will be
subtly wrong. `LivePage` already works around it by reading
`window.location.search` directly (`LivePage.tsx:96`, `:98`).

**Approach.** Give the Router an explicit `replaceSilently` that updates the
address bar without publishing, and use it from `writeUrl`. The behaviour is
unchanged; what changes is that the divergence is named and deliberate rather
than a side effect two pages happen to rely on.

**Acceptance.** Replay still writes the URL without re-searching, and the two
`window.location.search` reads on Live can go through the router.

---

### 46. Write down the airport-import fetch surface — **S**

- [ ] Implement

**Problem.** `POST /api/v1/airports/refresh` makes the server fetch an arbitrary
operator-supplied URL (`services/airports.ts:148`) with no restriction on host
or address range, and the endpoint is unauthenticated like everything else. On
the trusted-LAN deployment model that is in scope and consistent with
`metadataUrl`, which does the same. But it is the first such fetch reachable
from a *button* rather than a CLI, and the reasoning is currently only implicit.

The download hardening itself is good — a fixed byte cap, a fixed timeout, a
row-count floor, and a bounded streaming read rather than `response.text()`.
What is missing is the note saying that anyone who can reach the LAN can point
the server at an internal address and read the response's shape back through the
error message.

**Approach.** A paragraph in `docs/airports.md` stating the exposure and the
deployment assumption it rests on, cross-referenced from `docs/operations.md`.
No code change; this is about not having an undocumented capability.

**Acceptance.** `docs/airports.md` names the exposure, the mitigations already in
place, and the deployment assumption, in the same voice as the rest of the docs.

---

## Not raised, and why

- **Origin and host checks, rate limiting, CSP.** `security.ts` and the
  `onRequest` hook are sound: mutations fail closed without an `Origin`, the
  limiter is per-IP with a bounded map, and the CSP names the map origins rather
  than allowing all of `https:`.
- **Maintenance.** `MaintenanceService.run` takes an advisory lock, commits each
  step separately with a clear rationale, and deletes in batches. No findings.
- **The 1 Hz path.** The three-context split in `LiveContext`, the order cache in
  `aircraft-filter.ts`, and the windowed list in `use-window-list.ts` all hold
  up. The trail buffer is bounded at both ends (`live-reducer.ts:27`).
- **Saved-view schema evolution.** Every field added after the fact carries a
  default (`newOnly`, `weekday`, `hour`, `profileAxis`, `series`), as the
  cross-cutting requirement in `plan.md` demands. Verified across all three
  surface schemas.
- **`buildSettings` completeness.** The server-managed keys it omits
  (`mapWaypoints`, `mapAirports`, `mapAirportsUpdatedAt`) are safe to omit
  because the endpoint is `PATCH` against a `.partial()` schema. Every
  operator-editable key has a field.
