---
name: F2.5 — Chapter algorithm optimization
description: Separate sprint after F2 (newsletter ship) and before F1-B (hub cutover). Pushes chapter wall-clock past the 15-25% migration baseline via algorithmic changes (pass merging, streaming continuity, tier-down models, two-pass draft/edit), protected by the Sprint-15 quality rubric. No new Docker images.
type: concept
tags: [sprint, chapter, optimization, performance, gate-3, sprint-20-5]
last_reviewed: 2026-05-30
---

# F2.5 — Chapter algorithm optimization

> **What and why.** Sprints 16-17's port of `Worker - Write Chapter` to Python already delivers a stated
> **15-25% p95 latency improvement** vs. the n8n baseline — but the *mechanisms* are infrastructure-level
> (engine-overhead reclaim, parallel sub-chapter writes, prompt caching, multi-LLM, idempotency), not changes
> to how a chapter is written. F2.5 is the separate cycle that **changes the chapter algorithm itself** to push
> wall-clock down another step function while keeping quality at the Sprint-15 rubric.
>
> **Deployment is unchanged.** All optimizations land inside the existing `writer-engine-runtime` container —
> the F1 "no new Docker images" constraint applies here too.

## Where F2.5 sits

[[engine-framework-sprints]] sequencing:

```
F2 newsletter (in flight) ──> F2.5 chapter algo optimization ──> F1-B hub routing + cutover
              │                          │
              └──> F1-A write-workshop ports ──┘
```

F2.5 lands **after F1-A** because:

- F1-A produces the clean Python chapter implementation that F2.5 optimizes against. Optimizing n8n is wasted
  work; the chapter never goes back there.
- F2 PROD-shadow numbers tell us *what wall-clock the optimization must actually hit* — without that data
  F2.5's acceptance criteria are guesses.
- [[sprint-15-testbed]] quality rubric is the parity floor every F2.5 candidate optimization must clear.

## What's already optimized by the F1-A port (NOT F2.5 work)

For context — these are the levers Sprint 16-17 pulls. F2.5 doesn't redo them.

| Optimization | Mechanism | Where it lives |
|---|---|---|
| ~3s/chapter n8n engine-overhead reclaim | Python in-process orchestration replaces `executeWorkflow` chain | F1-1 / S16-3 |
| Parallel sub-chapter writes (n8n was sequential) | `asyncio.gather` over sub-chapter LLM calls | F1-1 / S16-3 (`sub_chapter.py`) |
| Anthropic prompt caching on system blocks | `cache_control: ephemeral` (engine library supports it from F0) | F0 |
| Multi-LLM strategy (`hybrid-draft-polish`, `hybrid-smart`) | Haiku for cheap sub-chapters, Sonnet for polish/merge | F1-1 / S16-3 + Sprint-15 chooses |
| Idempotency on `chapter_run_id` | Replays skip the LLM entirely | F1-1 / S16-3 (`persist.py`) |
| Token-budget gatekeeper | Removes provider-429 retry latency | F0 |
| Right-sized Railway containers + autoscale | Heavy-group sized for chapter load | F3 capacity tuning |

Combined: **~15-25% p95 improvement** vs n8n baseline (per [[master-plan]] decisions table). This is the floor
F2.5 starts from.

## What F2.5 ships (~25 pts, ~2-3 weeks)

Five candidate optimizations. Each is an experiment with a clear ablation: ship it ONLY if Sprint-15 rubric stays
≥0.95 of baseline AND wall-clock improves by at least the threshold below. Run them in this order; each later
optimization may invalidate the next one's measurement, so we re-baseline between.

### F2.5-1 — Merge bible-extract into continuity-merge (5 pts)

**Hypothesis.** The current pipeline runs `continuity_merge` (LLM) and then `extract_bible` (separate LLM)
back-to-back over essentially the same chapter text. Merging them into one structured-output call yields
one round-trip + one prompt-cache hit instead of two.

**Acceptance:**
- Single-LLM merge produces both `content_text` and `bible_entries[]` matching the two-call shape within
  Sprint-15 rubric ≥0.95.
- Wall-clock for the merge phase drops ≥30%.
- `bible_entries[]` dedupe quality (vs the existing dedupe regression set) is unchanged.

**Risk.** Structured-output schema grows; Sonnet may saturate on the combined task. Fallback: keep separate,
revert.

