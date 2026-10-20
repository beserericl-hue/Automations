---
name: Book-scale benchmark — 96 chapters end to end
description: The first full-book run on the Python engine. 618,865 words across 96 chapters, then Q/A on all of them, then repairs — measured for cost, tokens, throughput and queue behaviour. Settles B9's model question and B11's scaling question with numbers, and exposed four defects that only appear at book scale.
type: concept
tags: [benchmark, scaling, cost, engine, chapter-write, qa, 2026-10]
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

## Remaining questions

* Does the craft loop actually move `story_turn_density`? Being measured by re-running the three
  worst chapters (85, 65, 89 — turn density 0.55, 0.55, 0.41) with it live.
* At 24 concurrent, where does the next wall appear — the semaphore, Redis, or tokens?
* The interactive verdict still cannot tell "50 users waiting" from "one operator ran a batch". It
  names the right lever either way, so it is noise rather than misdirection, but it would page
  somebody for a bulk job.

## See also

[[remaining-work-inventory]] · [[f1a-decisions]] · [[chapter-optimization-sprint]]
