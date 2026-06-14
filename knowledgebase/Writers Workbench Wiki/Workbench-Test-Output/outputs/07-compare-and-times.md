---
name: Engine vs n8n compare + generation times — The Burial Mound
description: Engine-vs-n8n chapter compare + per-stage generation times (optimization baseline)
type: reference
tags: [workbench-test, compare, timing, the-burial-mound]
last_reviewed: 2026-06-02
---

# Engine vs n8n — compare + generation times

## Chapter length + time

| Chapter | Engine words | n8n words | Engine time | n8n (UI, created) | passes |
|---|---|---|---|---|---|
| ch0 The Recognition Testimony | 3418 | 6633 | 114.3s | 2026-03-23 | 0 |
| ch1 The First Copper | 2714 | 8070 | 264.9s | 2026-03-23 | 1 |
| ch2 The River's Gift | 2621 | 7990 | 234.7s | 2026-03-25 | 1 |

## Per-stage engine times

| Stage | seconds | result |
|---|---|---|
| 01_outline | 300.1 | FAIL |
| 02_research | 297.6 | ok |
| 05_chapter_00 | 114.3 | ok |
| 05_chapter_01 | 264.9 | ok |
| 05_chapter_02 | 234.7 | ok |

## Findings

1. **Chapter length gap (headline).** Engine chapters are ~2.6–3.4k words from a single 8192-token
   call; the n8n UI chapters are ~6.6–8.0k words. n8n wrote in **sub-chapters** (multiple LLM calls).
   Matching full length needs the **sub-chapter fan-out** (roadmap F1-1) — the current chapter step
   is a single draft + craft-revision loop, not yet fanned out.
2. **300s synchronous edge limit.** Brainstorm (a 63-chapter outline) and a full prologue exceed
   Railway's ~300s public-request timeout → 502. Long write tools must run **async** (enqueue + ack
   + poll/callback) — which the hub design already specifies. Draft-only chapters (~115s) and 1-pass
   chapters (~235–265s) fit under the limit.
3. **Craft-QA discriminates.** Even after 1 revision pass, chapters score below 0.8 on
   outline-adherence / no-boring / dialogue — consistent with the 18-outline regression. A 2nd
   revision pass (or the fan-out) would lift these.
4. **Schema/contract bugs fixed during the run:** research category casing (#111), chapter-QA
   double-envelope + draft-loss-on-QA-failure (#111), retired Perplexity model (#112).

These per-stage seconds are the **baseline for the chapter-optimization sprint**.
