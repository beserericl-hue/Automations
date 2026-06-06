# CR-005 — Generation telemetry & QA persistence + research/bible closure + operational logging

| | |
|---|---|
| **Status** | In progress |
| **Opened** | 2026-06-06 |
| **Tier** | DEV (build + migrate + validate); PROD at go-live |
| **Goal** | Make every generation run *observable and auditable*: per-chapter drift + craft-QA persisted to the DB for the project view; write-time research persisted to the research report **and** the story bible with a record of what was actually used; and operational logging for the failures that are currently swallowed (research skip, bible-persist fail), the queue/rate-limit behaviour, and LLM truncation/429s. |

## Why

The ch9→end stress test must answer "did it drift / was it researched / is the bible used / did anything fail / how fast" — but today drift reports are dropped, write-time research isn't persisted, QA is buried in a jsonb blob, and the downstream chain has **zero** logging. We'd be flying blind on exactly the dimensions the test exists to measure. (Audit: only `step.error` in the base step wrapper logs anything in the generation chain.)

## What already works (do not rebuild)

- `craft_qa` IS persisted today — in `published_content_v2.metadata` ([chapter_step main.py](../../engine/services/chapter_step/src/chapter_step/main.py)).
- Story-bible scenes/characters ARE extracted per chapter and written to `story_bible_v2` with `last_chapter_seen`.

## Database (project-view-queryable)

### New meta table — `chapter_qa_v2` (migration 025)

Per-chapter-run telemetry, FK to `writing_projects_v2` and `users_v2`. Not a base table → free to evolve. Keeps a *history* of runs per chapter (no unique on project+chapter); the project view picks the latest by `created_at`, mirroring `content_versions_v2`.

Columns: `id, user_id, project_id, chapter_number, chapter_run_id, aligned, drift_report jsonb, craft_qa jsonb, research_used jsonb, bible_entries_loaded jsonb, word_count, sub_chapter_count, craft_passes, cache_read_tokens, cache_write_tokens, model, status, error, created_at`.

### Research closure
Write-time research facts are persisted to **`research_reports_v2`** (one report row, topic-prefixed with project + chapter for traceability) **and** surfaced in **`story_bible_v2`** as `entry_type='research'` entries. The facts woven into the prompt are recorded in `chapter_qa_v2.research_used`.

### "Used" proof
`chapter_qa_v2.bible_entries_loaded` records which bible entries `_load_context` read into the prompt; `last_chapter_seen` is bumped on read. Together with `research_used`, this answers "how do we know they're used."

## Logs (operational — for the run, not the UI)

- Every swallowed `except` in the chapter step (research-grounding skip, bible-persist fail, chapter-persist fail) → `logger.warning` with the reason (no more silent OK).
- `orchestrator.worker.run_write_tool_job` → job start / finish / duration / error, keyed by tool + chapter.
- `rate_limit.anthropic_budget` → log when it waits for TPM capacity and for how long (distinguishes "queued" from "hung" under 10-concurrent).
- `llm.anthropic_client` → `finish_reason`, output-token-cap hits, 429 / retry events (root cause of #142/#144 was invisible truncation).

## Out of scope / follow-on

- The **project-view UI** read of `chapter_qa_v2` (drift/QA dashboard) is a front-end follow-on (Sprint B family). This CR only makes the data exist + queryable.
- Migration 025 is applied to **DEV** Supabase after review; PROD at go-live (CLAUDE.md schema governance).
