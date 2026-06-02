#!/usr/bin/env python
"""Compose the EXACT engine prompts for 'The Burial Mound' (no LLM calls) for human review.

Reads the project's real outline JSON and emits, per stage, the system + user prompts the engine
would submit — composed from the Follett craft layer + this project's data. This lets the artifacts
(prompts) be reviewed before any generation is run.

Run from the engine dir with the workspace venv:
    .venv/bin/python scripts/compose-burial-mound-prompts.py <project_json> <out_dir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from brainstorm_step.main import _arc_block as bs_arc
from brainstorm_step.main import _build_story_system
from brainstorm_step.main import _genre_block as bs_genre
from chapter_step.main import _build_qa_system, _build_write_system, _roster_text
from research_step.main import (
    _build_derive_user,
    _build_query_prompt,
    _derive_system,
    _synthesis_system,
)

proj = json.load(open(sys.argv[1]))[0]
out = Path(sys.argv[2])
outline = proj.get("outline") or {}
genre = proj.get("genre_slug") or ""
arc = outline.get("story_arc_name") or outline.get("story_arc") or "(none set — engine infers from outline)"
premise = outline.get("premise") or ""
title = proj.get("title") or "Untitled"
# Characters live in the outline JSONB for this project (story_bible_v2 has only world entries),
# so the chapter step's story_bible roster is empty — reflect that honestly.
roster: list = []

# Research framing derived from the project.
topic = (
    "The Piscataway (Conoy) people of Charles County, Maryland — burial mounds and ossuaries, the "
    "copper trade, the Three Sisters agriculture, daily life and ceremony from the Late Woodland "
    "period through 17th-century colonial contact, and the modern fight for tribal recognition."
)
setting = "Potomac/Chesapeake tidewater, Maryland — Late Woodland to colonial contact, and present-day Charles County"


def fence(s: str) -> str:
    return "```text\n" + s.rstrip() + "\n```\n"


# ---- 1. Brainstorm (outline) -----------------------------------------------------------------
bs_system = _build_story_system(genre, "" if "none set" in arc else arc)
bs_user = f"PROJECT REQUIREMENTS:\n{premise}\n\nGenerate the full outline."
(out / "prompts" / "brainstorm-prompt.md").write_text(
    f"""---
name: Brainstorm prompt — The Burial Mound
description: The exact system + user prompt the engine submits to brainstorm.story (outline generation)
type: reference
tags: [workbench-test, prompts, brainstorm, the-burial-mound]
---

# Brainstorm (outline) prompt — The Burial Mound

**Engine call:** `POST /internal/write/brainstorm` · `op="story"` · model `claude-sonnet-4-6` · max_tokens 16384
**Genre:** `{genre}` · **Story arc:** `{arc}`

Composed as: Follett prime directive → genre block → arc block → plot seeds (dramatic_question,
weaving, anti_sog, heightened_ending, wow_factor, scene_density) → character seeds
(broad_strokes_then_twist, moral_complication, no_milk_and_water) → outline_gate self-validation.

## System prompt
{fence(bs_system)}

## User prompt
{fence(bs_user)}
""",
    encoding="utf-8",
)

# ---- 2. Research -----------------------------------------------------------------------------
rs_derive_system = _derive_system()
rs_derive_user = _build_derive_user(topic, genre, setting)
rs_query_example = _build_query_prompt("the copper trade and copper pendants among Late Woodland Piscataway", "Late Woodland Chesapeake", "Maryland")
rs_synth = _synthesis_system()
(out / "prompts" / "research-prompt.md").write_text(
    f"""---
name: Research prompt — The Burial Mound
description: The exact prompts the engine submits to research (derive → Perplexity query shape → synthesis)
type: reference
tags: [workbench-test, prompts, research, the-burial-mound]
---

# Research prompts — The Burial Mound

**Engine call:** `POST /internal/write/research` · `op="run"`. Three composed prompts run in sequence.
**Topic:** {topic}
**Setting/period:** {setting}

## 2a. Derive questions — system
{fence(rs_derive_system)}

## 2b. Derive questions — user (follett_seeds.research.derive)
{fence(rs_derive_user)}

## 2c. Per-question Perplexity query shape (example for one derived question)
{fence(rs_query_example)}

