#!/bin/bash
# Test suite for scripts/check-base-table-immutability.py
#
# Uses a temp workspace so we never mutate real migrations. Exits non-zero
# if any assertion fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-base-table-immutability.py"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Mirror the layout the script expects: <tmp>/writers-workbench/migrations/
MIGRATIONS="$TMPDIR/writers-workbench/migrations"
mkdir -p "$MIGRATIONS"

# Copy real migrations + baseline hashes into the fake workspace
cp "$REPO_ROOT/writers-workbench/migrations/".*.json "$MIGRATIONS/"
cp "$REPO_ROOT/writers-workbench/migrations/"*.sql "$MIGRATIONS/"

# Build a script copy that points REPO_ROOT at our temp dir
TMP_SCRIPT="$TMPDIR/check.py"
# Rewrite the REPO_ROOT line so the script checks our fake migrations dir.
sed "s|REPO_ROOT = Path(__file__).resolve().parent.parent|REPO_ROOT = Path(r'''$TMPDIR''')|" "$CHECK_SCRIPT" > "$TMP_SCRIPT"

pass=0
fail=0

assert_exit() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  ok   — $label"
        pass=$((pass + 1))
    else
        echo "  FAIL — $label (expected exit $expected, got $actual)"
        fail=$((fail + 1))
    fi
}

restore_migrations() {
    rm -f "$MIGRATIONS"/*.sql
    cp "$REPO_ROOT/writers-workbench/migrations/"*.sql "$MIGRATIONS/"
}

echo "Test 1: clean repo passes"
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "clean state" 0 "$rc"

echo "Test 2: adding ALTER TABLE on base table in migration 010 fails"
cat > "$MIGRATIONS/010_bad_alter.sql" <<'SQL'
-- Feature X: add preferences column
ALTER TABLE users_v2 ADD COLUMN preferences jsonb;
SQL
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "ALTER TABLE users_v2 in 010" 1 "$rc"
rm "$MIGRATIONS/010_bad_alter.sql"

echo "Test 3: adding DROP TABLE on base table fails"
cat > "$MIGRATIONS/011_bad_drop.sql" <<'SQL'
DROP TABLE IF EXISTS story_arcs_v2;
SQL
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "DROP TABLE story_arcs_v2 in 011" 1 "$rc"
rm "$MIGRATIONS/011_bad_drop.sql"

echo "Test 4: new meta table in migration 012 passes"
cat > "$MIGRATIONS/012_good_meta.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS user_subscription_tier_v2 (
    user_id uuid PRIMARY KEY REFERENCES users_v2(id) ON DELETE CASCADE,
    tier text NOT NULL
);
CREATE INDEX idx_tier ON user_subscription_tier_v2(tier);
SQL
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "meta table with FK to users_v2" 0 "$rc"
rm "$MIGRATIONS/012_good_meta.sql"

echo "Test 5: modifying migration 002 fails baseline drift check"
echo "-- tampering" >> "$MIGRATIONS/002_sprint1_data_integrity.sql"
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "baseline 002 drift" 1 "$rc"
restore_migrations

echo "Test 6: deleting migration 005 fails baseline drift check"
rm "$MIGRATIONS/005_sprint4_images_social.sql"
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "baseline 005 deleted" 1 "$rc"
restore_migrations

echo "Test 7: ALTER on similarly-named table is NOT false-flagged"
cat > "$MIGRATIONS/013_backup_alter.sql" <<'SQL'
-- users_v2_backup is a separate table, not a base table
CREATE TABLE users_v2_backup AS SELECT * FROM users_v2;
ALTER TABLE users_v2_backup ADD COLUMN snapshot_at timestamptz;
SQL
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "ALTER on users_v2_backup (not flagged)" 0 "$rc"
rm "$MIGRATIONS/013_backup_alter.sql"

echo "Test 8: ALTER inside a -- comment is NOT flagged"
cat > "$MIGRATIONS/014_only_comment.sql" <<'SQL'
-- Note: we do NOT ALTER TABLE users_v2 here on purpose.
CREATE TABLE comments_only_v2 (id uuid PRIMARY KEY);
SQL
set +e
python3 "$TMP_SCRIPT" > /dev/null 2>&1
rc=$?
set -e
assert_exit "ALTER inside SQL comment" 0 "$rc"
rm "$MIGRATIONS/014_only_comment.sql"

echo
if [ "$fail" -gt 0 ]; then
    echo "TEST SUITE FAILED: $fail failing, $pass passing"
    exit 1
fi
echo "TEST SUITE PASSED: $pass passing"
