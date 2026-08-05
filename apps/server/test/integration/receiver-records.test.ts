import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import {
  createTestDatabase,
  describeDatabase,
  repository,
  resetDatabase
} from "./harness.js";

/**
 * A year of daily aggregates at a plausible width for a busy receiver: 400
 * airframes heard a day, twenty thousand distinct over the year. Small enough
 * to seed in a couple of seconds, large enough that the planner has a real
 * choice to make — which is the only way asserting the plan means anything.
 *
 * Every measure varies with the day so each record has one unambiguous winner,
 * and the winners are spread deliberately: the farthest, highest and longest
 * land on the oldest day, outside any sane detailed retention, while the
 * closest approach and the busiest day land on the newest.
 */
const DAYS = 365;
const AIRCRAFT_PER_DAY = 400;
const DISTINCT_AIRCRAFT = 20_000;

async function seedYear(database: Database): Promise<void> {
  await database.query(
    `INSERT INTO daily_aircraft_summary (
       summary_date, icao, first_seen_at, last_seen_at, observations,
       positioned_observations, session_count, minimum_altitude_ft,
       maximum_altitude_ft, maximum_ground_speed_kt, closest_range_nm,
       maximum_range_nm, callsigns
     )
     SELECT
       (CURRENT_DATE - day)::date,
       lpad(to_hex(100000 + ((day * $2 + aircraft) % $3)), 6, '0'),
       (CURRENT_DATE - day)::timestamptz,
       (CURRENT_DATE - day)::timestamptz + make_interval(secs => 600 + day),
       100 + ($1 - day),
       50,
       1,
       1000,
       (10000 + day)::double precision,
       300,
       (1 + day * 0.01)::double precision,
       (50 + day * 0.5)::double precision,
       ARRAY['TST' || aircraft]
     FROM generate_series(1, $1) AS day,
          generate_series(1, $2) AS aircraft`,
    [DAYS, AIRCRAFT_PER_DAY, DISTINCT_AIRCRAFT]
  );
  await database.query(
    `INSERT INTO aircraft_summary (
       icao, first_seen_at, last_seen_at, total_observations, session_count,
       closest_range_nm, latest_callsign, latest_registration, latest_type_code,
       latest_operator
     )
     SELECT lpad(to_hex(100000 + aircraft), 6, '0'),
            (CURRENT_DATE - $1::int)::timestamptz, CURRENT_DATE::timestamptz,
            1000 + aircraft, 10, 5, 'TST' || aircraft,
            'G-T' || aircraft, 'A320', 'Test Air'
     FROM generate_series(0, $2 - 1) AS aircraft`,
    [DAYS, DISTINCT_AIRCRAFT]
  );
  /*
   * VACUUM as well as ANALYZE: an index-only scan needs the visibility map,
   * and a table that has only ever been inserted into has none until it is
   * vacuumed. Autovacuum does this in production; the test has to ask.
   */
  await database.query("VACUUM ANALYZE daily_aircraft_summary, aircraft_summary");
}

/** The statements the repository issues, for EXPLAIN to plan. */
const recordLookupsSql = `WITH farthest AS (
    SELECT 'farthest_contact'::text AS kind, icao, summary_date::text AS occurred_on,
           maximum_range_nm AS value
    FROM daily_aircraft_summary
    WHERE maximum_range_nm IS NOT NULL
    ORDER BY maximum_range_nm DESC LIMIT 1
  ), highest AS (
    SELECT 'highest_altitude', icao, summary_date::text,
           maximum_altitude_ft AS value
    FROM daily_aircraft_summary
    WHERE maximum_altitude_ft IS NOT NULL
    ORDER BY maximum_altitude_ft DESC LIMIT 1
  ), closest AS (
    SELECT 'closest_approach', icao, summary_date::text,
           closest_range_nm AS value
    FROM daily_aircraft_summary
    WHERE closest_range_nm IS NOT NULL
    ORDER BY closest_range_nm LIMIT 1
  ), longest AS (
    SELECT 'longest_contact', icao, summary_date::text,
           extract(epoch FROM (last_seen_at - first_seen_at)) AS value
    FROM daily_aircraft_summary
    ORDER BY (last_seen_at - first_seen_at) DESC LIMIT 1
  ), most_observed AS (
    SELECT 'most_observed_airframe', icao,
           (last_seen_at AT TIME ZONE 'UTC')::date::text,
           total_observations::double precision AS value
    FROM aircraft_summary
    WHERE total_observations > 0
    ORDER BY total_observations DESC LIMIT 1
  ), records AS (
    SELECT * FROM farthest
    UNION ALL SELECT * FROM highest
    UNION ALL SELECT * FROM closest
    UNION ALL SELECT * FROM longest
    UNION ALL SELECT * FROM most_observed
  )
  SELECT r.kind, r.icao, r.occurred_on, r.value, m.registration, s.latest_registration
  FROM records r
  LEFT JOIN aircraft_metadata m ON m.icao = r.icao
  LEFT JOIN aircraft_summary s ON s.icao = r.icao`;

