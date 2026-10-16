#!/usr/bin/env python3
"""A6 — diagnose and (optionally) normalise `story_bible_v2.entry_type` on DEV.

DRY RUN BY DEFAULT. Pass --apply to write, and only after the canonical vocabulary is decided.

WHY A6 IS NOT WHAT THE INVENTORY SAID. It was recorded as "~1000 polluted rows, 297 character rows
with duplicate variants". Measured against DEV on 2026-10-16, that is not the problem:

    3245 rows total
    true duplicate (project_id, entry_type, lower(name)) groups:  21  ->  21 redundant rows
    rows whose entry_type is not in the table's documented CHECK: 2341  (72%)

The pollution is a **vocabulary mismatch**, not duplication. THREE layers disagree about what an
entry_type may be, and only `character` and `event` are common to all three:

    table CHECK (per docs/base-tables)  character event item     location  organization plot_thread
    engine BibleEntry Literal           character event object   place     concept
                                        (+ "research", written ad hoc by chapter_step:1463)
    client types/database.ts            character event location timeline  plot_thread  world_rule

So the engine writes `place`/`object`/`concept`/`research` (2341 rows), the UI queries a different
set again, and the Story Bible tab consequently hides most of what exists — which is why
ProjectDetail.tsx already carries an `isJunkBibleName` client-side workaround.

TWO OF THE MAPPINGS ARE UNAMBIGUOUS (same concept, different word):

    place  -> location
    object -> item

TWO NEED A DECISION, which is why this script does not guess:

    concept  (719 rows) — the table has no equivalent. plot_thread is the closest but not the same
                          thing; world_rule (client-only) is arguably closer. Could also justify
                          adding `concept` to the CHECK instead of remapping.
    research (493 rows) — arguably not a story-bible entry at all. chapter_step writes these as
                          research-topic records; they may belong in research_reports_v2, or be
                          dropped. Deleting 493 rows is destructive, so it is not defaulted.

Usage::

    python3 scripts/story_bible_normalize.py                    # diagnose only
    python3 scripts/story_bible_normalize.py --apply            # apply the settled mappings
    python3 scripts/story_bible_normalize.py --map concept=plot_thread --apply

Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (writers-workbench/engine/.env works).
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.error
import urllib.request

# The table's canonical vocabulary (docs/base-tables.md). Anything outside this is invisible to a
# consumer that filters on it.
CANONICAL = {"character", "event", "item", "location", "organization", "plot_thread"}

# Only the mappings that are the same concept under a different word. Deliberately does NOT include
# `concept` or `research` — see the module docstring.
SETTLED_MAP = {"place": "location", "object": "item"}

PAGE = 1000


def _req(url: str, *, method: str = "GET", body: bytes | None = None) -> tuple[int, bytes, dict]:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(f"{base}{url}", method=method, data=body)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "count=exact" if method == "GET" else "return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:  # surface the body — PostgREST explains itself well
        return e.code, e.read(), dict(e.headers or {})


def fetch_all() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        status, raw, _h = _req(
            f"/rest/v1/story_bible_v2?select=id,entry_type,name,project_id,deleted_at"
            f"&limit={PAGE}&offset={offset}"
        )
        if status not in (200, 206):  # 206 = PostgREST partial/counted response
            print(f"fetch failed ({status}): {raw[:300]!r}", file=sys.stderr)
            sys.exit(1)
        page = json.loads(raw)
        rows += page
        if len(page) < PAGE:
            return rows
        offset += PAGE


def diagnose(rows: list[dict]) -> dict:
    live = [r for r in rows if not r.get("deleted_at")]
    by_type = collections.Counter(r.get("entry_type") for r in live)
    noncanonical = {t: n for t, n in by_type.items() if t not in CANONICAL}
    dup_keys = collections.Counter(
        (r.get("project_id"), r.get("entry_type"), (r.get("name") or "").strip().lower())
        for r in live
    )
    dups = {k: v for k, v in dup_keys.items() if v > 1}
    return {
        "total": len(rows),
        "live": len(live),
        "soft_deleted": len(rows) - len(live),
        "by_type": dict(by_type.most_common()),
        "noncanonical": noncanonical,
        "noncanonical_rows": sum(noncanonical.values()),
        "duplicate_groups": len(dups),
        "redundant_rows": sum(v - 1 for v in dups.values()),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="A6 story-bible entry_type normalisation")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    ap.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="FROM=TO",
        help="extra mapping, e.g. concept=plot_thread. Repeatable.",
    )
    args = ap.parse_args(argv)

    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        print("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2

    mapping = dict(SETTLED_MAP)
    for item in args.map:
        if "=" not in item:
            print(f"bad --map {item!r}, expected FROM=TO", file=sys.stderr)
            return 2
        src, dst = item.split("=", 1)
        if dst not in CANONICAL:
            print(f"refusing to map {src!r} -> {dst!r}: not a canonical type {sorted(CANONICAL)}",
                  file=sys.stderr)
            return 2
        mapping[src] = dst

    rows = fetch_all()
    diag = diagnose(rows)

    print("=== story_bible_v2 (DEV) ===")
    print(f"  rows: {diag['total']}  live: {diag['live']}  soft-deleted: {diag['soft_deleted']}")
    print("  entry_type distribution:")
    for t, n in diag["by_type"].items():
        flag = "" if t in CANONICAL else "   <-- NOT in the table's CHECK"
        print(f"    {str(t):14} {n:5}{flag}")
    print(f"  non-canonical rows: {diag['noncanonical_rows']} "
          f"({100 * diag['noncanonical_rows'] // max(diag['live'], 1)}% of live)")
    print(f"  true duplicate groups: {diag['duplicate_groups']} "
          f"-> {diag['redundant_rows']} redundant rows")

    planned = {t: n for t, n in diag["noncanonical"].items() if t in mapping}
    undecided = {t: n for t, n in diag["noncanonical"].items() if t not in mapping}
    print("\n  planned remaps:")
    for t, n in planned.items() or {}.items():
        print(f"    {t} -> {mapping[t]}  ({n} rows)")
    if not planned:
        print("    (none)")
    if undecided:
        print("\n  UNDECIDED (needs a canonical-vocabulary decision; not touched):")
        for t, n in undecided.items():
            print(f"    {t}  ({n} rows)")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply once the mapping is settled.")
        return 0

    print("\napplying...")
    changed = 0
    for src, dst in mapping.items():
        if src not in diag["noncanonical"]:
            continue
        status, raw, _h = _req(
            f"/rest/v1/story_bible_v2?entry_type=eq.{src}",
            method="PATCH",
            body=json.dumps({"entry_type": dst}).encode(),
        )
        if status not in (200, 204):
            print(f"  {src} -> {dst} FAILED ({status}): {raw[:200]!r}", file=sys.stderr)
            return 1
        n = diag["noncanonical"][src]
        changed += n
        print(f"  {src} -> {dst}: {n} rows")
    print(f"done — {changed} rows normalised. Duplicates were NOT merged (reversible step first).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
