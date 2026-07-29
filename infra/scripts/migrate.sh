#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "${script_directory}/../.." && pwd)
cd -- "${project_directory}"

docker compose up -d db
docker compose run --rm app npm run db:migrate
