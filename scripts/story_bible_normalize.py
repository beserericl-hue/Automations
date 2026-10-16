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

DECIDED 2026-10-16 — the ENGINE vocabulary is canonical:

    character | place | object | concept | event

Confirmed by probing DEV: `pg_constraint` shows **no CHECK on entry_type at all**, so the table's
documented set was never enforced and the engine's words are simply what the data contains. The
consumers move instead of the data: the client now groups by the types actually PRESENT
(`client/src/lib/story-bible-types.ts`), so `place`/`object`/`concept` render and no row can be
hidden by a hardcoded list again. **No remap of place/object/concept is needed.**

    research (493 rows) — retired with --retire-research. chapter_step's duplicate write is removed;
                          persist_research already stores the FULL text in research_reports_v2
                          (project-linked by migration 026), and every sampled bible row's text was
                          verified present verbatim inside a linked report. Soft-delete only.

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
# Historical/documented set, kept only to report on. The real canonical set is ENGINE_CANONICAL.
CANONICAL = {"character", "event", "item", "location", "organization", "plot_thread"}

# Empty by decision: the engine vocabulary won, so place/object/concept are canonical and must NOT
# be remapped. Kept as a hook for a future rename rather than deleted.
SETTLED_MAP: dict[str, str] = {}

# The engine's canonical vocabulary (writer_engine.schemas.chapter.BibleEntry).
ENGINE_CANONICAL = {"character", "place", "object", "concept", "event"}

PAGE = 1000


def _utc_now_iso() -> str:
    """Explicit ISO timestamp — 'now()' is not a valid timestamptz literal over PostgREST."""
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


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
    # Measured against the ENGINE vocabulary (the 2026-10-16 decision), not the never-enforced
    # table CHECK. `research` is reported separately since it is retired, not remapped.
    noncanonical = {
        t: n for t, n in by_type.items() if t not in ENGINE_CANONICAL and t != "research"
    }
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
        "--retire-research",
        action="store_true",
        help="soft-delete entry_type='research' rows (content already lives in research_reports_v2)",
    )
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
        if t in ENGINE_CANONICAL:
            flag = "   (canonical)"
        elif t == "research":
            flag = "   <-- retire (duplicates research_reports_v2)"
        else:
            flag = "   <-- legacy, outside the canonical set"
        
        print(f"    {str(t):14} {n:5}{flag}")
    canonical_n = sum(n for t, n in diag["by_type"].items() if t in ENGINE_CANONICAL)
    print(f"  canonical (engine vocabulary): {canonical_n} "
          f"({100 * canonical_n // max(diag['live'], 1)}% of live)")
    print(f"  legacy rows outside it: {diag['noncanonical_rows']}")
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
        print("\n  legacy types present (no remap configured; left as-is and still rendered):")
        for t, n in undecided.items():
            print(f"    {t}  ({n} rows)")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply once the mapping is settled.")
        return 0

    research_n = diag["by_type"].get("research", 0)
    if args.retire_research and research_n:
        print(f"\n  retire-research: {research_n} rows -> soft-delete (deleted_at)")
        if args.apply:
            status, raw, _h = _req(
                "/rest/v1/story_bible_v2?entry_type=eq.research&deleted_at=is.null",
                method="PATCH",
                body=json.dumps({"deleted_at": _utc_now_iso()}).encode(),
            )
            if status not in (200, 204):
                print(f"  retire-research FAILED ({status}): {raw[:200]!r}", file=sys.stderr)
                return 1
            print(f"  retired {research_n} research rows (reversible: deleted_at = null)")

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
