#!/usr/bin/env bash
# S10a-2 Part B: apply schema to a target Supabase DB.
#
# Runs, in order:
#   1. supabase_setup_v2.sql   (base 7+2 tables, RLS, triggers, functions)
#   2. writers-workbench/migrations/NNN_*.sql  in ascending numeric order
#
# Idempotent where possible:
#   - supabase_setup_v2.sql uses CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE
#   - numbered migrations assume they have not already been applied
#
# Usage:
#   TARGET_DB_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres' \
#     ./scripts/clone-supabase-schema.sh
#
# Optional: START_AT_MIGRATION=003 to skip earlier files (resume after a failure).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_SCHEMA="$REPO_ROOT/supabase_setup_v2.sql"
MIGRATIONS_DIR="$REPO_ROOT/writers-workbench/migrations"

: "${TARGET_DB_URL:?TARGET_DB_URL must be set (postgresql://... connection string)}"
START_AT_MIGRATION="${START_AT_MIGRATION:-000}"

if ! command -v psql >/dev/null 2>&1; then
    echo "error: psql not found. Install PostgreSQL client tools (e.g. 'brew install postgresql@15')." >&2
    exit 1
fi

if [ ! -f "$BASE_SCHEMA" ]; then
    echo "error: base schema file not found: $BASE_SCHEMA" >&2
    exit 1
fi

echo "=== schema clone ==="
echo "target:     $(echo "$TARGET_DB_URL" | sed -E 's|://[^@]+@|://***@|')"
echo "base:       $BASE_SCHEMA"
echo "migrations: $MIGRATIONS_DIR"
echo

# psql flags: fail fast on error, quiet output, no prompting
PSQL_FLAGS=(--set=ON_ERROR_STOP=1 --quiet --no-psqlrc)

echo "[1/N] applying supabase_setup_v2.sql"
psql "${PSQL_FLAGS[@]}" "$TARGET_DB_URL" -f "$BASE_SCHEMA"
echo "      ok"

# Apply numbered migrations in order
i=1
for f in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name "[0-9]*.sql" | sort); do
    name="$(basename "$f")"
    num="${name%%_*}"
    if [ "$num" \< "$START_AT_MIGRATION" ]; then
        echo "[skip] $name (before $START_AT_MIGRATION)"
        continue
    fi
    i=$((i + 1))
    echo "[$i] applying $name"
    psql "${PSQL_FLAGS[@]}" "$TARGET_DB_URL" -f "$f"
    echo "      ok"
done

echo
echo "=== done ==="
echo "verify with:"
echo "  psql \"\$TARGET_DB_URL\" -c \"\\dt public.*_v2\""
