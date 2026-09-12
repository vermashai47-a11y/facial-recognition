#!/usr/bin/env bash
# Applies the shim plus every migration to a scratch database and runs the
# assertions in 01_policies.sql. Requires a local Postgres with pgvector.
set -euo pipefail

PSQL=${PSQL:-psql}
DB=${DB:-face_attendance_test}
HERE="$(cd "$(dirname "$0")" && pwd)"

$PSQL -v ON_ERROR_STOP=1 -c "drop database if exists $DB" -d postgres
$PSQL -v ON_ERROR_STOP=1 -c "create database $DB" -d postgres

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/00_supabase_shim.sql" -q

for f in "$HERE"/../migrations/*.sql; do
  echo "  applying $(basename "$f")"
  $PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$f" -q
done

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/01_policies.sql"
echo "All migrations applied and policy assertions passed."
