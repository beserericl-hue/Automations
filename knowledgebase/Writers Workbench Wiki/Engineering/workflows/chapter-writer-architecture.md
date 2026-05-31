---
name: Chapter writer architecture
description: Worker - Write Chapter — sub-chapter parallelism, continuity merge chain, story-bible extraction, and the planned multi-instance load balancing (Sprints 16/17/18).
type: concept
tags: [workflows, chapter-writer, sprint-12, sprint-16-18]
last_reviewed: 2026-05-09
---

# Chapter writer architecture

> **ARCHITECTURAL TRANSITION 2026-05-09**: This page documents the **current n8n implementation**. A multi-sprint rewrite is planned per [[python-migration-roadmap]] starting Sprint 16. The new architecture is documented in [[python-backend/master-plan]] + [[python-backend/service-decomposition]]. The n8n version remains canonical for production until Phase A of the migration completes (~Sprint 17). After cutover, this page will be retitled "Chapter writer architecture (legacy n8n)" and the new architecture documented separately.

The single heaviest path in the system. Generates one full chapter (1500–8000 words) per call. Costs ~$2-5 in Claude tokens per chapter. End-to-end wall time 3-10 minutes.

PROD: `VxO2eG6uvImqaPA2`. DEV: `fsKRGkzphWT62rja`. 36 nodes (post-Sprint 12 + hotfix).

## Pipeline (current — single-instance)

```
Workflow Trigger (executeWorkflow input)
  ↓
get_project_data           (Supabase SELECT writing_projects_v2 by id)
  ↓
build_chapter_context      (executeWorkflow → DEV - Sub - Build Chapter Context)
                            └─ Returns context document with LOCKED CHARACTER ROSTER
  ↓
research_topic             (Perplexity native node)
  ↓
build_sub_chapter_prompts  (Code: prepends context + LOCKED CHARACTER ROSTER + FINAL CHECK
                            to every sub-chapter system prompt)
  ↓
SplitInBatches (sub-chapters)
  ↓
write_sub_chapter          (chainLlm @ Anthropic Claude Sonnet 4.5)
                            └─ promptType=define + concatenated text
  ↓
Aggregate
  ↓
concatenate_chapter        (Code: joins sub-chapter prose; sets new_story_bible_entries=[])
  ↓
continuity_prepare         (Code: builds prompt for continuity merge)
  ↓
continuity_merge_llm       (chainLlm @ Anthropic — merges adjacent sub-chapters,
                            smooths transitions, fixes pronoun drift)
  ↓
continuity_finalize        (Code: applies merged transitions back to chapter text)
  ↓
extract_bible_prepare      (Code: builds do-not-emit list from existing story_bible_v2 + outline characters)
  ↓
extract_bible_llm          (chainLlm @ Anthropic Sonnet 4.5, 4096 tokens, temp 0.2)
  ↓
extract_bible_finalize     (Code: defensive JSON parse, merge new entries onto envelope)
  ↓
update_story_bible         (Supabase UPSERT — wraps each entry in try/catch)
  ↓
insert_draft               (Supabase INSERT published_content_v2 + content_versions_v2)
  ↓
generate_cover_image       (executeWorkflow → Generate Cover Art if no cover yet)
  ↓
send_email                 (HTTP POST /api/email/send via Postal)
  ↓
write_timing               (HTTP POST → INSERT token_usage_v2; failure non-blocking)
  ↓
set_result                 (return envelope to hub)
```

## Why this shape

**Sub-chapter parallelism:** Anthropic's per-request output limit is 4096 tokens (~3000 words). Long chapters need to be split. The `outline.chapters[N].sub_chapters[]` array drives the split. SplitInBatches over this array gives parallelism.

