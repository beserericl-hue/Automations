---
name: Outputs (readme)
description: Generated engine artifacts for The Burial Mound land here after the approved run.
type: reference
tags: [workbench-test, outputs, the-burial-mound]
---

# Outputs — populated after the run

Empty until the [[00-test-plan|test plan]] is approved and the generation run executes. Then this
folder holds:

- `01-outline.md` — engine-generated outline (compare vs the existing project outline)
- `02-research.md` — derived research questions + cited report + scene seeds
- `03-chapter-outlines.md` — the outline's chapter beats
- `04-story-bible.md` — bible entries extracted from a generated chapter
- `05-chapter-00.md`, `05-chapter-01.md`, `05-chapter-02.md` — generated chapters (with craft-QA
  scores, craft-revision passes, and word counts) — the apples-to-apples set vs the n8n chapters
- `06-qa-summary.md` — craft-QA across the generated chapters
- `07-compare-and-times.md` — engine vs the 3 existing n8n chapters + per-stage generation seconds
  (the optimization-sprint baseline)

**Nothing here is written to the DB or the UI** — this is read-only artifact review.
