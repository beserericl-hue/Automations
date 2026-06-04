# Workbench Test Output 3 — Burial Mound (two-cycle QA + research-fill run)

**Project:** The Burial Mound · **Genre:** ancient-history · **Engine:** Writer Engine (Python), DEV tier
**Run date:** 2026-06-03 · no PROD resources touched.

Third engine test run on **The Burial Mound**, AFTER the two-cycle-QA + research-fill +
title/arc fixes (PR #120). Prior runs are kept for comparison — see
[[Workbench-Test-Output-2]] (run 2). This folder regenerates **everything**: outline,
research, chapter outlines, story bible, chapters 0/1/2 (with sub-chapters), and QA.

## What changed since run 2 (PR #120)
| Fix | Effect |
|---|---|
| **Title lock** in brainstorm | Outline keeps the exact DB title "The Burial Mound" (run 2 had renamed it "The Deepest Layer") |
| **Coherent named story arc** | One unbroken arc, every chapter tagged act + arc_point; honours the premise's layered structure |
| **Scale 60-72 chapters** | (was 50-70) to reach the 63+ the benchmark implies |
| **QA cycle 1 — drift detect** | Each fanned chapter checked vs its outline beat + arc + roster → story_drift / character_drift / research_gaps |
| **Research-fill** | Flagged research_gaps sent to Perplexity sonar-pro → period facts / local color / events |
| **QA cycle 2 — drift correct** | Streamed full-chapter revision that corrects story+character drift AND weaves the researched facts in |

## Contents
- [outputs/01-outline.md](outputs/01-outline.md) — outline (67 ch) + full character roster + arc
- [outputs/02-research.md](outputs/02-research.md) — research report (preserved — "outstanding")
- [outputs/03-chapter-outlines.md](outputs/03-chapter-outlines.md) — the actual sub-chapter breakdown the engine wrote ch 0/1/2 from
- [outputs/04-story-bible.md](outputs/04-story-bible.md) — character bible / roster
- [outputs/05-chapter-00.md](outputs/05-chapter-00.md) / [01](outputs/05-chapter-01.md) / [02](outputs/05-chapter-02.md) — full text + two-cycle QA
- [outputs/06-qa-summary.md](outputs/06-qa-summary.md) — drift detected + research filled + consistency across chapters
- [outputs/07-compare-and-times.md](outputs/07-compare-and-times.md) — run1 vs run2 vs run3 vs n8n; times
