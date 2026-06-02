#!/usr/bin/env python
"""R-CHAPTER-DB — F1-A chapter regression over real DB stories + outlines.

Pulls writing_projects_v2 rows that have a non-empty outline and runs the engine chapter step's
real ``write`` then ``qa`` ops against each — exercising the live path: load context from Supabase
-> compose the Follett craft layer (genre + arc + seeds) -> generate via Anthropic -> score the
result against the craft guides. Reports per-project word_count + all 7 craft-QA dimensions and a
pass/fail against --min-score.

Run from the engine dir with the workspace venv:

    ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \\
      .venv/bin/python scripts/f1a-chapter-regression.py --limit 18 --min-score 0.8

Costs real Anthropic tokens (one chapter generation + one QA call per project).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import urllib.request
from uuid import uuid4

from chapter_step.main import _op_qa, _op_write

QA_DIMS = [
    "character_follows_guide",
    "outline_follows_guide",
    "dialogue_follows_guide",
    "prose_transparent",
    "story_turn_density",
    "no_boring_paragraphs",
    "period_language_ok",
]


def _fetch_projects(limit: int) -> list[dict]:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    url = (
        f"{base}/rest/v1/writing_projects_v2"
        "?select=id,title,genre_slug,outline&order=updated_at.desc&limit=50"
    )
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    rows = json.load(urllib.request.urlopen(req, timeout=30))
    withoutline = [r for r in rows if isinstance(r.get("outline"), dict) and r["outline"]]
    return withoutline[:limit]


async def _run_one(proj: dict) -> dict:
    pid = proj["id"]
    written = await _op_write(
        {
            "project_id": pid,
            "chapter_number": 1,
            "chapter_run_id": str(uuid4()),
            "llm_strategy": "sonnet",
        }
    )
    text = written.get("content_text", "")
    qa = await _op_qa({"chapter_id": pid, "content_text": text, "period": "contemporary"})
    return {
        "id": pid[:8],
        "genre": proj.get("genre_slug"),
        "title": (proj.get("title") or "")[:28],
        "word_count": written.get("word_count", 0),
        "scores": qa.get("scores", {}),
        "findings": qa.get("findings", []),
    }


async def _main(limit: int, min_score: float) -> int:
    projects = _fetch_projects(limit)
    print(f"R-CHAPTER-DB: {len(projects)} projects with outlines\n")
    results = []
    for i, proj in enumerate(projects, 1):
        print(f"[{i}/{len(projects)}] {proj['id'][:8]} {proj.get('genre_slug')} — generating…", flush=True)
        try:
            results.append(await _run_one(proj))
        except Exception as exc:  # keep going; record the failure
            results.append({"id": proj["id"][:8], "genre": proj.get("genre_slug"), "error": str(exc)[:160]})

    print("\n=== RESULTS ===")
    failed = 0
    for r in results:
        if "error" in r:
            failed += 1
            print(f"  FAIL {r['id']} {r['genre']}: {r['error']}")
            continue
        sc = r["scores"]
        low = [d for d in QA_DIMS if sc.get(d, 0) < min_score]
        status = "PASS" if not low and r["word_count"] > 0 else "FAIL"
        if status == "FAIL":
            failed += 1
        avg = sum(sc.get(d, 0) for d in QA_DIMS) / len(QA_DIMS)
        print(
            f"  {status} {r['id']} {r['genre']:<22} words={r['word_count']:<5} avg_qa={avg:.2f}"
            + (f"  LOW: {low}" if low else "")
        )
    print(f"\n{len(results) - failed}/{len(results)} passed (min_score={min_score})")
    return 1 if failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=18)
    ap.add_argument("--min-score", type=float, default=0.8)
    args = ap.parse_args()
    raise SystemExit(asyncio.run(_main(args.limit, args.min_score)))
