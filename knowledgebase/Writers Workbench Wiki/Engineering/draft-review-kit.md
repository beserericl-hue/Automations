---
name: Draft Review Kit — editorial review lenses for the final Q/A
description: The 13 EveryInc draft-review skills (Hemingway, Sorkin, Vonnegut, guardrails, line-edit, panel…), what each does, and the design for wiring them into the Writers Workbench final Q/A feature as selectable review lenses.
type: concept
tags: [qa, craft, review, skills, chapter, editing]
last_reviewed: 2026-07-07
---

# Draft Review Kit

Feedback-first editorial review skills for stress-testing prose. Sourced from EveryInc's
[draft-review-kit](https://github.com/EveryInc/draft-review-kit) (MIT, Katie Parrott) and vendored into
this repo at `writers-workbench/draft-review-kit/` (full kit: README, 13 `skills/<name>/SKILL.md`,
Claude/Codex plugin manifests). They are **review**, not generation — run them on prose that already
exists to get sharper judgment on what is weak and what must change. This is the intended input for the
**Writers Workbench final Q/A feature**: today's Q/A scores 9 craft dimensions and lists findings; these
lenses add named, opinionated critique voices a user can invoke on a finished chapter.

## The 13 reviewers

### Reader-response (who gets lost, what gets attacked)
- **asshole** — the meanest, least-charitable read; challenges every claim, pokes every hole. Late-draft stress test.
- **mom** — a loving but non-expert reader; surfaces "smile and nod" moments where the general reader is lost.
- **eli5** — flags jargon without explanation, hand-waving, and skipped steps; expert-tight yet newcomer-clear.

### Craft lenses (one master's obsession each)
- **hemingway** — cuts adjectives, adverbs, qualifiers, redundancy, throat-clearing, passive voice, inflated phrases.
- **sorkin** — pacing + momentum; "walking and talking, not standing and explaining."
- **hitchcock** — suspense + tension; where's the bomb under the table? what does the reader know that a character doesn't?
- **vonnegut** — audits against Vonnegut's 8 rules (start near the end, give characters wants, be a sadist…).
- **sedaris** — finds humor, specificity, absurdity, self-deprecation in pieces that read too self-serious.

### Structure & line
- **dev-edit** — big-picture developmental edit: argument, structure, stakes, payoff. Does the piece *work*?
- **line-edit** — rigorous sentence/word-level pass; returns a clean draft + a summary of changes.

### Orchestration
- **panel** — convenes several reviewers and *synthesizes* consensus, tensions, and prioritized fixes.
- **debate** — reviewers *argue with each other* across rounds until tensions resolve or reach acknowledged stalemate.

### ⚠ Org-specific — needs adaptation
- **guardrails** — scans for evidence/argument/mechanics/AI-tell failures. **Written for EveryInc**: it
  references their "Working Overtime" column, an editor ("Katie"), and companion skills `ai-check` /
  `every-style` that do not exist here. Categories 1–4 (clarity/evidence, argument, mechanics, AI tells)
  are reusable; categories 5–6 are column-specific and must be stripped or rewritten before use in the product.

## Suggested order (from the kit's README)
`dev-edit` (while structure can still move) → one reader lens (`asshole`/`mom`/`eli5`) → one or two craft
lenses (`hitchcock`/`sorkin`/`vonnegut`/`sedaris`/`hemingway`) → `guardrails` before publication →
`panel`/`debate` for high-stakes drafts → `line-edit` last. The point is the *right* pressure, not every lens every time.

## Integration design — final Q/A feature

Today the chapter Q/A surface (see [[overview]]; engine craft layer = `follett_seeds`) produces:
- **Engine QA** — automatic 9-dimension craft scores at write time.
- **Q/A Consistency Report** — on-demand pass/fail rubric with per-check suggestions and a one-click
  *Rewrite to fix Q/A* (server `POST /api/content/:id/rewrite-to-fix-qa` → `chapter.repair`).

These review lenses slot in as **named, user-selected critique voices** on top of that:

1. **Skill content → engine prompts.** Each `SKILL.md` body becomes a review-prompt seed (same pattern as
   the Follett craft seeds in `writer_engine/prompt_store/`). A new chapter op — e.g. `chapter.review` with
   a `lens` param (`hemingway|sorkin|hitchcock|…`) — runs the lens over `content_text` and returns findings
   in the existing `qa_report.checks` shape `{name, status, details}` so the Q/A panel renders them with no
   UI change, and *Rewrite to fix Q/A* can already act on them.
2. **UI.** In the chapter Q/A panel (and the project Q/A tab), a "Review with…" picker lists the lenses;
   `panel`/`debate` map to a multi-lens run that returns a synthesized report.
3. **Cost/routing.** Each lens is one cheap-model pass — add jobTypes to the server classifier
   (`server/src/lib/jobs/classifier.ts`) so credit cost + the chat destination message are correct.
4. **`guardrails` first-pass** only after stripping the Every-specific categories 5–6.

Open question for build: do lenses **score** (feed the 9-dimension rubric) or only **critique** (a
separate findings list)? Recommendation — critique-only to start (lower risk, no rubric coupling), with
*Rewrite to fix Q/A* consuming their findings exactly as it consumes the consistency report today.

## Provenance
Vendored 2026-07-07 from `github.com/EveryInc/draft-review-kit` @ latest. Kit is MIT-licensed; keep the
`LICENSE` file. Not yet wired into the product — this page is the design; the copy is the source of truth.
Related: [[overview]], [[marketing-copy]] (Scene 4 shows the Q/A surface these extend).
