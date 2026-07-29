# Database bootstrap

`000-database-defaults.sql` is executed only when PostgreSQL creates a new data
volume. It establishes UTC and a defensive idle-transaction timeout.

Application DDL lives in `apps/server/src/db/migrations`. The app container runs
`npm run db:migrate` before every start, so the same idempotent, advisory-locked
migration path handles a blank database, an existing installation, and a
restored backup. Do not copy application DDL into this directory: PostgreSQL
init scripts are not rerun for existing volumes and a duplicate schema would
eventually drift.