### F2.5-2 — Streaming continuity merge with early start (5 pts)

**Hypothesis.** Today the continuity merge waits for ALL sub-chapter writes to complete. With streaming, the
merge can start consuming sub-chapter tokens as they arrive — overlapping the slowest sub-chapter's tail with
merge prompt warm-up. Net wall-clock = `max(sub_chapter)` instead of `max(sub_chapter) + merge_warmup`.

**Acceptance:**
- Stream-based merge produces same `content_text` (Sprint-15 rubric ≥0.95).
- p95 chapter wall-clock drops ≥15% with no quality regression.

**Risk.** Streaming + structured output is tricky; Anthropic SDK streaming events need careful handling.

### F2.5-3 — Tier-down models per sub-chapter role (5 pts)

**Hypothesis.** Not every sub-chapter needs Sonnet. Outline-bound exposition can be Haiku; prose-heavy
emotional scenes need Sonnet. A per-sub-chapter strategy selector chooses model from the outline metadata.

**Acceptance:**
- Per-sub-chapter strategy lands as a `SubChapterPlan.model` field, defaulting to Sonnet.
- Sprint-15 rubric for tier-down chapters is within 0.02 of full-Sonnet baseline.
- Wall-clock for a representative 5-sub-chapter test drops ≥20%; cost drops ≥30%.

**Risk.** Quality variance per scene type; needs a labeled training set of outline → optimal-model mappings.
The Sprint-15 testbed corpus is the labeled set.

### F2.5-4 — Two-pass fast-draft / deep-edit flow (5 pts)

**Hypothesis.** Instead of one expensive write+continuity-merge pass, do a faster Haiku draft pass over the
whole chapter, then a Sonnet edit pass targeting only the weak spots flagged by a structured
self-critique. Net token cost lower; net wall-clock lower if the edit pass is meaningfully smaller than the
write pass.

**Acceptance:**
- Two-pass flow produces output within Sprint-15 rubric ≥0.95 of single-pass Sonnet baseline.
- p95 wall-clock drops ≥10%; cost drops ≥40%.

**Risk.** Self-critique can identify wrong weak spots; quality regression masked by partial edits. Mitigation:
hard rubric gate + side-by-side A/B in testbed.

### F2.5-5 — Speculative decoding for the polish pass (5 pts)

**Hypothesis.** Where Anthropic SDK supports it (or via Haiku-as-drafter + Sonnet-as-verifier in our own loop),
speculative decoding cuts the polish pass's latency materially without changing output.

**Acceptance:**
- Polish pass wall-clock drops ≥25% with byte-identical output (deterministic temperature).
- No quality regression — same Sprint-15 score.

**Risk.** SDK support is the gating question; if absent, this card defers to Sprint 22+.

## Cross-cutting acceptance for F2.5 as a whole

The sprint exits when, against the Sprint-15 testbed corpus:

1. **Quality floor held**: every shipped optimization scores ≥0.95 of the F1-A Python baseline on every
   Sprint-15 rubric dimension.
2. **Cumulative wall-clock**: p95 chapter wall-clock improves **≥35%** vs F1-A baseline (i.e. ≥50% vs n8n).
3. **Cumulative cost**: token-cost-per-chapter drops **≥30%** at equivalent quality.
4. **Regression suite**: every [[regression-tests]] R-test for chapter operations continues to pass.
5. **Rollback per optimization**: each F2.5-N can be disabled via a single `app_config.chapter_optimizations`
   flag without redeploy.

If any optimization fails its individual acceptance, **revert that card and continue** — the sprint banks the
ones that did clear.

## Out of scope for F2.5

- New chapter capabilities (cross-chapter continuity, citation rewriting, format-Kindle) — those belong in
  their own modules and are covered in Sprints 17/18/21.
- Infrastructure scaling work (right-sizing containers, multi-region) — that's F3 capacity tuning.
- Hub-level routing changes — that's F1-B.

## Deployment

Per the F1 constraint, no new Docker images. The optimizations land in the existing chapter step services
inside `writer-engine-runtime`. The Sprint-15 testbed runs against the engine via the gateway, same as
production.

See also: [[engine-framework-sprints]] · [[python-migration-roadmap]] · [[sprint-15-testbed]] ·
[[engine-api-system-tests]] · [[master-plan]] · [[chapter-writer-architecture]].
