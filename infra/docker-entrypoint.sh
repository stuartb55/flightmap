#!/bin/sh
set -eu

# Migrations are idempotent and protected by a PostgreSQL advisory lock. Running
# them on every start makes a newly restored or upgraded database self-healing.
npm run db:migrate

exec npm run start --workspace @flightmap/server
