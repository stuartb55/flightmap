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

Whether route inference is wanted. Aircraft photographs — the other tier-3 bet —
has shipped, and shipped the way both were scoped to: off by default, with the
disclosure written before the feature is reachable, and reversible by a switch.
That is the pattern items 28 to 30 would follow.

The trade they ask for is a different one, and larger. Photographs gave up
offline-first for a decoration an operator opts into; route inference gives up
"everything shown is observed" for a claim about where an aircraft is going,
shown next to figures the receiver actually heard. Marking inferences as
inferences is in the scoping, but the two kinds of statement end up on the same
panel either way.

If it is not wanted, say so and close this document — the delivered record in
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
