---
name: Workbench Test Output — Index
description: Engine-generated artifacts + the prompts that produced them, surfaced in the vault so output can be reviewed before the UI cutover. First test project: The Burial Mound.
type: index
tags: [workbench-test, engine, the-burial-mound]
last_reviewed: 2026-06-02
---

# Workbench Test Output

A place to **see the engine's output artifacts before the UI is cut over to the engine**. The engine
write-tools (`/internal/write/{tool}`) currently generate but don't persist to the DB and aren't
wired to the UI yet, so this folder is how we read real output: outlines, research, chapter outlines,
story bible, and chapters/subchapters — plus the exact prompts that produced them.

## Pages

- [[00-test-plan]] — the test plan for **The Burial Mound** (project read, what's generated, compare
  vs the existing n8n chapters, timing). **Review before the run.**
- **prompts/** — the exact engine prompts (system + user), composed from the Follett craft layer +
  the project data:
  - [[brainstorm-prompt]] — outline generation
  - [[research-prompt]] — derive → Perplexity shape → synthesis
  - [[chapter-outline-prompt]] — how chapter outlines are produced
  - [[chapter-prompt]] — per-chapter write
  - [[qa-prompt]] — craft-QA scoring
- **outputs/** — generated artifacts (populated **after** you approve the prompts and the run
  executes). See [[outputs-readme]].

## Status

**Run complete (2026-06-02).** Artifacts in `outputs/`. 3 chapters generated; research done; brainstorm pending async (300s edge limit). See [[07-compare-and-times]].