**Continuity merge:** parallel sub-chapters introduce drift (a character's last action in chapter 3-2 doesn't connect to 3-3's opening). The continuity merge runs Claude on adjacent pairs to smooth transitions. Skipped for chapters with ≤2 sub-chapters.

**Story-bible extraction (post-hotfix 2026-04-29):** before this fix, `concatenate_chapter` hardcoded `new_story_bible_entries: []`, leaving `update_story_bible` to insert nothing. **Silent regression for ~2 weeks.** Drift scanner kept flagging characters as "unknown" because they never made it into the bible. Fix: insert a 4-node deterministic extraction stage between `continuity_finalize` and `update_story_bible`. See [[hotfixes]].

**rate_limit_delay node — REMOVED at v1.1.0 release.** The original Wait node was a 120s pause between sub-chapters to avoid Anthropic 429s. Removed in PR #50 (Sprint 8) — replaced functionally by the Anthropic concurrency in BullMQ. Sprints 16-18 will re-introduce smarter rate limiting via Redis-backed token budget.

## What's stored

After a successful chapter write:

| Table | Row content |
|-------|-------------|
| `published_content_v2` | `{user_id, project_id, chapter_number, content_type:'chapter', title, content_text, status:'draft', genre_slug, metadata: {summary, word_count}}` |
| `content_versions_v2` | initial v1 snapshot |
| `story_bible_v2` | UPSERT each extracted entry (deduped by `(entry_type, lower(name))`) |
| `token_usage_v2` | timing + token counts (`execution_time_ms`, `queue_wait_ms`, `llm_time_ms`) |
| `outline_versions_v2` | (only if outline was modified — auto-trigger) |

## LOCKED CHARACTER ROSTER block

Inserted by `Sub - Build Chapter Context` (`jJe84zB3U1HA9xVv`):

```
### LOCKED CHARACTER ROSTER (DO NOT VARY)

Use ONLY the canonical name forms below. The `name_variants` field per character
is the COMPLETE allowed set — anything outside it is drift.

**Captain Vael Reyes**
- canonical: Captain Vael Reyes
- name_variants: [Captain Vael Reyes, Captain Reyes, Vael, Reyes, the Captain]
- role: protagonist

**Elena Morales**
- canonical: Elena Morales
- name_variants: [Elena Morales, Elena, Morales]
- role: deuteragonist
```

This dramatically reduces character drift. Combined with the deterministic drift scanner (Sprint 12 S12-12), the system catches and surfaces drifts that slip through.

## Drift scanner integration

After a chapter is written + extract_bible runs, `outline._character_drift_scan` may be re-populated by:
- Manual scan via `POST /api/content/:id/scan-character-drift` → calls `scan_character_drift` tool.
- Or implicitly by the Annotations panel.

The deterministic regex v4 algorithm has 4 phases. See [[sprint-12-chapter-tools]] for the full description.

## Why we removed the Anthropic rate-limit Wait node

Two failure modes:
1. **The Wait node serialized sub-chapters.** With 5 sub-chapters at 120s each, that's 600s of pure wait time on every chapter write. Latency tax independent of the actual LLM work.
2. **It didn't track actual token usage.** A 2k-token chapter and an 8k-token chapter waited the same. Wrong gate.

Sprints 16/17/18 replace this with a **Redis-backed Anthropic token budget** in the Workbench:
- Sliding-window per-minute output token budget.
- Reserve estimated tokens before dispatch (~5000 × N_sub_chapters).
- Hold/queue when exhausted; refill on the next minute boundary.
- Round-robin select an idle worker from N parallel workflow instances.

## Multi-instance load balancing (planned Sprints 16-18)

Per [user mandate 2026-04-29](../sprints/planned-sprints.md):

> "We are NOT using worker n8n instances (Enterprise v). We have to create multiple write chapter workflows and load balance them to get better performance."

The plan:

**Sprint 16 (analysis, 26 pts)** — set up `DEV - Worker - Write Chapter (TEST)` as a clone for harness testing. Profile current baseline. Build quality benchmarks.

**Sprint 17 (LLM bake-off + dispatcher, 29 pts)** — bench Claude Sonnet vs Opus vs Haiku vs Gemini Pro on chapter writing. Build `ChapterDispatcher` server-side: classifier → token budget → idle-worker selector. Replace Wait node with Redis sliding window.

**Sprint 18 (rollout, 34 pts)** — N parallel `DEV - Worker - Write Chapter (Instance 1..N)` workflows. Shadow mode for a week. Then 10% / 50% / 100% traffic shift. Zero-429 enforcement gates each step. Archive legacy single-instance worker.

See [[planned-sprints]] for sprint details.

## Common gotchas

- **`promptType: 'define'` + `text`** is required on chainLlm nodes. The `messages.messageValues` shape errors with "No prompt specified...". Sprint 12's `derive_questions_llm` and `rewrite_llm` chainLlm fix.
- **`published_content_v2.content_text`** (NOT `content`). No top-level `summary` or `word_count` columns — they live in `metadata` JSONB.
- **`content_versions_v2.content_text`** (NOT `content`). `change_note` (NOT `change_summary`). `changed_by` (NOT `version_type`).
- **Chapter `chapter_number=0`** = Prologue. `999` = Epilogue. Numeric chapters in between. `chapter_count` does NOT increment for prologue/epilogue.
- **Story bible insertion is best-effort.** Each entry wrapped in try/catch; failures don't abort the chapter write.
- **Re-running a chapter write** does NOT delete existing `published_content_v2` row — it inserts a new one with new `chapter_number` (don't do this; use `rewrite_chapter_with_research` instead which updates in-place).
- **Token tracking failure is non-blocking.** `write_timing` node fails open; chapter write never aborts because of timing telemetry.
