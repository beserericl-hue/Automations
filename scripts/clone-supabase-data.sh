#!/usr/bin/env bash
# S10a-2 Part C: copy data from SOURCE Supabase DB to TARGET Supabase DB.
#
# Strategy: pg_dump --data-only from source, pg_restore into target.
# Excludes: auth.*, storage.* (per-project; handled in S10a-3 for storage;
# users re-log in after cutover so auth is intentionally not cloned).
#
# Usage:
#   SOURCE_DB_URL='postgresql://postgres:PASSWORD@db.faklxfakgzkpkbxfihzh.supabase.co:5432/postgres' \
#   TARGET_DB_URL='postgresql://postgres:PASSWORD@db.gvbvwcnmjkdpclcisqrr.supabase.co:5432/postgres' \
#     ./scripts/clone-supabase-data.sh
#
# Re-runs are safe (--data-only always replaces rows via --clean on restore,
# but we disable that — instead we rely on the target being empty at first
# run). For incremental sync (S10a-4 pre-cutover refresh) use --refresh.
#
# Flags:
#   --refresh : TRUNCATE target tables before restore (used for cutover
#               re-sync when target may have stale rows from a prior run).
#   --dry-run : pg_dump only, skip restore. Useful for sanity-checking.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

REFRESH=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --refresh) REFRESH=1 ;;
        --dry-run) DRY_RUN=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

: "${SOURCE_DB_URL:?SOURCE_DB_URL must be set}"
: "${TARGET_DB_URL:?TARGET_DB_URL must be set}"

for bin in pg_dump pg_restore psql; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "error: $bin not found. Install PostgreSQL client tools." >&2
        exit 1
    fi
done

# Tables to include — everything in public schema. We explicitly exclude
# the schemas we don't want (auth, storage, graphql, realtime, etc).
EXCLUDED_SCHEMAS=(auth storage graphql graphql_public realtime vault extensions net pgsodium supabase_functions _analytics _realtime)

EXCLUDE_FLAGS=()
for s in "${EXCLUDED_SCHEMAS[@]}"; do
    EXCLUDE_FLAGS+=(--exclude-schema="$s")
done

DUMP_FILE="$WORKDIR/data.dump"

echo "=== data clone ==="
echo "source: $(echo "$SOURCE_DB_URL" | sed -E 's|://[^@]+@|://***@|')"
echo "target: $(echo "$TARGET_DB_URL" | sed -E 's|://[^@]+@|://***@|')"
echo "mode:   $([ "$REFRESH" = 1 ] && echo refresh || echo initial)$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)' || true)"
echo

echo "[1/3] pg_dump --data-only from source"
pg_dump \
    --data-only \
    --format=custom \
    --no-owner \
    --no-privileges \
    --disable-triggers \
    "${EXCLUDE_FLAGS[@]}" \
    --file="$DUMP_FILE" \
    "$SOURCE_DB_URL"
echo "      wrote $(wc -c < "$DUMP_FILE" | awk '{print $1}') bytes"

if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] skipping restore"
    cp "$DUMP_FILE" "$REPO_ROOT/data.dump"
    echo "      dump saved to $REPO_ROOT/data.dump"
    exit 0
fi

if [ "$REFRESH" = 1 ]; then
    echo "[2/3] TRUNCATE public tables on target (refresh mode)"
    # List public tables and truncate CASCADE
    TABLES=$(psql --quiet --no-psqlrc --tuples-only --no-align \
        "$TARGET_DB_URL" \
        -c "SELECT string_agg('public.' || quote_ident(table_name), ', ') FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
    if [ -n "$TABLES" ] && [ "$TABLES" != " " ]; then
        psql --set=ON_ERROR_STOP=1 --quiet --no-psqlrc "$TARGET_DB_URL" \
            -c "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"
        echo "      truncated"
    else
        echo "      no tables found (fresh target)"
    fi
fi

echo "[3/3] pg_restore --data-only to target"
# --single-transaction: roll back everything if any row fails
# --no-owner / --no-privileges: Supabase target has different role model
pg_restore \
    --data-only \
    --no-owner \
    --no-privileges \
    --disable-triggers \
    --single-transaction \
    --dbname="$TARGET_DB_URL" \
    "$DUMP_FILE"
echo "      ok"

echo
echo "=== done ==="
echo "verify row counts:"
echo "  psql \"\$SOURCE_DB_URL\" -c \"SELECT 'users_v2', COUNT(*) FROM users_v2 UNION ALL SELECT 'writing_projects_v2', COUNT(*) FROM writing_projects_v2;\""
echo "  psql \"\$TARGET_DB_URL\" -c \"SELECT 'users_v2', COUNT(*) FROM users_v2 UNION ALL SELECT 'writing_projects_v2', COUNT(*) FROM writing_projects_v2;\""
