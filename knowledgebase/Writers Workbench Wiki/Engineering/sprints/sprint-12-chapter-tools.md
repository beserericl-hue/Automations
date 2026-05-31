---
name: Sprint 12 — Chapter tools (Tracks B + C)
description: Rewrite-with-research, research pipeline, context builder, drift scanner, genre evaluator, annotations panel. Track A (parallelism) deferred to Sprints 16/17/18.
type: concept
tags: [sprints, sprint-12, chapter-tools, drift-scanner, genre-eval]
last_reviewed: 2026-05-09
---

# Sprint 12 — Chapter tools

**Released:** v1.1.0 (DEV-complete) + PROD via PR #71 hotfix.
**PRs:** [#31](https://github.com/beserericl-hue/Automations/pull/31), [#32](https://github.com/beserericl-hue/Automations/pull/32), [#33](https://github.com/beserericl-hue/Automations/pull/33), [#38](https://github.com/beserericl-hue/Automations/pull/38), [#39](https://github.com/beserericl-hue/Automations/pull/39), [#40](https://github.com/beserericl-hue/Automations/pull/40) — Track C ship.

Original Sprint 12 had 13 stories grouped into 3 tracks. **Track A removed mid-sprint** at user direction (2026-04-26):

> "Can Track A become a separate sprints. Move it to the end of the other sprints..."

Reasoning: parallelism + perf changes (S12-1, S12-3, S12-4, S12-5) need a dedicated 3-sprint architecture program (Sprints 16/17/18). See [[planned-sprints]].

## Track B — chapter rewrite + research pipeline + context builder

PRs #31 (S12-2/6/7/9 superseded), then continued via #38, #39.

### S12-2 — Build Chapter Context sub-workflow

DEV `jJe84zB3U1HA9xVv`. Inserts a context document into every chapter write so all sub-chapter agents see the same canonical roster + locked names.

`build_context` Code node output:

```
### LOCKED CHARACTER ROSTER (DO NOT VARY)

Use ONLY the canonical name forms below. The `name_variants` field per character
is the COMPLETE allowed set — anything outside it is drift.

**<canonical full name>**
- canonical: <canonical full name>
- name_variants: [<combined: declared + canonical + bare first>]
- role: <role>
- traits: <if present>
```

Mirrored to PROD via PR #71 hotfix (mid-Sprint 12 + post-hotfix combined).

### S12-6 — Tool - Rewrite Chapter with Research

DEV `O8EWqLrqxcTJiWGN`. Hub tool that:
1. Loads chapter + project.
2. Calls `Sub - Research Pipeline` with derived research focus.
3. Rewrites prose via Claude Sonnet using research findings.
4. Toggles `citations_in_prose` based on `project_type`:
   - `story` → false (fiction; no inline footnotes)
   - `non_fiction` / `kindle_book` (non-fiction sub-type) → true (inline citations)
5. PATCHes `published_content_v2.content_text` + `metadata.last_rewrite = {research_report_id, rewritten_at, citations_in_prose}`.
6. Snapshots prior text into `content_versions_v2`.

E2E verified 2026-04-24 (exec 13819):
- User prompt → DEV hub → Gemini → `rewrite_chapter_with_research` → Research Pipeline (ACgIg1WPkIipiy5o exec 13820, success, 10s) → Claude Sonnet rewrite → DB writes.
- Research report `94089947-77f8-415c-9227-16a273814d07` persisted with topic prefix `[Chapter 7 Rewrite] ...`.
- `content_text` updated for chapter `d91a5aad-...` (46,532 chars); `metadata.last_rewrite` records the right fields.
- Fiction mode correctly derived (project_type=`story` → `citations_in_prose: false`); zero footnote markers in rewritten prose.

### S12-7 — Sub - Research Pipeline

DEV `ACgIg1WPkIipiy5o`. Research callable from anywhere.

1. `derive_questions_llm` (chainLlm) — Claude derives 3-5 focused research questions from the input topic.
2. Perplexity native node executes each.
3. Synthesize into a research report INSERTed into `research_reports_v2`.
4. Return report id + summary.

Bug fixed during Sprint 12: `derive_questions_llm` chainLlm node was using `messages.messageValues` shape — fails with "No prompt specified. Expected to find the prompt in an input field called 'chatInput'". Fix: `promptType: 'define'` + concatenated `text` field.

### S12-9 — Wire rewrite into hub

`PROD - The Author Agent` (and DEV) gets `rewrite_chapter_with_research` as an `ai_tool`. Hub system prompt updated.

Server endpoint `POST /api/content/:id/rewrite-with-research` (Sprint 12 / [`server/src/routes/content-actions.ts`](../../../../writers-workbench/server/src/routes/content-actions.ts)):
- Validates input.
- Resolves chapter + project.
- Enqueues a heavy-ops BullMQ job with a pre-formed prompt forcing the hub to call `rewrite_chapter_with_research`.
- 5 vitest tests covering auth / validation / enqueue.

`RewriteWithResearchModal.tsx` + button on `ContentDetail.tsx` (chapters only). Collects `research_focus`, `use_qa_report`, `style_directives`, citation mode (auto/invisible/inline). Submission posts to endpoint; progress via SSE `chat-job-status`.

## Track C — Reviewer / editor tools (PR #40, 24 pts, all green)

### S12-11 — Genre Compliance Evaluator

DEV `e9LEpCM5L7zVpQxl`. Computed-before validator (server computes `evidence.context` from verified `evidence.quote` position rather than trusting Claude's context field — defends against fabrication).

Three-stream output:
- `prose_adaptations` — specific phrasing changes
- `outline_adaptations` — structural changes
- `observations` — non-actionable notes

Persists to `published_content_v2.metadata.genre_eval`. Hub wired with `evaluate_genre_compliance` tool + `ui:evaluate-genre` source bypass.

### S12-12 — Character Drift Scanner

DEV `fJWDHXhle345f6jY`. **Major pivot from LLM-based to deterministic regex algorithm** (`scanner_algorithm: 'deterministic-regex-v4'`) driven by user feedback ("create an algorithm that will work for all chapter sizes").

Cuts wall time from 5+ min to <1 sec, eliminates parse failures, eliminates token-limit issues, eliminates fabrication risk.

Detects three drift classes:

**Phase 0** — reverse-order drift (`<Surname>, <canonical first>` case-file form). Required structural anchor before the surname token (e.g. "Case #2851:", "Subject Name:", "Detainee:").

**Phase 1** — canonical matches with longest-first pattern ordering and consumed-range masking. Bare surname now in `allowed_set` so "Reyes" alone for "Captain Vael Reyes" doesn't false-flag.

**Phase 2** — forward drift candidates (`<canonical first> <unknown surname>`).

**Phase 3** — unknown-person mentions with shape-based noise filter. HONORIFICS expanded (senator, lord, pastor, captain, elder, etc.). HEADER_TOKENS catch bureaucratic/place/institution shapes. Per-project `outline._scanner_exclusions: string[]` for the long tail.

Persists to `writing_projects_v2.outline._character_drift_scan` (NOT metadata — base-table immutability).

**Result on *The Invisible Wall*:**
- 1 real drift surfaced (Ch5 "Rodriguez, Elena").
- 144→32 unknowns (78% noise drop).
- 0 false positives.
- Multi-genre smoke (sci-fi/romance/fantasy/political) clean.

### S12-13 — Shared Annotations UI

NEW story added mid-sprint. See [[annotations-panel]].

Three new endpoints in `content-actions.ts`:
- `GET /api/content/:id/annotations` — merged drift + genre eval. Honours dismissed_annotations. Auto-derives replacement for reverse-order drift.
- `POST /api/content/:id/annotations/apply` — precise span replacement + content_versions_v2 snapshot. Returns 422 on stale anchor.
- `POST /api/content/:id/annotations/dismiss` — appends id to `metadata.dismissed_annotations[]`.

Annotation ID is deterministic: `<source>:<chapter_number>:<kind>:<evidence_normalised>` so the same flag on a re-scan collapses onto the same row.

`client/src/components/content/AnnotationsPanel.tsx` (305 lines) wired into `ContentDetail.tsx` for chapters. Two source sections (drift first, genre second). Each row: severity badge, evidence quote, suggested replacement, Apply / Dismiss buttons.

4 new vitest tests (GET merge + Apply happy path + 422 stale + Dismiss). 9/9 total content-actions tests pass.

## Hand-fix verification (real Ch5 fix on DEV Supabase)

The 2026-04-26 session ran the apply endpoint code path directly:
- Replaced "Rodriguez, Elena" with "Morales, Elena" in chapter `d2063a9f-...` (The Efficiency Report).
- Snapshotted prior text into `content_versions_v2` (version_number=2, changed_by=`annotation_apply`).
- Marked annotation `drift_scan:5:reverse_order_drift:Rodriguez, Elena` as dismissed.
- Re-scan confirmed 0 drift flags.

## Track A — DEFERRED to Sprints 16-18

S12-1 (remove rate_limit_delay), S12-3 (parallel fan-out), S12-4 (continuity merge), S12-5 (timing + dashboard) **removed from Sprint 12** and re-planned at the END of the sprint sequence (after Sprint 15 load test). User reasoning, captured verbatim:

> "The purpose of the wait node between sub chapters was the max limit that claude put on token processing and the exhorbitant number of tokens required to write the sub chapter. We had to make a tradeoff between quality of output and time. The write chapter process needs the architecture looked at to reduce the processing load, and to queue up processes that are not token hogs. We need to analyse the output to determine how the quality chapter writing can be accomplished by different LLM's or a combination of LLMs. Break down the sprints so that we can make this architectual change without the risks you have shown in this sprint."

Now Sprints 16-18. See [[planned-sprints]].

## Stale PRs closed

After PR #40 merge:
- PR #28 (S12-5 timing telemetry) — closed; deferred to Sprint 18-5.
- PR #29 (S12-2 context builder) — superseded by PR #31.
- PR #30 (S12-6/7/9 rewrite-with-research) — superseded by PR #31; older branch had schema + chainLlm bugs.

## Tests

- Server `content-actions.test.ts` — 9 tests covering all 3 annotation endpoints + rewrite-with-research enqueue.
- Drift scanner unit tests in n8n workflow itself (deterministic regex testable offline).

## Common gotchas

- **`promptType: 'define'`** + concatenated `text` is required on chainLlm. The `messages.messageValues` shape errors out.
- **`content_text` not `content`** — common mistake.
- **`changed_by` not `version_type`**, `change_note` not `change_summary` on content_versions_v2.
- **`outline._character_drift_scan`** lives in JSONB on the project — `_scanner_exclusions` too. No UI to edit yet.
- **Stale anchor on apply** → 422, not 500. Surface "Re-scan needed" CTA.
- **`text.split(target).join(replacement)`** replaces ALL occurrences — usually desired.
- **Hub `preprocess_message` trigger keywords** — mentioning "Q/A report" shortcuts to direct_qa_chapter, skipping Agent. Avoid in test prompts.
- **Cloudflare 524** at ~100s on hub responses. Async (queued) ops unaffected; sync hub calls >90s get client-side 524 while tool keeps running.
