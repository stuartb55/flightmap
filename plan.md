# Flightmap — User Experience Enhancement Plan

Prioritised backlog of user-facing improvements for the delivered v1 application.
Authentication and security work is deliberately out of scope; the deployment
model (trusted LAN, reverse proxy for remote access) is unchanged.

Tiers 0, 1 and 2 are complete and have moved to
[`docs/delivered-enhancements.md`](docs/delivered-enhancements.md). The original
v1 build specification is [`docs/v1-build-plan.md`](docs/v1-build-plan.md) and
remains the reference for existing behaviour.

What is left is the two tier-3 bets, now scoped into items of their own. Item 20
became items 26 and 27; item 21 became items 28, 29 and 30. Each of the five is
independently shippable and the scoping questions the bets carried have been
settled below, so they are ready to implement — but read *What to decide next*
first. Both bets still trade away a property the app currently holds, and that
call has not been made.

## How to use this document

Each item is self-contained and independently shippable. Tick the checkbox when
the acceptance criteria pass and `npm run typecheck && npm run lint && npm run test`
is clean, then move the item into `docs/delivered-enhancements.md`.

Effort key: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

Item numbers are stable identifiers used in branch names and pull request
titles. Numbers 8, 11, 18 and 19 belonged to items dropped before implementation
(notifications, onboarding, in-app help, multi-receiver) and are not reused.

---

## Tier 3 — Larger bets, scoped

### 20. Aircraft photographs — **M** → items 26 and 27

The single most-requested feature in comparable apps, and the one that breaks the
offline-first rule: it requires a runtime external API. Every other data source
in the app is either local or refreshed by an operator-run import.

**How the scoping questions were settled.**

*Which source, and on what licence terms.* Not chosen in code. The source is a
deployment setting shipped empty, exactly like `metadataUrl` and
`airportDataUrl` already are (`settings.ts:84`, `:75`). The app cannot verify
anyone's terms, so pretending to by hard-coding a vendor buys nothing; what it
can do is refuse to fetch anything until an operator configures a URL and refuse
to ship pointing at a third party by default. Which source a deployment uses, and
whether its terms permit redisplay and caching, is recorded by that operator in
`docs/photos.md`. The shipped adapter expects the shape the common public
ICAO-hex photo APIs return: a JSON body carrying an image URL, a photographer
credit, and a link back.

*Storage budget and eviction.* Bytes are cached, not URLs — see item 26 for why —
with a per-image cap and a cache-entry cap, worst case a few hundred megabytes
against the 40 GB floor in `docs/disk-sizing.md`. Eviction is least-recently-
served, in the existing maintenance run.

*Where a photograph appears.* The aircraft profile only. The detail panel is on
the 1 Hz path and the answer there is no — not "carefully". Revisit as a separate
item if the profile version proves itself.

*A receiver with no internet access.* Supported and unchanged: nothing is fetched
unless enabled, a cached photograph still renders offline, and a missing one
renders as an absent panel, not an error.

---

### 26. Aircraft photograph cache and fetch service — **M**

- [ ] Implement

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

---

### 27. Photographs on the aircraft profile — **S**

- [ ] Implement

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

---

### 21. Route inference — **L** → items 28, 29 and 30

Origin/destination is not in the ADS-B payload and cannot be derived from the
receiver alone. Deriving probable routes from observed track geometry and
repeated callsign patterns against the local history is feasible and stays
offline, but it is a modelling exercise with an accuracy contract to define
before any UI is drawn.

**How the scoping questions were settled.**

*The accuracy contract.* Three named confidence tiers — *observed*, *likely*,
*possible* — with published definitions, and silence below the bottom one. No
percentage is ever shown: a decimal implies a calibration this method does not
have. Most sessions will get no answer at all, because most sessions are an
aircraft crossing the receiver's horizon at cruise, and the UI in item 30 is
built around that being the normal case rather than a failure.

*Whether item 14's airport dataset is a prerequisite.* Yes, and it is delivered.
`airportSchema` carries position, elevation and a runway list with threshold
coordinates at both ends (`contracts.ts:452`, `:470`), which is exactly what a
runway bearing needs, and `GET /api/v1/airports` already serves it. A deployment
that has never run the airport import gets no route inference and no error — the
same degradation the airport layer already has.

