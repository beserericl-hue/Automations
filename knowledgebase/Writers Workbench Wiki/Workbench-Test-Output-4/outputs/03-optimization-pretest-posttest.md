# F2.5 optimization — pre-test (sequential) vs post-test (parallel)

Same chapters, same chapter-outline (plan), written two ways. `parallel_subchapters` writes the 5 sub-chapters concurrently instead of one-after-another.

| Ch | Pre (sequential) | Post (parallel) | Speed | Story similarity (parity) |
|---|---|---|---|---|
| 1 (The Permit [Present — 20) | 6,941w / 333s | 5,903w / 609s | 0.5× | 0.91 |
| 6 (The Woman Who Ran [Past ) | 8,257w / 423s | 7,174w / 212s | 2.0× | 1.00 |

## Finding (honest)

- **Speed is inconsistent.** Ch6 parallel was 2.0× faster; ch1 parallel was 0.5× (SLOWER, 609s) — a concurrent burst of 5 streamed generations hits Anthropic's per-minute token rate limit and gets throttled, so concurrency is not a reliable speedup here.
- **Parallel chapters run ~13-15% shorter** (losing the sequential prior-tail continuity makes the plan-coordinated subs a little less expansive).
- **Stories are structurally similar** (parity score per row) but not identical — expected for two LLM runs.

**Recommendation:** the real win is **prompt caching** (cache the shared system + chapter header across the 5 sub-calls) rather than raw concurrency — it cuts cost/latency without the rate-limit burst. Keep `parallel_subchapters` OFF as the default (it already is); revisit with caching.
