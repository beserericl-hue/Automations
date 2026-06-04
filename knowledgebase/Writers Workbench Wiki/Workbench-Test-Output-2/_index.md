# Workbench Test Output 2 — Burial Mound (post-fix re-run)

**Project:** The Deepest Layer (working title from engine brainstorm) / source project "The Burial Mound"
**Genre:** ancient-history · **Engine:** Writer Engine (Python), DEV tier
**Run date:** 2026-06-03 · **Tier:** DEV (no PROD resources touched)

This folder is the **second** engine test run, produced **after** the engine fixes for the
"no errors / Follett-scale / sub-chapters / character depth" directive. The first run is the
"before"; this is the "after". See [07-compare.md](outputs/07-compare-and-times.md).

## What changed since run 1
| Fix | PR | Effect |
|---|---|---|
| Async write-tool jobs (arq/Redis) | #114 | Brainstorm + long chapters no longer 502 at Railway's 300s edge limit |
| Sub-chapter fan-out (5 subs/chapter) | #115 | Chapters ~10-13k words instead of ~2.6-3.4k |
| arq job_timeout 300s -> 1800s, max_tries=2 | #116 | Long async jobs finish instead of being killed at 300s |
| Follett-scale outline + QA depth | #117 | Outline demands 50-70 ch + prologue/epilogue + full cast; QA scores character_consistency + lists research_gaps |
| **Streaming large structured outputs** | **#118** | The 59-chapter outline streams at 32768 tokens — **no more mid-JSON truncation** (the last "no errors" gap) |

## Contents
- [outputs/01-outline.md](outputs/01-outline.md) — Follett-scale outline: **59 chapters** (Prologue → 57 → Epilogue) + **full 9-character roster**
- [outputs/05-chapter-00.md](outputs/05-chapter-00.md) — Prologue/Ch0 full text + craft-QA (10,678 words, 5 sub-chapters)
- [outputs/05-chapter-01.md](outputs/05-chapter-01.md) — Chapter 1 full text + craft-QA (10,024 words, 5 sub-chapters)
- [outputs/05-chapter-02.md](outputs/05-chapter-02.md) — Chapter 2 full text + craft-QA (13,465 words, 5 sub-chapters)
- [outputs/07-compare-and-times.md](outputs/07-compare-and-times.md) — before/after word counts, QA, generation times

## Headline result
- Outline: **59 chapters**, **9 characters**, completed in **242s**, **status=complete, zero errors**.
- Chapters (fanned, deep QA): 10,678 / 10,024 / 13,465 words — **matching or exceeding the n8n production baseline** (6,633/8,070/7,990).
- Every chapter carries `character_consistency` (0.90-0.95) and a `research_gaps` list per the new QA depth.