*Where inference runs.* A scheduled job over closed sessions, modelled on
`InsightBackfillService` (`insight-backfill.ts:117`), never the live path and
never a request handler.

*How it is evaluated.* A committed fixture set of hand-labelled sessions and an
evaluation CLI that fails when precision drops below the recorded baseline. This
is part of item 28, not a follow-up — without it there is no way to tell whether
a change to the method helped, and the method will need changing.

---

### 28. Terminal-phase route inference over closed sessions — **L**

- [ ] Implement

**Problem.** A session that starts on the ground at a nearby airport and climbs
out, or descends and lands, contains everything needed to name one end of its
route. Nothing reads that today, and the geometry is thrown away when the
position samples fall out of retention.

**Approach.**

*What counts as evidence.* For each closed session, against the airports in
`mapAirports` within range of its first and last positioned samples:

- **observed** — the session contains an `on_ground` sample, or a sample below
  500 ft above the airport's elevation, within 2 nm of the airport. This is not
  really an inference and should be labelled as the strongest thing the app can
  say.
- **likely** — full terminal geometry without ground contact: sustained climb
  (or descent) through the first (or last) samples, monotonically increasing (or
  decreasing) range to the airport, lowest sample below 4,000 ft AGL and within
  8 nm, and a ground track within ±20° of a runway bearing computed from that
  runway's threshold pair. The runway alignment is what separates this tier from
  the next, and it is why runway thresholds were worth their bytes in item 14.
- **possible** — low and climbing or descending near exactly one airport, no
  runway alignment.
- **nothing** — everything else, including the ambiguous case: if two airports
  qualify at the same tier with scores within tolerance, emit no row. Silence
  beats a coin toss, and the receiver's own coverage floor makes ties common
  where two fields sit close together.

Both ends are computed independently. A session with a `likely` origin and no
destination is the ordinary result and must be representable.

*Storage.* New migration `017_route_inference.sql`:

```
session_route_inference (
  session_id uuid PRIMARY KEY,
  icao char(6) NOT NULL,
  method_version smallint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  origin_icao text, origin_runway text, origin_confidence text,
  destination_icao text, destination_runway text, destination_confidence text,
  evidence jsonb NOT NULL
)
```

`method_version` is the tuning loop: bumping it invalidates every row and the job
recomputes over whatever history still has samples. `evidence` holds the measured
quantities behind the verdict — closest range, lowest AGL, track error against
the chosen runway — so a wrong answer can be diagnosed without the samples,
which will already have been pruned.

*Lifetime.* These rows die with their session. `MaintenanceService` deletes
`track_sessions` past the retention cutoff in batches, so add a matching delete
step keyed on the same cutoff rather than a cascading foreign key, following how
the other derived tables are pruned. What survives retention is the callsign
aggregate in item 29 — that split is deliberate: the per-session verdict is only
meaningful while its session exists, the pattern it contributes to is not.

*The job.* A new `RouteInferenceService` shaped like `InsightBackfillService`:
one run at a time, an advisory lock per batch, a `route_inference_state` row
carrying the cursor, `method_version`, status and last error, and a cursor that
walks closed sessions by `started_at`. It runs only when `routeInferenceEnabled`
is on. It reads sessions in batches and must not hold a transaction across a
batch — the pattern at `insight-backfill.ts:223` is the reference.

*Evaluation.* `npm run routes:evaluate` runs the current method over a committed
fixture set — position tracks for a few dozen sessions exported from a real
receiver, plus a labels file naming the true origin and destination for each,
established by hand — and prints precision per tier and coverage (the share of
sessions that get any answer at all). A companion `npm run routes:label` exports
a session from a live database into that fixture format, so growing the set does
not mean hand-writing JSON. The baseline figures live in `docs/routes.md` and the
CLI exits non-zero when precision falls below them, so the evaluation runs in CI
rather than in someone's memory.

