---
name: Engine test plan — The Burial Mound
description: What the engine test on 'The Burial Mound' will generate, where it lands, and the compare + timing approach. REVIEW BEFORE RUNNING.
type: overview
tags: [workbench-test, the-burial-mound, engine, plan]
last_reviewed: 2026-06-02
---

# Engine test — The Burial Mound

A real-project test of the craft engine (the Follett writing-craft layer + the F1-A step ports),
run directly against the deployed DEV engine via `/internal/write/{tool}`, so you can **see the
output artifacts here in the vault before the UI cutover**. Nothing is written to the DB or the UI.

> **STATUS: RUN COMPLETE (2026-06-02).** Artifacts in `outputs/`: outline, research, chapter outlines, story bible, chapters 0/1/2 (with craft-QA), and the engine-vs-n8n compare + per-stage times. Brainstorm (fresh outline) needs async (hit the 300s edge limit). 4 engine bugs found + fixed live (#111, #112).

## The project (read from DEV `writing_projects_v2`)

- **Title:** The Burial Mound · **id:** `1cc6a24a-352c-47f1-a018-c97cf379007d`
- **Genre:** `ancient-history` · **Type:** story · **Status:** in_progress
- **Premise:** Dr. Tayak Moyaone, a Piscataway archaeologist fighting for tribal recognition,
  excavates a burial mound in Charles County, Maryland. Artifacts spanning two millennia — copper
  pendants to colonial documents — each trigger visions of her ancestors' lives, revealing the
  unbroken chain of heritage.
- **Themes:** ancestry & generational connection · identity through cultural heritage · historical
  preservation against erasure · indigenous resilience.
- **Story arc:** none set in the outline (the engine infers structure from the outline + arc seeds).
- **Outline:** **63 chapters** (ch 0 prologue "The Recognition Testimony" → ch 62), 4 characters
  (Dr. Tayak Moyaone; Red Fire Woman / The First Mother; The Ancestors / chorus; Historical Erasure
  / antagonistic force).
- **Story bible (`story_bible_v2`):** 2 world entries (Piscataway Burial Practices; Piscataway
  Ossuary). *No character entries* — the 4 characters live in the outline JSONB, so the engine's
  chapter-step roster (loaded from story_bible characters) is empty; character detail reaches the
  model via the OUTLINE block instead. (Noted for the compare.)

### Why this is a good test
- Historical novel with a **real timeline + real local-color research** need — exactly what the
  research + period-language + local-color craft seeds target.
- **3 chapters already generated in the UI (via n8n)** — a direct engine-vs-n8n compare baseline:
  - ch 0 — The Recognition Testimony
  - ch 1 — The First Copper
  - ch 2 — The River's Gift
- Real **generation times** per stage → a baseline for the chapter-optimization sprint.

## What the test will generate (→ `outputs/`)

| Stage | Engine call | Artifact doc |
|---|---|---|
| Brainstorm outline | `write/brainstorm` op=story | `outputs/01-outline.md` (engine's fresh outline — compare vs the existing one) |
| Research | `write/research` op=run | `outputs/02-research.md` (derived questions + report + scene seeds) |
| Chapter outlines | (the outline's `chapters[]`) | `outputs/03-chapter-outlines.md` |
| Story bible | `write/chapter` op=extract-bible on a generated chapter | `outputs/04-story-bible.md` |
| Chapters/subchapters | `write/chapter` op=write (ch 0,1,2) | `outputs/05-chapter-00.md`, `-01.md`, `-02.md` (each with craft-QA scores + word count) |
| Q/A | `write/chapter` op=qa | folded into each chapter doc + `outputs/06-qa-summary.md` |
| Compare + times | — | `outputs/07-compare-and-times.md` (engine vs the 3 n8n chapters; per-stage seconds) |

Chapters 0/1/2 are chosen specifically because they already exist in the UI — apples-to-apples.

## The prompts (review these)

Each stage's **exact** system + user prompt (composed from the craft layer + this project) is in
`prompts/`:
- [[brainstorm-prompt]] · [[research-prompt]] · [[chapter-outline-prompt]] · [[chapter-prompt]] · [[qa-prompt]]

## Cost / time note
Real LLM generation: 1 brainstorm (~30–90s) + 1 research (multi-query) + 3 chapter writes (each a
draft + craft-revision pass, ~1–3 min) + QA. Expect ~15–25 min wall-clock and a few dollars of
Anthropic spend. **I will not start until you approve the prompts.**
