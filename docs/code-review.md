# Code review backlog

Full-codebase review of 2026-08-03 (commit `2e71d36`). Covers the Fastify
server, shared contracts, React web app, SQL migrations, infrastructure, and CI.

Baseline at the time of review: `npm run lint`, `npm run typecheck`, and all 156
unit tests pass. The findings below are about scale, hot-path cost, and test
coverage rather than broken behaviour.

Authentication and user profiles are deliberately out of scope; the security
items assume the documented trusted-LAN model.

---

## P1 — Fix first (scale and reliability on the 1 Hz hot path)

- [x] **1. Live "deltas" are full snapshots, and the replay buffer keeps 512 of
      them.** `db/repository.ts:806` returns `upserts: uniqueAircraft` — every
      aircraft in the snapshot, not the changed ones — and
      `realtime/live-hub.ts:42-43` retains 512 such deltas.
      At ~1.1 kB per aircraft and 250 aircraft this is **~270 kB/s per connected
      client**, and the replay window holds ~128,000 aircraft objects
      (**~130 MB+** of heap; 8.5 minutes of history no client will replay).
      `routes/websocket.ts:57` additionally re-runs `JSON.stringify` per client
      per delta.
      *Fix:* diff against the previous snapshot before publishing; bound the
      history by aircraft count or bytes (or reduce the limit to ~60);
      serialise once in `publish()` and hand the same string to every sink.

- [x] **2. Retention maintenance is one transaction under a 60 s query timeout.**
      `services/maintenance.ts:49-124` performs session closure, partition
      `DROP TABLE`s, and four unbatched `DELETE`s in a single transaction, while
      `db/database.ts:32-33` sets `statement_timeout`/`query_timeout` to 60 s.
      One slow `DELETE` aborts the whole run — including the partition drops
      that actually reclaim disk — and it is not retried for 24 hours. The
      `DROP TABLE`s hold ACCESS EXCLUSIVE locks for the transaction's full
      duration, stalling the collector.
      *Fix:* one transaction per step; batched deletes (`LIMIT`ed `ctid` loops);
      partition drops first and committed separately; a short retry on failure.

- [x] **3. Unbounded `aircraft_icaos[]` arrays rewritten every second.**
      `db/repository.ts:1216-1219` (coverage cells) and `1263-1264` (range
      histogram) read, concatenate, `DISTINCT`, and rewrite the entire array on
      every snapshot. A busy 0.05° cell accumulates hundreds to thousands of
      ICAOs per day, so the per-second cost grows through the day and only
      resets at midnight UTC. This is the worst write-amplification pattern in
      ingestion (plus TOAST churn).
      *Fix:* a normalised `(coverage_date, cell, icao)` unique table or an
      approximate distinct counter; keep the aggregate row to counters only.

- [ ] **4. The server exits at boot if PostgreSQL is briefly unreachable.**
      `index.ts:14-18` awaits `settings.load()` at module top level with no
      guard, before `app.listen()`. The process dies, so `/health/live` and
      `/health/ready` never answer and a database blip is indistinguishable from
      an application crash — contradicting the `not_ready` contract in
      `routes/api.ts:66-73`.
      *Fix:* bind the HTTP server first, then load settings with retry, and let
      `/health/ready` report `not_ready` until it succeeds.

- [ ] **5. Single-aircraft lookups load the whole live table.**
      `db/repository.ts:1409-1411` (`aircraftDetail`) and `:2701`
      (`previewCustomAlertRule`), plus `routes/api.ts:268`, `:282`, `:297`, and
      `:315`, all call `liveAircraft()` — which runs a per-row `EXISTS`
      subquery over `alert_events` for every current aircraft — to find one
      ICAO.
      *Fix:* add a `liveAircraft(icao?)` variant with a `WHERE c.icao = $n`
      predicate.

---

## P2 — Performance

- [ ] **6. Free-text search has no usable index on the tables that grow
      forever.** `db/repository.ts:1849-1855` (`summaries`) runs
      `ILIKE '%…%'` against `d.icao`, `array_to_string(d.callsigns,' ')`, and
      metadata columns over `daily_aircraft_summary`, which is retained
      indefinitely and has no trigram index. `sessions()` (`:1498-1512`) has the
      same shape: the GIN index on `callsigns` cannot serve
      `array_to_string(...) ILIKE`, and `type_code` has no trigram index —
      `002_search_indexes.sql` covers only registration, description, and
      operator. Search degrades permanently as history accumulates.

- [ ] **7. `position_samples_time_idx` is redundant.**
      `db/migrations/001_initial.sql:88` — the primary key already leads with
      `recorded_at` and the table is range-partitioned on it. On the
      highest-volume table in the system this is pure write cost and disk.