**Files.** New `apps/server/src/db/migrations/017_route_inference.sql`, new
`apps/server/src/domain/routes.ts` (the pure geometry and scoring — no database,
so the evaluation CLI and the unit tests share it), new
`apps/server/src/services/route-inference.ts`, new
`apps/server/src/routes-cli.ts`, new
`apps/server/src/domain/__fixtures__/route-sessions/`,
`apps/server/src/services/maintenance.ts`, `apps/server/src/settings.ts`,
`apps/server/src/index.ts` (service wiring), `package.json` (two scripts), new
`docs/routes.md`.

**Acceptance.**
- Precision on the fixture set meets the contract: ≥ 95% for *observed*, ≥ 80%
  for *likely*, with the measured figures and the fixture count recorded in
  `docs/routes.md`. `npm run routes:evaluate` fails below the recorded baseline.
- Coverage is reported honestly, including the share of sessions that get
  nothing, and that share is not treated as a defect.
- A session crossing at cruise produces no row.
- Two candidate airports at the same tier produce no row, with a fixture case
  proving it.
- The geometry module has no database import, and `routes.ts` unit tests run
  without a container.
- The job never runs against an open session, never runs on the request path,
  and the 1 Hz snapshot is unaffected — `npm run test:load` unchanged.
- Bumping `method_version` recomputes every row without manual intervention.
- A deployment with an empty `mapAirports` produces no rows, no errors, and no
  log noise.
- Route inference rows are gone after a maintenance run once their session is.

---

### 29. Callsign route memory — **M**

- [ ] Implement

**Problem.** Item 28 can only name an end it watched. A scheduled service seen
inbound every morning and outbound every evening has both ends in the history,
just never in the same session, and today nothing joins them up.

**Approach.**

*The aggregate.* A `callsign_route_profile` table built by the same job from
`session_route_inference` joined to `track_sessions.callsigns`: callsign, the
modal origin and destination, the number of agreeing sessions, first and last
agreement, and a confidence that is never higher than *likely* however consistent
the pattern is. A pattern is evidence about a callsign, not an observation of a
flight.

*What earns a row.* At least three sessions agreeing, at least 70% agreement
among sessions that produced a verdict for that end, and a last agreement inside
the retention window so a route that changed at the timetable does not haunt the
UI for a year. Below any of those thresholds there is no row.

*What is excluded.* Callsigns that equal the airframe's registration in
`aircraft_metadata` — for most general aviation the callsign is the registration
and carries no route at all, and letting those through would produce a confident
"usual route" for an aircraft that flies wherever it likes. Exclude them
explicitly and cover it with a test.

*Survives retention.* Unlike item 28's per-session rows, these persist: the
sessions that produced them will be pruned, and the pattern is the durable part.
The counts are therefore incremental — the job adds agreement from newly inferred
sessions rather than recomputing from a history that no longer exists — and the
table needs its own aging rule (drop a profile whose last agreement is older than
a stated multiple of the retention window) rather than inheriting maintenance's
cutoff.

**Files.** New `apps/server/src/db/migrations/018_callsign_routes.sql`,
`apps/server/src/domain/routes.ts`,
`apps/server/src/services/route-inference.ts`,
`apps/server/src/services/maintenance.ts`, `apps/server/src/db/repository.ts`,
`packages/shared/src/contracts.ts`, `docs/routes.md`.

**Acceptance.**
- A callsign with three agreeing sessions gets a profile; two does not.
- A callsign matching the registration never gets a profile.
- A route that changes produces a profile that follows the change once the old
  agreements age out, and never shows both.
- Profiles survive the pruning of every session that produced them, and the
  counts stay correct across that pruning.
- Confidence never exceeds *likely*, asserted directly.
- Aging removes profiles whose last agreement is beyond the stated window.

---

### 30. Route surfaces in the UI and exports — **M**

- [ ] Implement

**Problem.** Items 28 and 29 produce answers nothing shows. This item decides
where an inferred value is allowed to appear and how it is qualified, and it is
the item where the app's "everything shown is observed" property actually
changes.

**Approach.**

*Where routes appear.* The history session detail and the session list's expanded
row; the aircraft profile's recent-sessions table as a route column, plus a
"usual route" line from the callsign profile; and the session CSV export
(`api.ts:234`), with the confidence as its own column and a header comment
stating the values are inferred.

*Where they do not.* The live table, the detail panel, and the map. Live stays
observation-only — a callsign-keyed lookup would be cheap to join but the point
is not cost, it is that the live view is the one place a reader should never have
to ask whether what they are seeing was measured. If that is later judged too
strict, it is a separate item with its own argument.

