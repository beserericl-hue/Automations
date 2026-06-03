# Compare & Times — run 1 (before) vs run 2 (after fixes)

## Chapter length — the core fix

| Chapter | Run 1 (engine, pre-fan-out) | n8n production baseline | **Run 2 (engine, fanned)** | Subs | Time |
|---|---|---|---|---|---|
| 0 | 3,418 | 6,633 | **10,678** | 5 | 438s |
| 1 | 2,714 | 8,070 | **10,024** | 5 | 444s |
| 2 | 2,621 | 7,990 | **13,465** | 5 | 559s |
| **Σ ch0-2** | **8,753** | **22,693** | **34,167** | | |

Run 2 is **3.9×** the first engine run and **1.51×** the n8n baseline across the three sampled chapters.

## Outline scale

| | Run 1 | **Run 2** |
|---|---|---|
| Outline status | **error (truncated mid-JSON at char 63,385)** | **complete** |
| Chapters | 0 (errored) | **59** (Prologue 0 → 57 → Epilogue 58) |
| Characters | 0 (errored) | **9** (3 POV ancestors + protagonist + antagonists + allies) |
| Time | n/a | 242s |

The first run's outline failed with `Unterminated string ... (char 63385)` — a 50-70 chapter outline overran 16384 tokens. Streaming (#118) at 32768 tokens fixed it: the full novel outline now completes.

## QA depth (new in run 2)

| Chapter | character_consistency | research_gaps (count) |
|---|---|---|
| 0 | 0.95 | 0 |
| 1 | 0.95 | 0 |
| 2 | 0.9 | 0 |

The craft-QA now scores **character_consistency** (roster/voice/relationships stay stable) and emits **research_gaps** so the revision loop can add research where a period claim needs verifying — per the "Q/A and reviews must also add research if needed, and make sure characters remain consistent" directive.

## Generation times (run 2, DEV, async)

| Step | Seconds | Status |
|---|---|---|
| outline | 242.0 | complete |
| chapter_00 | 438.2 | complete |
| chapter_01 | 444.4 | complete |
| chapter_02 | 558.8 | complete |

All async (arq job_timeout=1800s); no 502s, no truncation, no step errors.
