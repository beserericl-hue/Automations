---
name: Craft repair — what works and what destroys the book
description: Three automated mechanisms for fixing pacing and flat prose in a finished chapter were measured and all three damage the text; the two that work are fixing it upstream in the planner and routing findings to a human as line-level suggestions. Includes the numbers, so nobody retries the failed ones.
type: concept
tags: [engine, chapter-write, qa, craft, pacing, repair, 2026-10]
last_reviewed: 2026-10-20
---

# Craft repair — what works and what destroys the book

The [[book-scale-benchmark]] score table split cleanly: every dimension that some pass corrects
scores 0.91–1.00, and the only weak ones are the two that nothing ever checked. The engine verified
facts and never verified that anything *happened*.

| dimension | fails in | corrected by any pass? |
|---|---|---|
| `story_turn_density` | **51/96** | no |
| `no_boring_paragraphs` | **39/96** | no |
| `prose_transparent` | 10/96 | no |
| everything else | 0–4/96 | yes — drift |

38 of 96 chapters pass all eight. The failing set is overwhelmingly the same pair, which is why two
adjacent chapters can show an identical-looking report — not a canned scorer (93 distinct score
vectors across 96 chapters) but a genuine, systematic shortfall in one place.

## Three mechanisms that do not work

All three were run against real chapters and scored by the same rubric.

**1. Whole-chapter revision.** Six attempts across three chapters under two different prompts. Every
one came back at **48–80%** of the original and was rejected by the length guard. An earlier repair
that ran without a guard cut chapter 30 from **7,000 words to 2,800** to "align" it.

**2. Section-wise revision, deletion forbidden.** The hypothesis was scale: 7,000 words is too much
to revise surgically, but a ~1,300-word section between scene breaks is small enough to hold. Given
a hard additive contract — *do not shorten, do not delete, fix pacing by making something happen* —
and a length floor enforced in code:

| ch | length | craft mean | turns | flat |
|---|---|---|---|---|
| 86 | **1.29×** | 0.856 → 0.741 | 0.72 → 0.55 | 0.74 → 0.52 |
| 25 | **1.23×** | 0.860 → 0.805 | 0.72 → 0.61 | 0.74 → 0.65 |
| 23 | **1.44×** | 0.850 → 0.879 | 0.52 → 0.72 | 0.74 → 0.79 |

Two of three got *worse*, and the chapters grew 23–44%. Forbidding deletion did not fix the
mechanism, it **inverted** it: told to make something happen without shortening, the model pads. The
one chapter that improved was the worst-paced of the three, which is where regression to the mean
shows up, so it does not carry the result on its own.

**3. "Run Q/A until it passes."** Never built, deliberately. Given 1 and 2, an unbounded loop
converges on a chapter with good scores and the wrong length — the worst outcome, because it looks
like success.

**The common thread:** the model cannot improve pacing in finished prose without substantially
changing its size, and the size change is itself the damage. Deletion and padding are the same
failure wearing different clothes.

*Caveat on the control arm:* the whole-chapter arm of experiment 2 was attempted three times and
never produced a valid number — a bad import, then `max_tokens=32000` tripping the SDK's
"streaming required over 10 minutes" guard, then a crash on teardown. Twice it silently returned the
untouched chapter and reported a score, which is its own lesson: **an experiment arm that no-ops
looks exactly like an arm that had no effect.** Both runs were caught only because the word count
came back byte-identical. The conclusion does not rest on it.

## Two mechanisms that do work

**Upstream, at the planner.** `SubChapterBrief.story_turn`: the planner must name in one sentence
what is DIFFERENT at the end of each sub-chapter, the final one included, and the writer receives it
as a hard ending contract. Measured over twelve chapters, each against its own earlier self:
`story_turn_density` **0.641 → 0.782**, 95% CI **[+0.064, +0.217]**, under-threshold **10/12 → 5/12**,
no dimension regressed, no extra cost per chapter. Details and the length caveat in
[[book-scale-benchmark]].

**Downstream, as line-level suggestions a human accepts.** Craft findings now carry `quote` (exact
chapter text, verified by `anchor_findings`) and `replacement` (finished prose), and feed the
existing annotations surface as a third source beside `genre_eval` and `drift_scan`.

The safety property is structural rather than guarded: **Apply performs a literal span replacement**,
so a chapter cannot shrink to 2,800 words or balloon to 9,130. The damage mode is removed by the
mechanism, not caught by a threshold. Apply snapshots the prior text first and 422s if the target is
no longer present, so every accepted suggestion is reversible from the Versions tab.

An unverified quote loses both its quote and its replacement and survives as a note. That matters
because Apply searches literally: an invented anchor would be a button that fails on click.

## The division of labour this implies

* **Continuity, consistency, plot direction, story arc** — fully automatic and already working. The
  book run found 14 drift problems mid-assembly, corrected them, and an independent read of all 96
  finished chapters found none left.
* **Pacing, flat paragraphs, prose clarity** — machine finds and drafts, author decides. Not because
  the machine cannot write the fix, but because it cannot be trusted to apply it unsupervised at
  chapter scale.

## Related: the repair had been lying

Found while investigating this. `_op_repair` rewrote and persisted a chapter without re-scoring, so
`metadata.qa_report` kept describing the previous draft — chapters 0, 1, 25 and 77 were rewritten at
20:52 and showed reports generated at 20:40 under a "5/8 passed" badge. Nothing compared a repair
against what it replaced either, so a repair that made a chapter worse was persisted exactly like
one that improved it.

Repair now scores before and after, keeps the better text, and rolls back when the craft mean drops
more than 0.02 — a tolerance, not zero, because re-scoring moves the mean slightly on its own.
Reports carry a SHA-256 fingerprint and word count of the prose they scored; the panel says "This
report is out of date" when they diverge. All 96 reports were regenerated: **0 stale, 0
unconfirmable.**

Refreshing the five stale ones showed those repairs had in fact helped slightly — ch49 went
0.62 → 0.74 on turns and 0.74 → 0.83 on flat paragraphs — which nobody could see because the score
was never recomputed.

## Measurement notes worth keeping

* **Scorer stability.** Same twelve chapters, identical text, scored 2.5 hours apart: mean drift
  **−0.003, sd 0.010, CI [−0.009, +0.002]**. The scorer is stable at the level of a 12-chapter mean.
  A *single* call on a single chapter swings about ±0.03 on the mean and ±0.07 on one dimension, so
  per-chapter deltas under ~0.1 are noise. The ±0.09 figure quoted earlier in the project is the
  variance of *regenerating prose*, not of scoring it — a conflation worth not repeating.
* **Always compare paired.** A group of 12 deliberately-weak chapters scored 0.886 against the other
  84 at 0.893; that comparison measures the sampling, not the change. Each chapter against its own
  earlier self is the only valid form here.
* **Cost windows are guesses.** A 1.5-hour window put the twelve-chapter run at $0.76/chapter; the
  run's own start time put it at **$0.45**. The window had swallowed an earlier experiment on three
  of the same chapters.

## See also

[[book-scale-benchmark]] · [[remaining-work-inventory]] · [[chapter-optimization-sprint]]