*How a value is qualified.* Every route reads as `EGCC → EGLL` with the
confidence adjacent as a word, never as a colour, an icon alone, or a percentage.
The tier words are defined once in `docs/routes.md` and used verbatim everywhere.
An end that was not inferred is `—`, exactly like every other unavailable value,
and a route with one known end renders `EGCC → —` rather than being hidden. A
pattern-derived end is labelled as such and is visibly weaker than an observed
one to a screen reader as well as on screen.

*The switch.* `routeInferenceEnabled` is a server setting defaulting to **off**,
with a Settings card that explains in prose what inference means before offering
the toggle, and links to `docs/routes.md`. Turning it on starts item 28's job,
which backfills over retained history; turning it off stops the job and hides
every surface, leaving the stored rows alone so a re-enable is instant. Shipping
this on by default would change what the app claims about itself without anyone
choosing that.

**Files.** `apps/web/src/pages/HistoryPage.tsx`,
`apps/web/src/pages/AircraftProfilePage.tsx`,
`apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/lib/adapters.ts`,
`apps/web/src/lib/api.ts`, `apps/web/src/types.ts`,
`apps/server/src/domain/exports.ts`, `apps/server/src/routes/api.ts`,
`packages/shared/src/contracts.ts`, `docs/routes.md`, e2e coverage for the
history flow.

**Acceptance.**
- With inference disabled — the default — every surface is byte-identical to
  today, and the Settings card explains what enabling would do.
- No inferred value appears anywhere without an adjacent confidence word, in the
  UI and in the export.
- Confidence is never conveyed by colour alone and is announced by a screen
  reader as part of the value it qualifies.
- A session with one inferred end renders that end and `—` for the other; a
  session with none renders `—`, never a blank cell or a `0`.
- The exported CSV states that the columns are inferred and keeps ft/kt/nm.
- Disabling the feature hides every surface within a page load and leaves the
  stored rows intact; re-enabling shows them again without a backfill.
- The e2e axe pass stays clean in both themes with routes present and absent.

---

## Explicitly not planned

- Authentication, user accounts, and per-user permissions — deployment model
  unchanged, and out of scope by request.
- External notification transports (email, push services, Discord, webhooks).
- Public/internet-facing hosting affordances.
- Any runtime dependency on a third-party API in the default configuration.
  Item 26 stays inside this: shipped off, with no source configured.
- Notifications, including any revival of first-seen alerting (migration
  `009_focused_alerts.sql`). Item 24 is passive marking, not alerting.
- Photographs in the live detail panel, and routes anywhere on the live path.
  Both were considered and declined in items 20 and 30; either would be a new
  item with its own argument, not an extension of these.

---

## What to decide next

Whether tier 3 is wanted at all. The scoping is done and the items are ready, but
both bets trade away a property the app currently holds — offline-first for items
26 and 27, "everything shown is observed" for items 28 to 30 — and that is a
product decision, not a scheduling one.

Both are built so the trade is opt-in and reversible: shipped off, with the
disclosure written before the feature is reachable. That lowers the stakes of
saying yes; it does not remove the decision, because a default-off feature nobody
turns on is still work.

If only one is wanted, items 26 and 27 are the smaller, more certain win. If
neither is, say so and close this document — the delivered record in
`docs/delivered-enhancements.md` stands on its own.

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
- Anything inferred, or fetched from outside this network, is labelled as such
  wherever it appears — including in exports — and is off until an operator
  turns it on.
- New preferences fail safe: corrupt or absent storage falls back to defaults
  without blocking live data (see `storedFilters`, `LivePage.tsx`).
- Any addition to a `.strict()` shared schema carries a default, so saved views
  and stored preferences written before it still parse (`allTrails` in
  `contracts.ts` is the precedent). Operator-editable settings additionally need
  a field in `buildSettings` (`SettingsPage.tsx:59`) or the form's next save
  reverts them.
- Unit and component tests alongside the change; e2e coverage for anything that
  alters a primary user flow.
- `npm run typecheck`, `npm run lint`, `npm run test:coverage`, and
  `npm run build` all pass.