## 2d. Synthesis — system (Sal-and-the-potatoes scene seeds + setback→opportunity)
{fence(rs_synth)}
""",
    encoding="utf-8",
)

# ---- 3. Chapter outline ----------------------------------------------------------------------
# The outline already contains 63 chapter beats. Chapter-outline review = the brainstorm output's
# chapters[]. (A deeper per-chapter beat expansion would reuse the brainstorm system + a single
# chapter focus.) Document the source + a sample of the existing beats.
existing_chs = outline.get("chapters") or []
sample = "\n".join(
    f"- ch {c.get('chapter_number', c.get('number','?'))}: {c.get('title','')}" for c in existing_chs[:12] if isinstance(c, dict)
)
(out / "prompts" / "chapter-outline-prompt.md").write_text(
    f"""---
name: Chapter-outline prompt — The Burial Mound
description: How chapter outlines are produced — they are the chapters[] of the brainstorm outline
type: reference
tags: [workbench-test, prompts, chapter-outline, the-burial-mound]
---

# Chapter-outline approach — The Burial Mound

Chapter outlines are **not a separate LLM call** in the current engine — the brainstorm `story`
output's `chapters[]` array IS the chapter outline (each carries number, title, act, POV character,
`bridge_from_prior` weaving link, and scene beats). So the "chapter outline" artifact is the
chapters section of the brainstorm result (see `brainstorm-prompt.md`).

The existing project outline has **{len(existing_chs)} chapters**; first 12 for reference:
{fence(sample)}

> Optional deeper pass (not wired yet): expand a single chapter's beats via the brainstorm system
> prompt focused on one chapter + the `scene.event_list` seed. Flagged as a follow-up if you want
> per-chapter beat sheets beyond what the outline carries.
""",
    encoding="utf-8",
)

# ---- 4. Chapter (write) ----------------------------------------------------------------------
ch_system = _build_write_system(genre_slug=genre, outline=outline, revision=False)
# Mirror chapter_step._op_write user-prompt assembly for chapter 1.
parts = [
    f"PROJECT: {title}",
    "CHAPTER NUMBER: 1",
    "",
    f"OUTLINE:\n{json.dumps(outline)[:4000]}…(truncated for the doc; the engine sends the full outline)",
    "",
    f"CHARACTER ROSTER:\n{_roster_text(roster)}",
    "",
    "Write chapter 1 in full, following the craft rules in the system prompt.",
]
ch_user = "\n".join(parts)
(out / "prompts" / "chapter-prompt.md").write_text(
    f"""---
name: Chapter prompt — The Burial Mound
description: The exact system + user prompt the engine submits to chapter.write (per chapter)
type: reference
tags: [workbench-test, prompts, chapter, the-burial-mound]
---

# Chapter (write) prompt — The Burial Mound

**Engine call:** `POST /internal/write/chapter` · `op="write"` · `project_id={proj['id']}` ·
`llm_strategy="sonnet"` · max_tokens 8192 · **craft-revision loop** (draft → craft-QA → revise low
dimensions → re-QA, up to `max_craft_passes`).
**Note:** the chapter step loads the roster from `story_bible_v2` character entries — this project
has none there (its 4 characters live in the outline JSONB), so the separate roster is empty and the
character detail reaches the model via the OUTLINE block instead.

Composed as: prime directive → genre → story arc → scene seeds (pov_selector, bme_check,
turn_density, info_as_drama, description, pov_bridge) → prose seeds (transparent, diction, dialogue)
→ research seeds (no_dumping, local_color) → fix_now → no_boring. (Revision mode would prepend the
locked-roster seed.)

## System prompt
{fence(ch_system)}

## User prompt (chapter 1; outline truncated here for readability — engine sends the full outline)
{fence(ch_user)}
""",
    encoding="utf-8",
)

# ---- 5. Chapter Q/A --------------------------------------------------------------------------
qa_system = _build_qa_system()
(out / "prompts" / "qa-prompt.md").write_text(
    f"""---
name: Chapter Q/A prompt — The Burial Mound
description: The exact system prompt the engine submits to chapter.qa (craft-QA scoring)
type: reference
tags: [workbench-test, prompts, qa, the-burial-mound]
---

# Chapter Q/A prompt — The Burial Mound

**Engine call:** `POST /internal/write/chapter` · `op="qa"` · model `claude-sonnet-4-6`. Scores the
chapter 0.0–1.0 on each guide dimension (character/outline/dialogue/prose/turn-density/no-boring/
period-language) and lists findings for any dimension < 0.8. This is the "does it follow the guide?"
review the craft-revision loop also runs internally.

## System prompt
{fence(qa_system)}

## User prompt
{fence("PERIOD: Late Woodland to colonial-contact Chesapeake (with a modern frame)\\n\\nCHAPTER:\\n<the generated chapter text>")}
""",
    encoding="utf-8",
)

print("wrote 5 prompt docs to", out / "prompts")
