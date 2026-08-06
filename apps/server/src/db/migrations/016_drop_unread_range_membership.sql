-- `daily_range_histogram_aircraft` was written on every 1 Hz snapshot and by
-- every backfilled day, and read by nothing: the range profile reads only the
-- aggregate `daily_range_histogram`. It cost a five-column primary-key insert
-- per (day, bearing bucket, altitude band, range bucket, aircraft), forever,
-- and no retention step ever removed a row.
--
-- Its sibling `daily_coverage_cell_aircraft` is kept: the coverage map's
-- unique-aircraft counts and the cell drill-down both read it.

DROP TABLE IF EXISTS daily_range_histogram_aircraft;
