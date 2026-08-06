#!/bin/sh
set -eu

# Migrations are idempotent and protected by a PostgreSQL advisory lock. Running
# them on every start makes a newly restored or upgraded database self-healing.
node apps/server/dist/db/migrate-cli.js

# `exec node`, not `npm run start`: this process receives the SIGTERM that
# `docker compose stop` sends, and index.ts has a graceful shutdown behind it —
# draining the collector, closing the pool, ending in-flight requests. Leaving
# npm in between makes that delivery somebody else's implementation detail, for
# no benefit inside an image whose paths are fixed at build time.
exec node apps/server/dist/index.js
