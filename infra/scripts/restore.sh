#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 /path/to/flightmap.dump --confirm" >&2
  echo "This replaces the current Flightmap database." >&2
}

if [ "$#" -ne 2 ] || [ "$2" != "--confirm" ]; then
  usage
  exit 2
fi

archive_path=$1
if [ ! -f "${archive_path}" ]; then
  echo "Backup not found: ${archive_path}" >&2
  exit 2
fi

archive_directory=$(CDPATH= cd -- "$(dirname -- "${archive_path}")" && pwd)
archive_name=$(basename -- "${archive_path}")
archive_path="${archive_directory}/${archive_name}"
checksum_name="${archive_name}.sha256"
if [ -f "${archive_directory}/${checksum_name}" ]; then
  echo "Verifying SHA-256..."
  if command -v sha256sum > /dev/null 2>&1; then
    (
      cd -- "${archive_directory}"
      sha256sum --check "${checksum_name}"
    )
  elif command -v shasum > /dev/null 2>&1; then
    (
      cd -- "${archive_directory}"
      shasum -a 256 --check "${checksum_name}"
    )
  else
    echo "Warning: checksum exists but no SHA-256 utility is installed." >&2
  fi
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "${script_directory}/../.." && pwd)
cd -- "${project_directory}"

echo "Validating archive..."
docker compose up -d db

ready=false
attempt=0
while [ "${attempt}" -lt 30 ]; do
  if docker compose exec -T db sh -c \
    'pg_isready --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > /dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "${ready}" != "true" ]; then
  echo "PostgreSQL did not become ready within 30 seconds." >&2
  exit 1
fi

archive_listing=$(docker compose exec -T db pg_restore --list < "${archive_path}")
case "${archive_listing}" in
  *" DATABASE "*) ;;
  *)
    echo "Archive has no CREATE DATABASE entry; refusing an ambiguous restore." >&2
    echo "Use a backup produced by infra/scripts/backup.sh." >&2
    exit 1
    ;;
esac

echo "Stopping the application before destructive restore..."
docker compose stop app > /dev/null

echo "Replacing the current database..."
if ! docker compose exec -T db sh -c \
  'exec pg_restore \
    --username="$POSTGRES_USER" \
    --dbname=postgres \
    --clean \
    --if-exists \
    --create \
    --exit-on-error \
    --no-owner \
    --no-privileges' < "${archive_path}"; then
  echo "Restore failed. The application remains stopped for inspection." >&2
  exit 1
fi

echo "Starting the application and applying any newer migrations..."
docker compose up -d app
echo "Restore submitted. Follow readiness with: docker compose ps"
