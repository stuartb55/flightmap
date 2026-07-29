#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "${script_directory}/../.." && pwd)
output_directory=${1:-"${project_directory}/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="flightmap-${timestamp}.dump"
backup_path="${output_directory}/${backup_name}"
partial_path="${backup_path}.partial"

mkdir -p -- "${output_directory}"
cd -- "${project_directory}"

cleanup_partial() {
  rm -f -- "${partial_path}"
}
trap cleanup_partial EXIT HUP INT TERM

echo "Writing ${backup_path}"
docker compose exec -T db sh -c \
  'exec pg_dump \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --compress=9 \
    --create \
    --no-owner \
    --no-privileges' > "${partial_path}"

# Fail before publishing the file if PostgreSQL cannot read the archive.
docker compose exec -T db pg_restore --list < "${partial_path}" > /dev/null
mv -- "${partial_path}" "${backup_path}"
trap - EXIT HUP INT TERM

if command -v sha256sum > /dev/null 2>&1; then
  (
    cd -- "${output_directory}"
    sha256sum "${backup_name}" > "${backup_name}.sha256"
  )
elif command -v shasum > /dev/null 2>&1; then
  (
    cd -- "${output_directory}"
    shasum -a 256 "${backup_name}" > "${backup_name}.sha256"
  )
fi

echo "Backup complete: ${backup_path}"
