# Flightmap — User Experience Enhancement Plan

Prioritised backlog of user-facing improvements for the delivered v1 application.
Authentication and security work is deliberately out of scope; the deployment
model (trusted LAN, reverse proxy for remote access) is unchanged.

Tiers 0, 1 and 2 are complete and have moved to
[`docs/delivered-enhancements.md`](docs/delivered-enhancements.md). The original
v1 build specification is [`docs/v1-build-plan.md`](docs/v1-build-plan.md) and
remains the reference for existing behaviour.

What is left is the two tier-3 bets below. Neither should start until it has
been scoped into numbered items of its own.

## How to use this document

Each item is self-contained and independently shippable. Tick the checkbox when
the acceptance criteria pass and `npm run typecheck && npm run lint && npm run test`
is clean, then move the item into `docs/delivered-enhancements.md`.

Effort key: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

Item numbers are stable identifiers used in branch names and pull request
titles. Numbers 8, 11, 18 and 19 belonged to items dropped before implementation
(notifications, onboarding, in-app help, multi-receiver) and are not reused.

The tier-3 notes below are scoping input, not a specification; any line
references in them predate the phase-3 releases and have drifted.

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

## What to decide next

Whether tier 3 is wanted at all. Both items trade away a property the app
currently holds — offline-first for item 20, "everything shown is observed" for
item 21 — and that is a product decision, not a scheduling one.

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