- [ ] **8. The insights leaderboard query is quadratic.**
      `db/repository.ts:2073-2083` and `:2094-2100` run correlated subqueries
      per ICAO against the filtered CTE. Over a 366-day range with thousands of
      distinct aircraft this is the slowest query in the app.
      *Fix:* rewrite as a single grouped aggregate.

- [ ] **9. Stale-aircraft cleanup runs twice per second.**
      `ingestion/collector.ts:225` (after each snapshot) and `:331` (health
      loop). One is enough.

- [ ] **10. The live table re-renders every row every second.**
      `state/LiveContext.tsx:224-227` builds a new context value per delta, and
      `components/AircraftTable.tsx` has no `React.memo`, no row memoisation,
      and no virtualisation. At 250 aircraft this reconciles thousands of nodes
      at 1 Hz.
      *Fix:* memoise rows on `icao` + `recordedAt`; split the context so map and
      table consumers do not both wake on every field.

---

## P3 — Security hardening (within the no-auth LAN model)

- [ ] **11. Mutations pass when the `Origin` header is absent.**
      `app.ts:90-91` checks the origin only `if (request.headers.origin)`.
      Browsers always send it cross-origin so exploitability is low, but this
      should fail closed. One-line fix.

- [ ] **12. Rate limiting collapses behind the recommended reverse proxy.**
      `app.ts:52` sets `trustProxy: false`, so `request.ip` is the proxy's
      address and every remote user shares one 300/min bucket (`app.ts:55-57`).
      Either document this or make `trustProxy` configurable.

- [ ] **13. `receiverBaseUrl` and `metadataUrl` accept any URL scheme.**
      `settings.ts:20` and `:44` — Zod's `.url()` permits `file:`, `gopher:`,
      and friends. Restrict to `http`/`https` explicitly.

- [ ] **14. CSP is broader than it needs to be.** `app.ts:114-115` allows all of
      `http:` and `https:` in `connect-src` and `img-src` to accommodate an
      arbitrary map style URL.
      *Fix:* derive the allowed origin from the configured `mapStyleUrl` at
      render time.

- [ ] **15. No cap on concurrent WebSocket connections.** Only 30 *new*
      connections per minute per IP are limited (`app.ts:57`). Combined with
      item 1, a handful of stuck clients is expensive.

---

## P4 — Testing gaps

- [ ] **16. The 3,044-line repository — every line of SQL in the product — is
      never executed against PostgreSQL in CI.** `test/repository.test.ts` mocks
      `database.query` and asserts on SQL substrings. Coverage thresholds are
      48% for the server and **13%** for the web app (`vitest.config.ts` in each
      workspace). The Playwright suite exercises happy paths against a live
      stack, but ingestion edge cases — session gap boundaries, duplicate
      snapshots, partition rollover, retention cutoffs, insight aggregation —
      have no executable proof.
      *Fix:* a PostgreSQL-backed integration suite (CI service container or
      Testcontainers) for `ingestSnapshot`, session lifecycle, maintenance, and
      the insight aggregates. Raise web thresholds toward 40%+.

- [ ] **17. Maintenance and insight backfill have no test against realistic data
      volumes** — exactly the code paths behind items 2 and 3.

---

## P5 — Maintainability

- [ ] **18. `db/repository.ts` is 3,044 lines** mixing ingestion, live queries,
      history, insights, alerts, saved views, and status. Split by domain
      (`ingest/`, `history/`, `insights/`, `alerts/`).

- [ ] **19. Duplicated CSV column mapping in `services/metadata.ts`.**
      `parseMetadataCsv` (`:63-137`) and `columnsFor`/`recordFromRow`
      (`:154-212`) implement the same logic twice and are free to drift.

- [ ] **20. Alert rule preview does not match ingestion.**
      `db/repository.ts:2702` uses `onGround ? 0 : baro ?? geom`, while
      ingestion (`:591`) uses `analyticalAltitudeFt(...)` with hysteresis.
      Previews disagree with real alerts on altitude predicates.

- [ ] **21. Manchester is hardcoded.** `components/RadarMap.tsx:576` (waypoint
      layer) and `config.ts` (default receiver coordinates 53.61 / -2.31) in an
      otherwise receiver-agnostic application. Make waypoints a config or data
      concern.

- [ ] **22. `styles.css` is 5,714 lines** in a single file.

- [ ] **23. `icao char(6)` forces `.trim()` at roughly 20 call sites**; one
      missed trim is a silent mismatch bug. Migrate the column to `text`.

- [ ] **24. Runtime settings need a page reload.** `apps/web/src/config.ts`
      reads the injected meta tag once at module load, so changing map style,
      time zone, or range rings in Settings does not take effect until refresh.

- [ ] **25. `.idea/` is committed to the repository.**

---

## Suggested order

Items 1 and 5 give the highest value per hour — both are contained changes with
large runtime effect. Items 2 and 4 are the next reliability wins. Item 16 is
what stops this list from regrowing: without executable coverage of the SQL
layer, the P2 rewrites carry real risk.
