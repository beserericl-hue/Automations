# F1 (write-workshop) — test plan

Every test required to validate the F1-A (step-service ports + writing-craft layer) and F1-B (hub
routing + cutover) sprint. Three layers: **unit** (fast, no network), **system** (a deployed step or
the gateway, real DB/LLM), **E2E / regression** (the full tool path against real DB stories and
outlines, with parity vs the n8n baseline).

Acceptance gate for cutover (F1-B): every system test green on DEV + L5 parity ≥0.95 vs the n8n
baseline + the craft-QA rubric ≥0.8 on each dimension, sustained over a 7-day DEV shadow.

Legend: ✅ implemented · 🔨 to build this sprint · ⏳ gated/after cutover.

---

## 1. Unit tests (pytest, no network — `engine/tests/`)

### Craft layer (`follett_seeds`)
- ✅ `test_follett_seeds.py` — all 40 documented `follett_seeds.*` keys present + non-empty; load into store; `compose_craft_system` orders prime→genre→arc→seeds; unknown key fails loud.

### chapter_step
- ✅ `test_chapter_craft.py` — write-system composes prime+genre+arc+scene/prose/character seeds; revision mode prepends locked-roster; QA system embeds the guide rubrics + ChapterCraftQa; `_op_write`/`_op_qa` fixture paths return valid shapes with all 7 QA dimensions.
- 🔨 `test_chapter_write_context.py` — `_load_context` maps `writing_projects_v2` (genre_slug/outline/title) + `story_bible_v2` roster correctly (mocked supabase); empty-DB → fixture.
- 🔨 `test_chapter_llm_strategy.py` — `llm_strategy` → model pin (haiku→cheap, sonnet→default, tier-default→default); max_tokens floor.
- 🔨 `test_chapter_word_count.py` — word_count counts real tokens; sub_chapter_count override honoured.

### chapter_qa craft rubric (deterministic pre-filters)
- 🔨 `test_qa_turn_density.py` — story-turn counter flags <1/8pp and >1/3pp.
- 🔨 `test_qa_no_boring.py` — boring-paragraph regex pre-filter (no dialogue + no action verbs + >100 words) flags/ passes correctly.
- 🔨 `test_qa_dialogue.py` — said-ratio + phonetic-dialect (apostrophe-heavy) detector.
- 🔨 `test_qa_period_language.py` — per-period anachronism list pass (deterministic) + fallback.

### research_step
- 🔨 `test_research_craft.py` — derive/perplexity/scene_seed system prompts compose the `follett_seeds.research.*` fragments; output schema carries {fact, citation, scene_seed, surprise_angle, background_only}.
- 🔨 `test_research_synthesis.py` — synthesis maps Perplexity citations into the report; setback_opportunity branch.

### brainstorm_step + edit_outline
- 🔨 `test_brainstorm_craft.py` — outline system composes genre + arc + `plot.*` + `character.*` seeds; `outline_gate` self-validation invoked.
- 🔨 `test_outline_gate.py` — gate scores scene-count (50–100), per-chapter dramatic question, POV count (2–6), wow-factor presence; fails a thin outline.
- 🔨 `test_edit_outline_locked.py` — edit_outline preserves locked roster (3-layer lock), does not regenerate from scratch.

### media / library / story_bible / approval / notify
- 🔨 `test_media_cover_art.py` (KIE.AI happy + DALL·E fallback, mocked), `test_media_scrape.py` (Firecrawl error filter).
- ✅/🔨 `test_step_services_smoke.py` — already smoke-tests every step's `/run` contract; extend with real-op assertions per service.
- 🔨 `test_library_crud.py`, `test_story_bible_crud.py`, `test_approval_lifecycle.py` (issue→validate→expire→404, S-15), `test_notify_email.py` (Postal payload shape).

### shared library (already covered, keep green)
- ✅ structured-output coercion, postal client, persist mapping, render-via-workbench, etc.

---

## 2. System tests (deployed step / gateway, real DEV DB + LLM)

Suite B from `engine-api-system-tests.md`, one row per tool. Run against the DEV
`writer-engine-runtime` after deploy.

| ID | Tool | Assert |
|----|------|--------|
| 🔨 **S-CH-1** | chapter.write | real chapter generated from a real `writing_projects_v2` outline + roster; word_count in target; craft seeds present in the call |
| 🔨 **S-CH-2** | chapter.qa | craft-QA returns all 7 guide dimensions; flags a deliberately craft-violating chapter (<0.8) |
| 🔨 **S-CH-3** | chapter.extract-bible | new bible entries upserted to `story_bible_v2`, idempotent on chapter_run_id |
| 🔨 **S-CH-4** | chapter.scan-drift | drift-scan byte-equal to n8n drift output on the same input |
| 🔨 **S-RE** | research | derive→Perplexity→synthesis returns a cited report + scene seeds; Perplexity key present |
| 🔨 **S-BR** | brainstorm | outline passes `outline_gate`; genre+arc+craft reflected; characters carry twist/dramatic-question fields |
| 🔨 **S-OUT** | edit-outline | targeted edit preserves locked roster; ≠ full re-brainstorm |
| 🔨 **S-MED** | media | cover-art image produced; scrape-url returns cleaned content |
| 🔨 **S-LIB/S-SB** | library / story_bible | CRUD + lifecycle |
| 🔨 **S-APP** | approval | issue/validate; expired token → 404 |
| 🔨 **S-NOT** | notify | Postal send (sandbox) |
| ⏳ **S-15-load** | chapter fan-out | parallel sub-chapter writes scale (L6 smoke) |

---

## 3. E2E / regression (full tool path, real DB stories + outlines, parity)

- 🔨 **R-CHAPTER-DB** (`scripts/f1a-chapter-regression.py`) — **the DB-backed regression**: pull every `writing_projects_v2` row with a non-empty outline (18 on DEV across all genres), run `chapter.write` then `chapter.qa` against each, and report per-project: word_count, all 7 craft-QA scores, and any findings. Pass = every chapter generates and scores ≥0.8 on every guide dimension. This is the "does the character/outline/dialogue/story follow the guide?" gate run over real material.
- 🔨 **R-PARITY-CHAPTER** — L5 parity: same project through the engine vs the n8n `Worker - Write Chapter`; cosine/rubric similarity ≥0.95 on structure + craft dimensions.
- 🔨 **R-BRAINSTORM-DB** — generate outlines for a sample of premises; every outline passes `outline_gate`; spot-parity vs n8n brainstorm.
- 🔨 **R-RESEARCH-DB** — research a real historical topic; findings cited; scene seeds reference existing characters.
- ⏳ **R-SHADOW** (F1-B) — hub routes both n8n + engine for 7 days; shadow-diff dashboard ≥95% agreement before flipping each tool.
- ⏳ **R-CUTOVER** (F1-B) — after flip, PROD tool dispatches to the engine; smoke each tool on PROD; n8n tool archived (90-day rollback).

---

## How to run

```bash
# Unit (fast, no network)
cd writers-workbench/engine && unset VIRTUAL_ENV && .venv/bin/python -m pytest tests/ -q

# DB-backed chapter regression (real outlines + live LLM)
ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  .venv/bin/python scripts/f1a-chapter-regression.py --limit 18 --min-score 0.8
```

CI runs the unit layer on every PR (the engine suite). System + regression run against DEV after
deploy; parity + shadow gate the F1-B cutover.
