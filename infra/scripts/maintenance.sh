#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "${script_directory}/../.." && pwd)
cd -- "${project_directory}"

if docker compose exec -T app npm run db:maintenance; then
  exit 0
fi

echo "The app was not running; executing maintenance in a one-off container."
docker compose run --rm app npm run db:maintenance
