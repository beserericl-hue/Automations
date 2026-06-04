# Compare & Times — run 1 vs run 2 vs run 3

## Chapter length

| Ch | Run 1 (pre-fan-out) | n8n baseline | Run 2 (fan-out) | **Run 3 (fan-out + 2-cycle QA)** | Subs | Time |
|---|---|---|---|---|---|---|
| 0 | 3,418 | 6,633 | 10,678 | **7,441** | 5 | 377.7s |
| 1 | 2,714 | 8,070 | 10,024 | **8,889** | 5 | 438.0s |
| 2 | 2,621 | 7,990 | 13,465 | **10,134** | 5 | 860.7s |
| **Σ** | **8,753** | **22,693** | **34,167** | **26,464** | | |

## Outline scale & title

| | Run 2 | **Run 3** |
|---|---|---|
| Title | The Deepest Layer (renamed — wrong) | **The Burial Mound** (locked to DB) |
| Chapters | 59 | **67** |
| Characters | 9 | **7** |
| Story arc tagged per chapter | no | **yes (act + arc_point)** |

## Two-cycle QA + write-time research (new in run 3)

| Ch | drift found (story+char) | QA2 correction | research topics woven | char_consistency |
|---|---|---|---|---|
| 0 | 0 | n/a | 13 | 0.9 |
| 1 | 0 | n/a | 16 | 0.91 |
| 2 | 6 | applied | 16 | — (final QA unparsed) |

## Generation times (run 3, DEV, async)

| Step | Seconds | Status |
|---|---|---|
| outline | 333.0 | complete |
| chapter_00 | 377.7 | complete |
| chapter_01 | 438.0 | complete |
| chapter_02 | 860.7 | complete |
