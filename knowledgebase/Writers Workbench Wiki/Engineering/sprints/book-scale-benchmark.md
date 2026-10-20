---
name: Book-scale benchmark — 96 chapters end to end
description: The first full-book run on the Python engine. 618,865 words across 96 chapters, then Q/A, then repairs — measured for cost, tokens, throughput and queue behaviour. Settles B9's model question and B11's scaling question with numbers, exposed four defects that only appear at book scale, and diagnosed the pacing weakness its own score table revealed — fixed at the planner and measured over twelve chapters.
type: concept
tags: [benchmark, scaling, cost, engine, chapter-write, qa, pacing, 2026-10]
last_reviewed: 2026-10-20
---

# Book-scale benchmark — 96 chapters end to end

Run 2026-10-19/20 against DEV, on **production settings**: heavy queue 8 slots, `MAX_CONCURRENT_LLM`
12, sequential sub-chapters, `CHAPTER_LLM_STRATEGY=sonnet`. Turning the knobs up first would have
produced a number describing a configuration nobody runs.

Project: **The Ossuary**, 96 chapters, 12,000 years of Piscataway history. Everything persisted to
the project; every replaced chapter kept its earlier text as a `content_versions_v2` version.

## Headline

| | |
|---|---|
| Words written | **618,865** (median 6,389/chapter, range 4,254–8,755) |
| Scene breaks | 467, median 4/chapter |
| Total cost | **$54.27** |
| Billable tokens | **13,994,223** (input + output + cache read + cache write) |
| LLM calls | 1,149 |
| Wall clock | **99 minutes** for the writes; 9 min for 96 Q/A; ~15 min for 12 repairs |
| Throughput | **58 chapters/hour** at 8 concurrent |
| Failures | **zero** — nothing in the DLQ, `failed: 0` on both queues |

## Cost, by phase

| Phase | Calls | Input | Output | Cache read | Cost |
|---|---|---|---|---|---|
| `chapter.write` | 990 | 4,248,094 | 1,801,709 | 4,823,553 | $44.98 |
| `chapter.qa` | 97 | 902,561 | 173,400 | 256,608 | $5.40 |
| `chapter.repair` | 62 | 473,542 | 158,857 | 60,095 | $3.90 |
| **Total** | **1,149** | **5,624,197** | **2,133,966** | **5,140,256** | **$54.27** |

Per chapter: median **$0.49** (min $0.39, max $1.30) over a median of 11 calls.

**Prompt caching is doing real work.** 5.14M cache-read tokens against 5.62M input — the per-chapter
cached prefix (craft rules + project/outline/roster header + research grounding) is re-read about
five times per chapter, once per sub-chapter, as designed. Without it the input bill is roughly
double.

## The scaling answer

**Output-token use averaged 21,775/min against a 90,000/min Sonnet ceiling — 24%.** Three-quarters
of the account's output budget sat idle for the entire 99 minutes while the queue was saturated.

So at this scale the constraint is **not** tokens. It is the 8 heavy slots and the 12-call LLM
semaphore. On this evidence the engine could run roughly **3× wider — about 24 concurrent
chapters — before tokens bind**, which would put a complete book near 35 minutes at the same $54.

That retires the standing assumption (B9) that account-wide TPM is the near-term ceiling. It is the
ceiling *eventually*; it was nowhere near it here.

### Load profile

196 samples of `/admin/queues`, every 30s:

| | |
|---|---|
| running | median **8.0 of 8** — saturated for the whole run |
| saturation | median 1.00 |
| waiting | median 43, max 96 |
| oldest wait | median 2,963s, max 5,912s |

The queue split (B4) earned its keep: during 99 minutes of saturated heavy work the interactive
queue stayed at depth 0, so a Q/A or chapter plan submitted mid-run would have started immediately.
When the Q/A phase ran it used 24 slots and finished 96 chapters in **9 minutes** — wide and shallow
where the write phase is narrow and deep.

## Quality

