# Workbench Test Output 6 — concurrent queueing test (chapters 3-10 of The Burial Mound)

**DEV · 2026-06-05 · project `62cc734f-c861-4210-bc12-e9ea002fcf66` · readable in writersworkbench-develop.up.railway.app AND in the DB.**

8 chapters (3-10) of The Burial Mound were submitted **concurrently** (the queueing/load test),
each a **full 5-sub-chapter** write, **persisted to the database**. This validates: the queue handles
8 simultaneous chapter writes, the shared rate-limit budget (no 429s), prompt caching, the craft-QA
null fix, and drift handling — on different chapters of the same book.

## Result
| Metric | Value |
|---|---|
| Completed | **8/8**, 0 errors, 0 rate-limit failures |
| Wall-clock (all 8 concurrent) | **16.1 min** |
| No drift (aligned) | 5/8 (3 had drift detected; 2 auto-corrected) |
| craft-QA scored | 7/8 (was 0/8 before the null fix #142) |
| Prompt cache | cache_read **342,300** vs cache_write **85,575** (~4:1 → caching working) |
| Per-chapter time | 6.6 / 9.7 / 16.1 min (fast / median / slow) |

## Per-chapter
| Ch | Title | Words | Aligned | Drift (s+c) | QA passes | craft-QA scored | cache_read | persisted |
|---|---|---|---|---|---|---|---|---|
| 3 | The Field [Present — 2024] | 7317 | True | 0+0 | 0 | True | 41120 | True |
| 4 | Stratum One: The Glass Bead [Prese | 8020 | None | 0+0 | 0 | False | 45452 | True |
| 5 | Nora Begins the Story [Present — 2 | 7679 | False | 4+5 | 1 | True | 40080 | True |
| 6 | The Woman Who Ran [Past — 1693] | 7049 | True | 0+0 | 0 | True | 40716 | True |
| 7 | Saya and Okwi [Past — 1693–1694] | 7697 | True | 0+0 | 0 | True | 45192 | True |
| 8 | The Council Meeting [Present — 202 | 7747 | False | 1+5 | 0 | True | 45096 | True |
| 9 | Voss Calls [Present — 2024] | 5353 | True | 0+0 | 0 | True | 39216 | True |
| 10 | Wren's Notes [Present — 2024] | 8307 | True | 0+0 | 0 | True | 45428 | True |

## Chapters (full text, also in published_content_v2)
- [outputs/chapter-03.md](outputs/chapter-03.md) — The Field [Present — 2024]
- [outputs/chapter-04.md](outputs/chapter-04.md) — Stratum One: The Glass Bead [Present — 2024]
- [outputs/chapter-05.md](outputs/chapter-05.md) — Nora Begins the Story [Present — 2024]
- [outputs/chapter-06.md](outputs/chapter-06.md) — The Woman Who Ran [Past — 1693]
- [outputs/chapter-07.md](outputs/chapter-07.md) — Saya and Okwi [Past — 1693–1694]
- [outputs/chapter-08.md](outputs/chapter-08.md) — The Council Meeting [Present — 2024]
- [outputs/chapter-09.md](outputs/chapter-09.md) — Voss Calls [Present — 2024]
- [outputs/chapter-10.md](outputs/chapter-10.md) — Wren's Notes [Present — 2024]
