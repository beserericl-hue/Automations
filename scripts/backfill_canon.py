#!/usr/bin/env python3
"""J1 + J3 — index every project's canon, including the prose nobody had indexed.

Measured on DEV 2026-10-17: 4 of 26 projects with outlines had any rows in
``writing_embeddings_v2``, and three of those four came from n8n. The Burial Mound — 96 chapters,
668k words — had **zero**, so every one of its chapter writes retrieved none of its own canon and
``_canon_grounding`` returned "" ninety-six times.

Two causes, both now fixed in the engine:

* ``index_project_canon`` only ever ran on a brainstorm outline SAVE, so a project created before
  A3 never got one.
* ``build_canon_chunks`` keyed chapters on ``number`` while the engine writes ``chapter_number``,
  so for the sixteen engine-shaped projects every chapter was skipped even when it did run.

What is left is this backfill. It is additive and re-runnable:

* outline + bible canon via ``index_project_canon`` (delete-then-insert, with the existing coverage
  guard that refuses a reindex which would shrink the set)
* written prose via ``index_chapter_prose``, per chapter, scoped so one chapter's refresh cannot
  touch another's scenes or the outline canon

COST is small but not zero: text-embedding-3-small is ~$0.02 per million tokens, so the whole DEV
corpus is a few cents. Still, ``--dry-run`` is the default and prints exactly what it would embed.

Usage::

    python3 scripts/backfill_canon.py                      # report only
    python3 scripts/backfill_canon.py --apply              # every project
    python3 scripts/backfill_canon.py --apply --project "The Burial Mound"
    python3 scripts/backfill_canon.py --apply --no-prose   # outline/bible only

Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + OPENAI_API_KEY + ENABLE_PYTHON_EMBEDDINGS=true.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import Counter
from dataclasses import dataclass, field

ENGINE_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "writers-workbench",
    "engine",
    "packages",
    "writer_engine",
    "src",
)
if ENGINE_SRC not in sys.path:
    sys.path.insert(0, ENGINE_SRC)


@dataclass
class ProjectPlan:
    project_id: str
    title: str
    user_id: str
    outline_chapters: int
    bible_entries: int
    written_chapters: int
    written_words: int
    existing_rows: int
    existing_types: dict[str, int] = field(default_factory=dict)

    @property
    def needs_outline(self) -> bool:
        return self.outline_chapters > 0 or self.bible_entries > 0

    @property
    def needs_prose(self) -> bool:
        return self.written_chapters > 0


async def survey() -> list[ProjectPlan]:
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    projects = (
        await client.table("writing_projects_v2").select("id,title,user_id,outline").limit(500).execute()
    ).data or []

    embeddings = (
        await client.table("writing_embeddings_v2")
        .select("project_id,doc_type")
        .limit(20000)
        .execute()
    ).data or []
    rows_by_project: dict[str, list[str]] = {}
    for row in embeddings:
        rows_by_project.setdefault(str(row.get("project_id")), []).append(str(row.get("doc_type")))

    plans: list[ProjectPlan] = []
    for proj in projects:
        pid = str(proj["id"])
        outline = proj.get("outline") or {}
        chapters = [c for c in (outline.get("chapters") or []) if isinstance(c, dict)]

        bible = (
            await client.table("story_bible_v2")
            .select("id", count="exact")
            .eq("project_id", pid)
            .is_("deleted_at", "null")
            .execute()
        )
        written = (
            await client.table("published_content_v2")
            .select("chapter_number,content_text")
            .eq("project_id", pid)
            .eq("content_type", "chapter")
            .limit(500)
            .execute()
        ).data or []

        existing = rows_by_project.get(pid, [])
        plans.append(
            ProjectPlan(
                project_id=pid,
                title=str(proj.get("title") or "(untitled)"),
                user_id=str(proj.get("user_id") or ""),
                outline_chapters=len(chapters),
                bible_entries=int(bible.count or 0),
                written_chapters=len(written),
                written_words=sum(len(str(w.get("content_text") or "").split()) for w in written),
                existing_rows=len(existing),
                existing_types=dict(Counter(existing)),
            )
        )
    return plans


async def backfill_project(plan: ProjectPlan, *, do_prose: bool) -> dict[str, int]:
    from writer_engine.embeddings import index_chapter_prose, index_project_canon
    from writer_engine.supabase.client import get_supabase_admin

    out = {"outline": 0, "prose": 0, "chapters": 0}
    if plan.needs_outline:
        out["outline"] = await index_project_canon(user_id=plan.user_id, project_id=plan.project_id)

    if do_prose and plan.needs_prose:
        client = await get_supabase_admin()
        rows = (
            await client.table("published_content_v2")
            .select("chapter_number,title,content_text")
            .eq("project_id", plan.project_id)
            .eq("content_type", "chapter")
            .order("chapter_number")
            .limit(500)
            .execute()
        ).data or []
        for row in rows:
            number = row.get("chapter_number")
            if number is None:
                continue
            n = await index_chapter_prose(
                user_id=plan.user_id,
                project_id=plan.project_id,
                chapter_number=int(number),
                title=str(row.get("title") or ""),
                text=str(row.get("content_text") or ""),
            )
            out["prose"] += n
            if n:
                out["chapters"] += 1
    return out


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="backfill project canon + prose embeddings")
    ap.add_argument("--apply", action="store_true", help="actually embed and write (default: report)")
    ap.add_argument("--project", default="", help="only projects whose title contains this")
    ap.add_argument("--no-prose", action="store_true", help="outline/bible only, skip written chapters")
    ap.add_argument("--min-words", type=int, default=0, help="skip projects under this written word count")
    args = ap.parse_args(argv)

    if not os.environ.get("SUPABASE_URL"):
        print("set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2

    from writer_engine.embeddings import embeddings_enabled

    if args.apply and not embeddings_enabled():
        print("ENABLE_PYTHON_EMBEDDINGS is off — nothing would be written", file=sys.stderr)
        return 2

    plans = await survey()
    if args.project:
        plans = [p for p in plans if args.project.lower() in p.title.lower()]
    plans = [p for p in plans if (p.needs_outline or p.needs_prose) and p.written_words >= args.min_words]
    plans.sort(key=lambda p: -p.written_words)

    print(f"{'project':34} {'outl':>5} {'bible':>6} {'chaps':>6} {'words':>8} {'indexed':>8}  existing")
    for p in plans:
        print(
            f"{p.title[:32]:34} {p.outline_chapters:>5} {p.bible_entries:>6} {p.written_chapters:>6} "
            f"{p.written_words:>8} {p.existing_rows:>8}  {p.existing_types or '—'}"
        )
    total_words = sum(p.written_words for p in plans)
    print(
        f"\n{len(plans)} projects · {total_words:,} written words"
        f" · ~{total_words // 750:,}k tokens to embed (~${total_words / 750 * 1000 * 0.02 / 1_000_000:.2f})"
    )

    if not args.apply:
        print("\nDRY RUN — nothing embedded. Re-run with --apply.")
        return 0

    print("\napplying…")
    totals = {"outline": 0, "prose": 0, "chapters": 0}
    for p in plans:
        got = await backfill_project(p, do_prose=not args.no_prose)
        for k in totals:
            totals[k] += got[k]
        print(
            f"  {p.title[:40]:42} outline {got['outline']:>4}  prose {got['prose']:>5}"
            f"  ({got['chapters']} chapters)"
        )
    print(
        f"\ndone — {totals['outline']} outline/bible chunks, {totals['prose']} prose chunks"
        f" across {totals['chapters']} chapters"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