const busiestDaySql = `SELECT summary_date::text AS occurred_on,
                              sum(observations)::double precision AS value
                       FROM daily_aircraft_summary
                       GROUP BY summary_date
                       ORDER BY value DESC LIMIT 1`;

async function explain(database: Database, sql: string): Promise<string> {
  const explained = await database.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`
  );
  return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function executionMs(plan: string): number {
  return Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? Number.NaN);
}

describeDatabase("receiver records", () => {
  let database: Database;

  beforeAll(async () => {
    ({ database } = await createTestDatabase());
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await resetDatabase(database);
  });

  it("explains an empty receiver rather than reporting records of zero", async () => {
    const response = await repository(database).receiverRecords();
    expect(response.records).toEqual([]);
    expect(response.availableFrom).toBeNull();
  });

  it("reads every record off the indefinitely retained aggregates", async () => {
    await seedYear(database);
    const response = await repository(database).receiverRecords();
    const byKind = new Map(response.records.map((record) => [record.kind, record]));
    expect([...byKind.keys()]).toEqual([
      "farthest_contact",
      "highest_altitude",
      "closest_approach",
      "longest_contact",
      "busiest_day",
      "most_observed_airframe"
    ]);

    expect(byKind.get("farthest_contact")?.value).toBeCloseTo(50 + DAYS * 0.5, 6);
    expect(byKind.get("highest_altitude")?.value).toBe(10_000 + DAYS);
    expect(byKind.get("closest_approach")?.value).toBeCloseTo(1.01, 6);
    expect(byKind.get("longest_contact")?.value).toBe(600 + DAYS);
    // The newest day carries the most observations, by construction.
    expect(byKind.get("busiest_day")?.value).toBe(AIRCRAFT_PER_DAY * (100 + DAYS - 1));
    expect(byKind.get("busiest_day")?.icao).toBeNull();
    expect(byKind.get("most_observed_airframe")?.value).toBe(1000 + DISTINCT_AIRCRAFT - 1);

    // Identity is resolved from the summary the record was read from.
    const farthest = byKind.get("farthest_contact");
    expect(farthest?.icao).toMatch(/^[0-9a-f]{6}$/);
    expect(farthest?.label).toMatch(/^G-T/);
    expect(farthest?.secondary).toBe("A320 · Test Air");

    const oldest = await database.query<{ oldest: string }>(
      "SELECT min(summary_date)::text AS oldest FROM daily_aircraft_summary"
    );
    expect(response.availableFrom).toBe(oldest.rows[0]!.oldest);
  });

  it("marks records outside detailed retention so the link can degrade", async () => {
    await seedYear(database);
    // Thirty days of detailed retention against a year of aggregates: the
    // record itself is kept for ever, the track behind it is not.
    const response = await repository(database, {
      historyRetentionDays: 30
    }).receiverRecords();
    const byKind = new Map(response.records.map((record) => [record.kind, record]));

    const farthest = byKind.get("farthest_contact")!;
    expect(farthest.occurredOn < response.detailedFrom).toBe(true);
    expect(farthest.detailedTrackAvailable).toBe(false);

    const busiest = byKind.get("busiest_day")!;
    expect(busiest.occurredOn >= response.detailedFrom).toBe(true);
    expect(busiest.detailedTrackAvailable).toBe(true);
  });

  it("answers from indexes rather than scanning a year of aggregates", async () => {
    await seedYear(database);
    const seeded = await database.query<{ rows: string }>(
      "SELECT count(*)::text AS rows FROM daily_aircraft_summary"
    );
    expect(Number(seeded.rows[0]!.rows)).toBe(DAYS * AIRCRAFT_PER_DAY);

    // The five single-row records are lookups, not scans: each is served by
    // the index migration 015 adds for its measure, and none of them touches
    // the aggregate beyond the one row it wants.
    const lookups = await explain(database, recordLookupsSql);
    expect(lookups, lookups).not.toMatch(/Seq Scan on daily_aircraft_summary\b/);
    expect(lookups, lookups).not.toMatch(/Seq Scan on aircraft_summary\b/);
    for (const index of [
      "daily_aircraft_summary_max_range_idx",
      "daily_aircraft_summary_max_altitude_idx",
      "daily_aircraft_summary_closest_idx",
      "daily_aircraft_summary_contact_span_idx",
      "aircraft_summary_observations_idx"
    ]) {
      expect(lookups, lookups).toContain(index);
    }

    /*
     * The busiest day is the exception, and knowingly so: it totals every
     * day's rows before it can rank them, so it reads the whole aggregate
     * whatever is indexed. What it must never do is reach past the aggregates
     * into the samples they were built from.
     */
    const busiest = await explain(database, busiestDaySql);
    expect(busiest, busiest).not.toMatch(/position_samples/);
    expect(executionMs(busiest), busiest).toBeLessThan(60);

    // The two run concurrently, so the slower of them is what the endpoint
    // costs; summing them is the pessimistic reading and still clears it.
    expect(
      executionMs(lookups) + executionMs(busiest),
      `${lookups}\n\n${busiest}`
    ).toBeLessThan(100);
  });
});