Write-time craft median **0.895**. Independent Q/A over the finished book: median **0.894**, and
**zero drift findings across all 96 chapters** — the write-time drift pass flagged and corrected 14
mid-assembly, and an independent reader of the finished prose found nothing left. First verification
of the two-cycle QA design at book scale.

Per dimension, across 96 chapters:

| dimension | median | under 0.8 in | corrected by any pass? |
|---|---|---|---|
| character_follows_guide | **1.00** | 0 | yes — drift |
| character_consistency | **1.00** | 2 | yes — drift |
| outline_follows_guide | 0.92 | 2 | yes — drift |
| period_language_ok | 0.91 | 1 | yes — drift |
| prose_transparent | 0.88 | 10 | **no** |
| dialogue_follows_guide | 0.88 | 3 | **no** |
| no_boring_paragraphs | 0.81 | **39** | **no** |
| story_turn_density | **0.79** | **51** | **no** |

That table is the most valuable output of the run. The engine is reliably excellent at continuity and
accuracy and reliably mediocre at scene-level momentum — and the dividing line is exactly whether
any pass corrected the dimension. See **K8** below.

## Four defects found, all invisible below book scale

**K8 — the craft-revision loop never ran on a real chapter.** It existed only on the single-call
path (`n_sub == 1`), and every real chapter is five sub-chapters, so `craft_passes` was None for all
96. The assembled prose was scored and the score discarded. The seeds instruct the model to
self-police after generating; nothing verified that it had. Fixed: the loop runs on the assembled
chapter with the polish model, bounded and re-scored. Three guards, each for a failure this codebase
has already had — a length floor (post-hoc rewrites shorten), a scene-break check (A13/J2), and an
output ceiling that scales with the chapter, `_revise_chapter` having asked for 8192 tokens
regardless of length. That last one is the **fourth** instance of the truncation-ceiling bug here,
after the 96-chapter outline, the guardrails lens and the craft QA.

**Every chapter was about to be written as "contemporary."** Caught in the pre-run readiness check.
No op derived the era: each did `payload.get("period") or "contemporary"`. All 96 chapters carry
their period in the outline (`ca. 10,500 BCE` … `March 2011`) and nothing read it. `period` drives
the period-language seeds, the research query and the `period_language_ok` score — so the deep-time
half would have been rendered in modern idiom and then marked wrong for being right. Fixed before a
single chapter was queued.

**The capacity verdict was wrong for 169 of 196 samples.** It reported `tpm_bound` —
"bounded by account-wide output TPM" — throughout, while 76% of that budget went unused and the logs
held **zero** budget stalls. The rule read `oldest_wait_s` as token pressure, but queue age under a
bulk submission is depth. `tpm_bound` now requires evidence (a non-zero count of calls that actually
waited for capacity, recorded by the budgets into a shared Redis window); a full queue with no
stalls reads `backlog` and names the real levers. `/admin/queues` exposes
`budget_stalls_last_minute` so the verdict can be checked rather than trusted.

**`window.current` could have read zero forever.** Found while testing the above: it did
`m.rsplit(":", 1)` on whatever Redis returned. `get_redis()` sets `decode_responses=True` so members
are str and it works — but a client built without that keyword yields bytes, `bytes.rsplit(":")`
raises TypeError, and the old `except (ValueError, AttributeError)` did not catch it. One missing
keyword argument in a future caller would have produced budgets reading zero usage and therefore
never limiting anything.

## What this settles

* **B9 — the model question.** Measured separately on one chapter written twice: Sonnet craft mean
  0.458 vs hybrid 0.286 (dialogue 0.72 → 0.00), hybrid 1,400 words short with a stray markdown
  heading. Keep `sonnet`. (Both of those absolute numbers were depressed by the blind-zero defect
  below; the comparison holds because both runs were scored the same way.)
* **B11 — the scaling question.** One instance writes a 96-chapter book in 99 minutes for $54 at 24%
  of the token budget, with zero failures. The next capacity lever is slots, not tier.
* **K7 — scores now mean something.** Before today three dimensions were scored blind and marked
  0.0: the QA was never given the outline beat, and The Ossuary's era-specific casts are not in the
  6-entry roster. Chapter 1 went 0.00 → 0.95 on `outline_follows_guide` once the beat was passed.

