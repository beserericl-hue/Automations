#!/usr/bin/env python3
"""
Schema governance check: base tables are immutable.

See writers-workbench/docs/schema-governance.md for the full rule set.

This script is intended to run as a required CI job on every PR.

Two checks:

1. Migrations 001–007 are frozen. Each file's current SHA-256 must match
   the hash in writers-workbench/migrations/.baseline-hashes.json. Any
   drift (edits, renames, deletions) fails CI.

2. Migrations 008+ may not ALTER, DROP, or RENAME any of the seven
   base tables (users_v2, writing_projects_v2, published_content_v2,
   story_bible_v2, research_reports_v2, genre_config_v2, story_arcs_v2)
   or the two derived history tables (content_versions_v2,
   outline_versions_v2).

Exits 0 on success, 1 on violation.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "writers-workbench" / "migrations"
BASELINE_HASHES = MIGRATIONS_DIR / ".baseline-hashes.json"

BASE_TABLES = {
    "users_v2",
    "writing_projects_v2",
    "published_content_v2",
    "story_bible_v2",
    "research_reports_v2",
    "genre_config_v2",
    "story_arcs_v2",
    "content_versions_v2",
    "outline_versions_v2",
}

FORBIDDEN_STATEMENTS = (
    ("ALTER TABLE", r"ALTER\s+TABLE\s+"),
    ("DROP TABLE", r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"),
    ("RENAME TABLE", r"RENAME\s+TABLE\s+"),
)

BASELINE_CUTOFF = 7  # migration numbers 1..7 are baseline-frozen


def strip_sql_comments(sql: str) -> str:
    """Remove -- line comments and /* ... */ block comments."""
    sql = re.sub(r"--[^\n]*", "", sql)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    return sql


def migration_number(filename: str) -> int | None:
    m = re.match(r"^(\d+)_", filename)
    return int(m.group(1)) if m else None


def check_frozen_migrations() -> list[str]:
    """Return a list of error strings for migrations 001–007 drift."""
    errors: list[str] = []
    if not BASELINE_HASHES.exists():
        return [
            f"baseline hash file missing: {BASELINE_HASHES.relative_to(REPO_ROOT)}"
        ]

    expected = json.loads(BASELINE_HASHES.read_text())

    for name, expected_hash in expected.items():
        path = MIGRATIONS_DIR / name
        if not path.exists():
            errors.append(f"frozen migration deleted: {name}")
            continue
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            errors.append(
                f"frozen migration modified: {name}\n"
                f"    expected sha256: {expected_hash}\n"
                f"    actual   sha256: {actual_hash}\n"
                f"    baseline migrations 001–007 must not change. "
                f"Write a new compensating migration instead."
            )

    # Detect frozen-numbered files present on disk but missing from the baseline record.
    for path in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
        num = migration_number(path.name)
        if num is None or num > BASELINE_CUTOFF:
            continue
        if path.name not in expected:
            errors.append(
                f"frozen-number migration missing from baseline-hashes.json: {path.name}"
            )

    return errors


def check_additive_migrations() -> list[str]:
    """Return a list of error strings for migrations 008+ touching base tables."""
    errors: list[str] = []

    for path in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
        num = migration_number(path.name)
        if num is None or num <= BASELINE_CUTOFF:
            continue

        content = strip_sql_comments(path.read_text())
        lines = content.splitlines()

        for label, prefix_pattern in FORBIDDEN_STATEMENTS:
            # Match "<prefix> <table_name>" where table_name is one of the base tables.
            # Use word boundaries so we don't false-positive on "users_v2_backup".
            table_alt = "|".join(re.escape(t) for t in BASE_TABLES)
            pattern = re.compile(
                rf"{prefix_pattern}\"?({table_alt})\"?\b",
                re.IGNORECASE,
            )
            for lineno, line in enumerate(lines, start=1):
                m = pattern.search(line)
                if m:
                    errors.append(
                        f"{path.name}:{lineno}: forbidden {label} on base table "
                        f"'{m.group(1)}'\n"
                        f"    statement: {line.strip()[:120]}\n"
                        f"    base tables are immutable; add a meta table with FK instead"
                    )

    return errors


def main() -> int:
    errors: list[str] = []
    errors.extend(check_frozen_migrations())
    errors.extend(check_additive_migrations())

    if errors:
        print("Schema governance violations detected:\n", file=sys.stderr)
        for err in errors:
            print(f"  - {err}\n", file=sys.stderr)
        print(
            "See writers-workbench/docs/schema-governance.md for the rules.",
            file=sys.stderr,
        )
        return 1

    print("Schema governance: OK")
    print(f"  checked {len(list(MIGRATIONS_DIR.glob('[0-9]*.sql')))} migrations")
    print(f"  base tables protected: {len(BASE_TABLES)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
