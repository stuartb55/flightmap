/*
 * All-time receiver records read straight off the aggregates that are retained
 * indefinitely — `daily_aircraft_summary` and `aircraft_summary` — long after
 * the detailed tracks behind them have expired.
 *
 * Every record is one row: the largest or smallest value of one column across
 * the whole table. Without an index ordered by that column each is a
 * sequential scan of a year of daily rows, so each measure gets its own.
 * The indexes are partial where the column is nullable: a day with no
 * positioned report has no range and no altitude, and those rows can never win.
 */
CREATE INDEX IF NOT EXISTS daily_aircraft_summary_max_range_idx
  ON daily_aircraft_summary (maximum_range_nm DESC)
  WHERE maximum_range_nm IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_aircraft_summary_max_altitude_idx
  ON daily_aircraft_summary (maximum_altitude_ft DESC)
  WHERE maximum_altitude_ft IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_aircraft_summary_closest_idx
  ON daily_aircraft_summary (closest_range_nm)
  WHERE closest_range_nm IS NOT NULL;

/* Both columns are NOT NULL, so the span is always defined. */
CREATE INDEX IF NOT EXISTS daily_aircraft_summary_contact_span_idx
  ON daily_aircraft_summary ((last_seen_at - first_seen_at) DESC);

CREATE INDEX IF NOT EXISTS aircraft_summary_observations_idx
  ON aircraft_summary (total_observations DESC);

/*
 * There is deliberately no index for the busiest day. It totals every day's
 * rows before it can rank them, so it reads the whole aggregate whatever is
 * indexed, and a covering index on (summary_date) INCLUDE (observations)
 * measured within a few percent of the sequential scan — close enough that the
 * planner picks either, which makes it an index that is written on every
 * insert and used on a coin toss. The grouped scan is around twenty
 * milliseconds over a year of daily rows, which the endpoint can afford.
 */
