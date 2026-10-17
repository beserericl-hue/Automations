#!/usr/bin/env python3
"""Does the story's memory survive being split across processes? Measure it.

The concern this answers: a chapter is composed by the chapter step, its canon lives in Supabase,
its research comes from another provider and its outline was produced by a different step entirely.
"LLM generation does not occur consistently in a vacuum" — so what, exactly, does chapter N know
about chapters 1..N-1?

This script is READ-ONLY by default. The database is the control and is never written; `--json`
writes a snapshot so a later run can be diffed against it.

WHAT IT MEASURES

1. **The control snapshot.** Project row, outline shape, roster, per-chapter title/word-count/hash,
   bible counts by type, canon-index inventory. Enough to prove afterwards that nothing was altered.

2. **What the engine would actually feed chapter N.** Not by reading the code — by calling the same
   loaders the chapter step calls: the compact outline view, the roster text, and a live
   `match_project_canon` against the chapter's own beat. If canon retrieval returns nothing, the
   chapter is written from the outline header alone, and this says so.

3. **Continuity in the prose that already exists.** A 96-chapter finished novel is a natural
   experiment. Roster coverage, names in the prose that are in no roster, scene-break presence
   (A13), word-count drift, and chapter titles against the outline.

   It deliberately does NOT flag "a woman named X" as a re-introduction any more. That was the
   first version's headline signal and it was wrong: on The Burial Mound all twelve hits were the
   book's own device — a generational chain of names being recited ("Before Matta there was a woman
   named Tessa"). The phrasing is correct prose for that book. A detector that cannot tell a device
   from a defect produces confident nonsense, so the attributions are now counted and shown as
   ATTRIBUTIONS, for a human to read, with no verdict attached.

Usage::

    python3 scripts/story_composition_check.py --project "The Burial Mound"
    python3 scripts/story_composition_check.py --project "The Last Signal" --next-chapter 4
    python3 scripts/story_composition_check.py --project "The Burial Mound" --json control.json

Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (writers-workbench/engine/.env works).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

ENGINE_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "writers-workbench",
    "engine",
)

# Phrasings that introduce someone as new. Deliberately narrow: these are the constructions a model
# reaches for when it does not know the character already exists, and they are rare in prose that
# does know. "a man named X" is the canonical tell.
_INTRO_PATTERNS = [
    re.compile(r"\ba (?:man|woman|boy|girl|figure|stranger|soldier|guard|priest|trader) (?:named|called) ([A-Z][a-z]+)"),
    re.compile(r"\b(?:named|called) ([A-Z][a-z]+), (?:a|an|the) [a-z]"),
    re.compile(r"\bintroduced (?:him|her)self as ([A-Z][a-z]+)"),
    re.compile(r"\bhis name was ([A-Z][a-z]+)"),
    re.compile(r"\bher name was ([A-Z][a-z]+)"),
]

# Candidate proper nouns in prose: a capitalised word not at the start of a sentence.
_PROPER = re.compile(r"(?<![.!?\"'\n]\s)(?<!^)\b([A-Z][a-z]{2,})\b")

_STOP = {
    "The","A","An","And","But","He","She","It","They","We","You","I","His","Her","Their","That","This",
    "There","Then","When","What","Who","Why","How","If","As","At","By","For","From","In","Into","Of","On",
    "Or","So","To","Up","With","Not","No","Now","Here","Chapter","Part","One","Two","Three","Four","Five",
    "God","Lord","Mother","Father","Sister","Brother","Yes","Still","After","Before","Behind","Above",
    "Below","Later","Even","Only","Once","Every","Each","Some","Many","Most","Both","Nothing","Something",
    "Everything","Someone","Anyone","Perhaps","Maybe","Because","While","Until","Since","Though","Although",
}


@dataclass
class Chapter:
    number: int
    title: str
    word_count: int
    text: str
    sha256: str
    scene_breaks: int
    outline_title: str = ""
    names: set[str] = field(default_factory=set)
    reintroductions: list[str] = field(default_factory=list)

    def as_control(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "title": self.title,
            "word_count": self.word_count,
            "sha256": self.sha256,
            "first_80": " ".join(self.text.split()[:80]),
        }


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


def _scene_breaks(text: str) -> int:
    """A13: chapters had no scene breaks at all. Count the separators the writer is told to use."""
    return len(re.findall(r"(?m)^\s*(?:\*\s*\*\s*\*|---|———|#\s*•)\s*$", text))


def _roster_names(outline: dict[str, Any]) -> list[str]:
    out = []
    for c in outline.get("characters") or []:
        if isinstance(c, dict) and c.get("name"):
            out.append(str(c["name"]).strip())
    return out


def _first_names(names: list[str]) -> set[str]:
    """Match prose mentions against first names: the roster carries "Tayak Redcloud", prose says
    "Tayak". Comparing full strings would report every main character as absent."""
    parts: set[str] = set()
    for n in names:
        for piece in re.split(r"[\s'\-]+", n):
            if len(piece) > 2 and piece[:1].isupper():
                parts.add(piece)
    return parts


async def load_story(project_name: str) -> tuple[dict[str, Any], list[Chapter], list[dict[str, Any]]]:
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    projects = (
        await client.table("writing_projects_v2")
        .select("id,title,genre_slug,chapter_count,status,user_id,outline,created_at,updated_at")
        .execute()
    ).data or []
    matches = [p for p in projects if project_name.lower() in str(p.get("title") or "").lower()]
    if not matches:
        raise SystemExit(f"no project matching {project_name!r}")
    project = max(matches, key=lambda p: len(str(p.get("title") or "")) * -1)

    rows = (
        await client.table("published_content_v2")
        .select("chapter_number,title,content_text,metadata,created_at")
        .eq("project_id", project["id"])
        .eq("content_type", "chapter")
        .order("chapter_number")
        .limit(500)
        .execute()
    ).data or []

    outline = project.get("outline") or {}
    # Via outline_keys: keyed on `number` alone, this dict was EMPTY for every engine-shaped
    # project, so the title-mismatch check below silently passed by having nothing to compare.
    from writer_engine import outline_keys

    outline_titles = {
        outline_keys.chapter_number(ch): str(ch.get("title") or "")
        for ch in (outline.get("chapters") or [])
        if outline_keys.chapter_number(ch) is not None
    }
    roster = _roster_names(outline)
    allowed = _first_names(roster)

    chapters: list[Chapter] = []
    for r in rows:
        text = str(r.get("content_text") or "")
        num = r.get("chapter_number")
        if num is None:
            continue
        ch = Chapter(
            number=int(num),
            title=str(r.get("title") or ""),
            word_count=len(text.split()),
            text=text,
            sha256=_hash(text),
            scene_breaks=_scene_breaks(text),
            outline_title=outline_titles.get(int(num), ""),
        )
        found = {m for m in _PROPER.findall(text) if m not in _STOP}
        ch.names = found
        seen_before: set[str] = set()
        for prev in chapters:
            seen_before |= prev.names & allowed
        for pat in _INTRO_PATTERNS:
            for name in pat.findall(text):
                if name in allowed and name in seen_before:
                    ch.reintroductions.append(name)
        chapters.append(ch)

    bible = (
        await client.table("story_bible_v2")
        .select("entry_type,name")
        .eq("project_id", project["id"])
        .is_("deleted_at", "null")
        .limit(5000)
        .execute()
    ).data or []
    return project, chapters, bible


async def canon_inventory(project_id: str) -> dict[str, int]:
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    rows = (
        await client.table("writing_embeddings_v2")
        .select("doc_type")
        .eq("project_id", project_id)
        .limit(5000)
        .execute()
    ).data or []
    return dict(Counter(str(r.get("doc_type")) for r in rows))


async def probe_prompt_inputs(project: dict[str, Any], chapter_number: int) -> dict[str, Any]:
    """Call the SAME loaders the chapter step calls, so this reports the real prompt inputs."""
    sys.path.insert(0, os.path.join(ENGINE_SRC, "services", "chapter_step", "src"))
    from chapter_step.main import _compact_outline_view, _load_context, _roster_text  # type: ignore

    ctx = await _load_context(str(project["id"]), {})
    outline = ctx.get("outline") or {}
    from writer_engine import outline_keys

    beat = ""
    for ch in outline.get("chapters") or []:
        if outline_keys.matches(ch, chapter_number):
            beat = outline_keys.chapter_body(ch)
            break

    canon_rows: list[dict[str, Any]] = []
    canon_error = ""
    try:
        from writer_engine.embeddings import embeddings_enabled, match_project_canon

        if embeddings_enabled():
            canon_rows = await match_project_canon(
                query=beat or str(outline.get("premise") or ""),
                user_id=str(project.get("user_id") or ""),
                project_id=str(project["id"]),
                match_count=8,
                match_threshold=0.35,
            )
        else:
            canon_error = "ENABLE_PYTHON_EMBEDDINGS is off"
    except Exception as exc:
        canon_error = f"{type(exc).__name__}: {exc}"

    view = _compact_outline_view(outline, chapter_number)
    roster_text = _roster_text(ctx.get("roster") or [])
    return {
        "beat": beat,
        "outline_view_chars": len(view),
        "outline_view_head": " ".join(view.split())[:400],
        "roster_entries": len(ctx.get("roster") or []),
        "roster_chars": len(roster_text),
        "canon_rows": len(canon_rows),
        "canon_types": dict(Counter(str(r.get("doc_type")) for r in canon_rows)),
        "canon_sample": [
            f"[{r.get('doc_type')}] {str(r.get('doc_title'))[:40]}" for r in canon_rows[:5]
        ],
        "canon_error": canon_error,
    }


def report(
    project: dict[str, Any],
    chapters: list[Chapter],
    bible: list[dict[str, Any]],
    inventory: dict[str, int],
    prompt_inputs: dict[str, Any] | None,
) -> dict[str, Any]:
    outline = project.get("outline") or {}
    roster = _roster_names(outline)
    allowed = _first_names(roster)
    words = [c.word_count for c in chapters]

    print(f"\n=== {project['title']} ===")
    print(f"  project   : {project['id']}  [{project.get('genre_slug')}]  status={project.get('status')}")
    print(f"  chapters  : {len(chapters)} written / {project.get('chapter_count')} planned")
    print(f"  outline   : premise {'yes' if outline.get('premise') else 'NO'}"
          f" · arc {outline.get('story_arc_name') or 'NONE'}"
          f" · {len(outline.get('chapters') or [])} chapter entries"
          f" · {len(roster)} roster characters")
    print(f"  bible     : {len(bible)} live entries {dict(Counter(str(b.get('entry_type')) for b in bible))}")
    print(f"  canon idx : {inventory or '— NOTHING INDEXED —'}")
    if words:
        print(f"  words     : min {min(words)} · median {int(statistics.median(words))} · max {max(words)}"
              f" · total {sum(words):,}")

    print("\n--- cross-chapter memory signals ---")
    no_breaks = [c.number for c in chapters if c.scene_breaks == 0]
    print(f"  chapters with NO scene break : {len(no_breaks)}/{len(chapters)}"
          + (f"  e.g. {no_breaks[:10]}" if no_breaks else ""))

    reintro = [(c.number, n) for c in chapters for n in set(c.reintroductions)]
    print(f"  name ATTRIBUTIONS of an already-established character : {len(reintro)}")
    print("     (not a defect by itself — on a told-story book this is the narrative device;")
    print("      read them before drawing a conclusion)")
    for num, name in reintro[:12]:
        print(f"      ch {num:>3}  \"{name}\"")

    # Roster coverage: a main cast member who never appears is an outline/prose disconnect.
    appearances = Counter()
    for c in chapters:
        for n in c.names & allowed:
            appearances[n] += 1
    missing = sorted(allowed - set(appearances))
    print(f"  roster names never appearing in any chapter : {len(missing)}"
          + (f"  {missing[:10]}" if missing else ""))

    # Names in the prose that are in NO roster: either legitimate minor characters or invented ones.
    off_roster = Counter()
    for c in chapters:
        for n in c.names - allowed:
            off_roster[n] += 1
    frequent_off = [(n, k) for n, k in off_roster.most_common(15) if k >= max(3, len(chapters) // 10)]
    print(f"  recurring names NOT in the roster : {len(frequent_off)}")
    for n, k in frequent_off[:10]:
        print(f"      {n:<18} in {k} chapters")

    title_mismatch = [
        c.number for c in chapters if c.outline_title and c.outline_title.lower() not in c.title.lower()
    ]
    print(f"  stored title != outline title : {len(title_mismatch)}"
          + (f"  e.g. {title_mismatch[:8]}" if title_mismatch else ""))

    if prompt_inputs:
        print("\n--- what the engine would feed the NEXT chapter (live loaders) ---")
        pi = prompt_inputs
        print(f"  outline view : {pi['outline_view_chars']} chars")
        print(f"  roster       : {pi['roster_entries']} entries, {pi['roster_chars']} chars")
        print(f"  beat         : {(pi['beat'] or '(none)')[:160]}")
        print(f"  canon rows   : {pi['canon_rows']}  {pi['canon_types']}")
        for s in pi["canon_sample"]:
            print(f"      {s}")
        if pi["canon_error"]:
            print(f"  canon ERROR  : {pi['canon_error']}")
        if pi["canon_rows"] == 0 and not pi["canon_error"]:
            print("  !! canon retrieval returned NOTHING — this chapter would be written from the")
            print("     outline header alone, with no retrieval of the book's own established canon.")

    return {
        "project": {k: project.get(k) for k in ("id", "title", "genre_slug", "chapter_count", "status")},
        "outline": {
            "has_premise": bool(outline.get("premise")),
            "arc": outline.get("story_arc_name"),
            "chapter_entries": len(outline.get("chapters") or []),
            "roster": roster,
        },
        "chapters": [c.as_control() for c in chapters],
        "bible_counts": dict(Counter(str(b.get("entry_type")) for b in bible)),
        "canon_index": inventory,
        "signals": {
            "chapters_without_scene_break": no_breaks,
            "reintroductions": [{"chapter": n, "name": name} for n, name in reintro],
            "roster_never_appearing": missing,
            "recurring_off_roster": dict(frequent_off),
            "title_mismatch": title_mismatch,
            "word_counts": {
                "min": min(words) if words else 0,
                "median": int(statistics.median(words)) if words else 0,
                "max": max(words) if words else 0,
                "total": sum(words),
            },
        },
        "prompt_inputs": prompt_inputs,
    }


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="story composition / cross-process memory check")
    ap.add_argument("--project", required=True)
    ap.add_argument("--next-chapter", type=int, default=0, help="probe the prompt inputs for this chapter")
    ap.add_argument("--json", dest="json_out", default="")
    args = ap.parse_args(argv)

    for path in (
        os.path.join(ENGINE_SRC, "packages", "writer_engine", "src"),
        os.path.join(ENGINE_SRC, "services", "chapter_step", "src"),
    ):
        if path not in sys.path:
            sys.path.insert(0, path)

    if not os.environ.get("SUPABASE_URL"):
        print("set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2

    project, chapters, bible = await load_story(args.project)
    inventory = await canon_inventory(str(project["id"]))
    prompt_inputs = None
    if args.next_chapter:
        prompt_inputs = await probe_prompt_inputs(project, args.next_chapter)

    out = report(project, chapters, bible, inventory, prompt_inputs)
    if args.json_out:
        from pathlib import Path

        Path(args.json_out).write_text(json.dumps(out, indent=2, default=str))
        print(f"\ncontrol snapshot -> {args.json_out}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
