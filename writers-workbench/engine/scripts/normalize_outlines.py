"""Normalise existing outlines to the canonical shape (item 7) — snapshot first, undo-able.

New writes are normalised by ``writer_engine.outline_schema`` on the way in. This brings the rows that
were written before that (the n8n-shaped ``number`` + ``brief`` projects) to the same shape, without
destroying anything:

* every row that would change is first SNAPSHOTTED to ``outline_versions_v2`` exactly as it is, with
  a ``revision_note`` carrying the batch tag — the same history table the Workbench's outline
  "versions / revert" already reads, so an author can also restore it from the UI;
* only rows whose normalised form differs are touched; a row the schema REJECTS is left alone and
  reported, never "fixed" by guesswork;
* ``--undo <tag>`` puts every row of a batch back from its snapshot — but only a row still exactly
  as the batch left it, so an edit made since is never overwritten.

Dry run by default. DEV only; credentials from Railway, never from the repo::

    railway run -s writer-engine-runtime -e develop -- uv run python scripts/normalize_outlines.py
    railway run -s writer-engine-runtime -e develop -- uv run python scripts/normalize_outlines.py --apply
    railway run -s writer-engine-runtime -e develop -- uv run python scripts/normalize_outlines.py --undo item7-...
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from typing import Any

from writer_engine.outline_schema import OutlineValidationError, normalize_outline

NOTE_PREFIX = "item7 normalise snapshot"
DEV_REF = "gvbvwcnmjkdpclcisqrr"


def _shape(outline: Any) -> str:
    chapters = outline.get("chapters") if isinstance(outline, dict) else None
    if not chapters:
        return "no-chapters"
    keys = {k for c in chapters if isinstance(c, dict) for k in c}
    if "number" in keys and "chapter_number" not in keys:
        return "n8n"
    if "chapter_number" in keys and "number" not in keys:
        return "engine"
    return "mixed"


async def _client() -> Any:
    url = os.environ.get("SUPABASE_URL", "")
    if DEV_REF not in url:
        sys.exit(f"refusing: SUPABASE_URL is not DEV ({DEV_REF})")
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _all_projects(client: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    start = 0
    while True:
        resp = (
            await client.table("writing_projects_v2")
            .select("id,user_id,title,outline")
            .order("id")
            .range(start, start + 199)
            .execute()
        )
        rows = resp.data or []
        out.extend(rows)
        if len(rows) < 200:
            return out
        start += 200


async def _next_version(client: Any, project_id: str) -> int:
    resp = (
        await client.table("outline_versions_v2")
        .select("version_number")
        .eq("project_id", project_id)
        .order("version_number", desc=True)
        .limit(1)
        .execute()
    )
    return int(((resp.data or [{}])[0].get("version_number")) or 0) + 1


async def run(apply: bool) -> int:
    client = await _client()
    tag = f"item7-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    report: dict[str, Any] = {"tag": tag if apply else None, "mode": "apply" if apply else "dry-run"}
    shapes: dict[str, int] = {}
    changed, rejected, done = [], [], []
    for p in await _all_projects(client):
        outline = p.get("outline")
        if outline is None:
            continue
        shapes[_shape(outline)] = shapes.get(_shape(outline), 0) + 1
        try:
            canonical = normalize_outline(outline)
        except OutlineValidationError as exc:
            rejected.append({"id": p["id"], "title": p.get("title"), "problems": exc.problems})
            continue
        if canonical == outline:
            continue
        changed.append({"id": p["id"], "title": p.get("title"), "shape": _shape(outline)})
        if not apply:
            continue
        version = await _next_version(client, p["id"])
        await (
            client.table("outline_versions_v2")
            .insert(
                {
                    "user_id": p["user_id"],
                    "project_id": p["id"],
                    "version_number": version,
                    "outline": outline,
                    "revision_note": f"{NOTE_PREFIX} [{tag}] — the outline before it was normalised to the canonical shape",
                }
            )
            .execute()
        )
        # Re-read the snapshot before overwriting: no history, no overwrite.
        check = (
            await client.table("outline_versions_v2")
            .select("outline")
            .eq("project_id", p["id"])
            .eq("version_number", version)
            .limit(1)
            .execute()
        )
        if not check.data or check.data[0].get("outline") != outline:
            rejected.append(
                {"id": p["id"], "title": p.get("title"), "problems": ["snapshot did not verify; left alone"]}
            )
            continue
        await client.table("writing_projects_v2").update({"outline": canonical}).eq("id", p["id"]).execute()
        done.append({"id": p["id"], "title": p.get("title"), "snapshot_version": version})

    report.update(
        shapes_before=shapes,
        would_change=len(changed),
        changed=done if apply else changed,
        rejected=rejected,
    )
    if apply:
        report["undo"] = f"scripts/normalize_outlines.py --undo {tag}"
    print(json.dumps(report, indent=2, default=str))
    return 0


async def undo(tag: str) -> int:
    client = await _client()
    snaps = (
        await client.table("outline_versions_v2")
        .select("project_id,version_number,outline,revision_note")
        .like("revision_note", f"{NOTE_PREFIX} [{tag}]%")
        .execute()
    ).data or []
    restored, skipped = [], []
    for s in snaps:
        cur = (
            await client.table("writing_projects_v2")
            .select("outline")
            .eq("id", s["project_id"])
            .limit(1)
            .execute()
        ).data or []
        current = cur[0].get("outline") if cur else None
        try:
            expected = normalize_outline(s["outline"])
        except OutlineValidationError:
            expected = None
        if current != expected:
            skipped.append({"id": s["project_id"], "why": "edited since the batch; not overwritten"})
            continue
        await (
            client.table("writing_projects_v2")
            .update({"outline": s["outline"]})
            .eq("id", s["project_id"])
            .execute()
        )
        restored.append({"id": s["project_id"], "from_version": s["version_number"]})
    print(
        json.dumps({"tag": tag, "snapshots": len(snaps), "restored": restored, "skipped": skipped}, indent=2)
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true", help="snapshot then normalise (default: dry run)")
    g.add_argument("--undo", metavar="TAG", help="restore every row of a batch from its snapshot")
    args = ap.parse_args()
    if args.undo:
        return asyncio.run(undo(args.undo))
    return asyncio.run(run(apply=args.apply))


if __name__ == "__main__":
    raise SystemExit(main())
