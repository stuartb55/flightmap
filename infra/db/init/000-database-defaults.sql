\set ON_ERROR_STOP on

-- PostgreSQL creates the application database before processing init scripts.
-- Keep its time semantics deterministic; the API performs display-time-zone
-- conversion at the edge while all persisted timestamps remain UTC.
SELECT format(
  'ALTER DATABASE %I SET timezone TO %L',
  current_database(),
  'UTC'
)
\gexec

SELECT format(
  'ALTER DATABASE %I SET idle_in_transaction_session_timeout TO %L',
  current_database(),
  '60s'
)
\gexec

-- The application migration runner is the canonical schema owner. It runs from
-- the app entrypoint after PostgreSQL becomes healthy, both for first boot and
-- for upgrades. Keeping schema DDL in one place prevents init/upgrade drift.