## The pacing fix — answered

The score table's own structure was the diagnosis: every dimension some pass corrects scores
0.91–1.00, and the two nothing corrects are the two weak ones. The engine checks facts and never
checked whether anything happens.

**Post-hoc revision does not work at this length.** Six whole-chapter rewrites across three
chapters, under two prompts, all rejected for returning at 48–80% of the original. The craft seeds'
own remedies are subtractive ("cut it", "demote or remove"), so asking a model to fix pacing in
7,000 words produces 4,000 words. That loop now defaults OFF.

**Fixing it at the planner works.** `SubChapterBrief.story_turn` — the planner must name, in one
sentence, what is DIFFERENT at the end of each sub-chapter, the final one included, and the writer
gets it as a hard ending contract. The prompt already asked for "at least one story turn each" in a
trailing clause with no field to put the answer in, so nothing forced the model to name one and the
writer never received one: it was told what each section was ABOUT, never what had to CHANGE.

Measured over twelve chapters re-written 2026-10-20, each scored against **its own** baseline:

| band | n | `story_turn_density` | improved | `no_boring_paragraphs` |
|---|---|---|---|---|
| weak (0.41–0.61) | 6 | 0.508 → 0.752 (**+0.243**) | 6/6 | 0.605 → 0.772 (+0.167) |
| middle (0.72) | 4 | 0.720 → 0.792 (+0.073) | 2/4 | 0.742 → 0.805 (+0.062) |
| strong (0.88) | 2 | 0.880 → 0.850 (−0.030) | 0/2 | 0.905 → 0.825 (−0.080) |
| **all** | 12 | 0.641 → 0.782 (**+0.141**) | 8/12 | 0.701 → 0.792 (+0.091) |

Mean delta +0.141, sd 0.135, **95% CI [+0.064, +0.217]** — excludes zero. Under the 0.80 threshold:
10 of 12 before, 5 of 12 after. No dimension regressed: `outline_follows_guide` +0.068,
`prose_transparent` +0.070, `character_follows_guide` −0.009 (it was already at 0.991). Whole-book
8-dimension mean across the twelve: +0.051.

The twelve span the distribution on purpose. Re-running only the worst would improve whatever the
prompt said — pick the bottom of a distribution with ±0.2 run-to-run noise and the next sample
regresses upward by construction, which is exactly why the earlier three-chapter comparison was
worthless.

**One real caveat: the chapters came back shorter.** Median 5,408 words against the book run's
6,389, and length ratio correlates with the gain (r = −0.40). So part of the improvement is tighter
prose rather than better-shaped prose. The claim that survives the confound is the length-controlled
subset — the five chapters that came back the same length or longer (15, 51, 57, 62, 89) still gained
**+0.104, 95% CI [+0.012, +0.196]**. The gain is real, and some of the headline number is density.
Scene breaks held at a median of 4/chapter, so nothing structural was lost. Whether a 15% shorter
book is acceptable is a product decision, not a defect: there is no explicit per-sub-chapter length
target in the writer prompt at all, so length has always been whatever the model happened to do.

Cost: **$5.38 for twelve chapters, $0.45 each**, 131 calls, 9–12 write calls per chapter against the
book's 10.3. The change is free — same plan call, same five write calls.

(First reading of this put it at $9.16/$0.76 per chapter. The cost window was 1.5 hours and caught
the earlier craft-revision experiments, which had re-run chapters 65, 85 and 89 — the same three.
A cost window is a guess; the run's own start time is the boundary.)

## Remaining questions

* Should the writer prompt carry an explicit length target? It carries none, and the planner change
  made chapters 15% shorter as a side effect.
* At 24 concurrent, where does the next wall appear — the semaphore, Redis, or tokens?
* The interactive verdict still cannot tell "50 users waiting" from "one operator ran a batch". It
  names the right lever either way, so it is noise rather than misdirection, but it would page
  somebody for a bulk job.

## See also

[[remaining-work-inventory]] · [[f1a-decisions]] · [[chapter-optimization-sprint]]
