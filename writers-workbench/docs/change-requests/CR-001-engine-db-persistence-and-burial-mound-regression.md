# CR-001 — Engine DB persistence parity + top-down "Burial Mound" regression

| | |
|---|---|
| **Status** | Proposed |
| **Opened** | 2026-06-05 |
| **Tier** | DEV only (no PROD flip in this CR) |
| **Owner** | Eric Beser |
| **Depends on** | F1-A write steps (done), F1-B gate machinery (#129), chapter-outline `plan` op (#126) |
| **Related** | F1-1 (`persist` + `chapter-orch`), F1-7 hub rewiring (separate CR) |

## 1. Summary

Make the **engine persist everything it generates into the database, exactly like the n8n
workflows do**, then prove it with a **top-down regression** that defines the full outline of
*The Burial Mound* and writes the whole run — outline, chapter outlines, research, chapters/
sub-chapters, story bible — into a **new project that is readable from the Writer's Workbench UI**.

## 2. Background — the gap this CR closes

Today the engine's **generate** tools return artifacts but do **not** save them. (Verified in code.)

- `brainstorm` (`story` / `revise-outline`) → returns the outline; **0 DB writes** (never saved to
  `writing_projects_v2.outline` — that is why a revised outline had to be passed back as an override
  to write chapters from it).
- `chapter.write` → only **reads** context (`story_bible_v2` roster, `writing_projects_v2` outline)
  and returns the generated text. **No insert.**
- `research` → returns the report; **no write** to `research_reports_v2`.
- The orchestrator's `run_write_tool_job` runs **one** step and returns — it does **not** chain a
  persist step after generation.

The **persistence steps exist and do real writes**, but they are **separate tools, not chained**:

- `library.insert_draft` → inserts `published_content_v2` (status `draft`); `approve`/`publish`
  update status.
- `story_bible` → upserts `story_bible_v2`.
- `media.cover-art` → uploads the cover to Supabase Storage.
- `persist` / `deliver` → `newsletter_sends_v2`.

The **newsletter saga is the only fully end-to-end DB-writing path** today.

Net: a single `/internal/write/chapter` produces text but nothing lands in the DB, so nothing shows
in the UI. This CR wires generation → persistence so the engine reaches **write-parity** with the
n8n write workflows.

## 3. Definition of Done

A top-down engine run for *The Burial Mound* creates a **new project** and persists every artifact
to the same base tables the n8n workflows use, such that a user opening that project in the **DEV
Writer's Workbench UI** sees: the **outline**, the **chapter outlines**, the **research report(s)**,
the **chapters/sub-chapters**, and the **story-bible** entries — with no manual DB steps.

## 4. Scope — work items

| # | Work item | Persistence target | Notes |
|---|---|---|---|
| **W1** | **Project create/resolve** path in the engine (or via the server `/api`) | `writing_projects_v2` (insert) | A run targets a NEW project: title, genre_slug, user_id, status. Returns `project_id`. |
| **W2** | **Brainstorm persist** — after `story`/`revise-outline`, save the outline | `writing_projects_v2.outline` (update) + `outline_versions_v2` (snapshot prior) | Mirrors n8n `save_outline`. Makes the outline readable + reusable without an override. |
| **W3** | **Chapter persist** — after `chapter.write`, save the chapter | `published_content_v2` (insert draft via `library.insert_draft`) + `content_versions_v2` (snapshot) | content_type=`chapter`, title, body=content_text, project_id, chapter_number, **idempotent on `chapter_run_id`** (re-run does not duplicate). |
| **W4** | **Story-bible persist** — run `extract-bible` on each chapter, upsert | `story_bible_v2` (upsert on project_id+entry_type+name) | Mirrors n8n bible update; keeps characters/places consistent across chapters. |
| **W5** | **Research persist** — after `research`, save the report | `research_reports_v2` (insert) | content/topic/questions/report_markdown, project_id. |
| **W6** | **Chapter-outline persist** — save the `plan` (sub-chapter beats) | `outline_versions_v2` or a chapter-outline meta table (FK) | So the chapter-outline stage is visible/reusable per chapter. |
| **W7** | **Write-orchestrator (`chapter-orch`)** — chain generate → persist | — | One call runs: write → insert_draft → content_versions snapshot → extract-bible → upsert bible. Idempotent on `chapter_run_id`. Off the request path (arq job). |
| **W8** | **Top-down run script** — drives the full Burial Mound regression into a new project | all of the above | brainstorm outline → per-chapter `plan` → research → chapters/sub-chapters → bible, all persisted under the new `project_id`. |
| **W9** | **UI read-back verification** — confirm the new project renders in the DEV Workbench | — | Outline, chapters, research, bible all visible; A5-style UAT checklist. |

## 5. Out of scope (separate CRs)

- **PROD flip / hub rewiring** (F1-7/F1-8) — Tier-2/3, gated on the DEV acceptance test + explicit
  user go. This CR is **DEV only**.
- Prompt-caching optimization (F2.5 follow-up).
- Client React screens beyond what already renders these tables.

## 6. Data model & constraints

- **Base tables are immutable (migrations 008+).** All targets here are **existing base tables**
  (`writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`) plus the
  existing `content_versions_v2` / `outline_versions_v2` — the same tables n8n writes. **No base-table
  ALTER/DROP.** Any new per-feature attribute (e.g. a chapter-run idempotency record, W6 chapter-
  outline store) goes in a **meta table with an FK**, per schema governance.
- **Idempotency:** W3/W7 must be safe to re-run — keyed on `chapter_run_id` (skip/replace, never
  duplicate). W2 snapshots the previous outline before overwrite.
- **Multi-tenant:** every insert carries `user_id` (V2 partitioning) so RLS + the UI's project list
  show it under the right account.
- **Tier isolation:** DEV engine → DEV Supabase only. No PROD resources touched.

## 7. The regression test (top-down — the proof)

1. **Create a new project** (W1): title "The Burial Mound", genre `ancient-history`, a DEV test user.
2. **Brainstorm the outline** top-down (`brainstorm story`), persist it (W2). *(Optionally apply the
   no-visions / oral-tradition revision via `revise-outline`; see [[burial-mound-story-direction-v2]].)*
3. For a defined set of chapters: **chapter outline** (`plan`, W6) → **research** the beat (W5) →
   **write** the chapter/sub-chapters (W3) → **extract + persist bible** (W4) — all via `chapter-orch`
   (W7) so each lands in the DB under the new `project_id`.
4. **Read back in the UI** (W9): open the project in `writersworkbench-develop.up.railway.app` and
   confirm the outline, chapter outlines, research, chapters, and story bible all render.
5. Keep the run's artifacts as a new numbered vault sample folder for comparison
   ([[never-delete-samples]]).

## 8. Acceptance criteria

- [ ] A `chapter-orch` call persists a chapter to `published_content_v2` (+ `content_versions_v2`)
      and its bible to `story_bible_v2`, **idempotent on `chapter_run_id`** (re-run → no duplicates).
- [ ] `brainstorm` persists the outline to `writing_projects_v2.outline` (+ `outline_versions_v2`).
- [ ] `research` persists to `research_reports_v2`.
- [ ] The top-down Burial Mound run creates a **new project** and all artifacts are queryable under
      its `project_id` in DEV Supabase.
- [ ] The new project's outline, chapters, research, and bible **render in the DEV Workbench UI**.
- [ ] Engine CI green; no base-table migrations; DEV-only.

## 9. Risks

- **Duplicate writes** on re-run → mitigated by `chapter_run_id` idempotency (W3/W7).
- **Schema governance** → only base tables + existing version tables; any new store is a meta table
  with an FK (CI `check-base-table-immutability.py` must stay green).
- **RLS / user_id** → a missing/!wrong `user_id` would hide the project in the UI; assert it on every
  insert.
- **Partial runs** → the orchestrator should persist per-chapter as it goes (not all-or-nothing) so a
  long run is resumable and visible incrementally.
