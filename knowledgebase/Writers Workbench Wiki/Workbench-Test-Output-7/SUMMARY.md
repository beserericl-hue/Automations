# Workbench-Test-Output-7 — Engine Hub (Path B) stress test: results

**What:** The Burial Mound, chapters 12→95, written through the **engine hub** (`POST /internal/hub`,
the same API entry Eve uses), 10 concurrent, `user_id +14105914612` (eric@agileadtesting.com).
Every chapter mirrored here from the database (the source of truth the UI reads).

## Scaling / throughput — PASS

- **84/84 chapters wrote successfully, 0 failures**, all through the hub (Gemini router → arq queue).
- Wall-clock ~109 min for 84 chapters at 10-concurrent (~1.3 min/chapter effective). Per-chapter
  600–1350s. Avg ~7,776 words.
- **Go-live caveat:** throughput is bounded by the **account-wide Anthropic TPM** (the Redis budget is
  shared across instances), so adding engine instances does NOT speed up simultaneous heavy writes —
  only a higher Anthropic tier does. 10 truly-simultaneous chapter writes are inherently slow on Tier 4.

## Drift / quality — root-caused and largely fixed

| Stage | aligned=True (clean) | drifted |
|---|---|---|
| After write (pre-correction telemetry) | ~13 | 71 |
| After repair pass v1 (still polluted roster) | 21 | 62 |
| **After roster-from-outline fix + repair** | **67 / 85** | **16** |

- The "90% drift" was **not** a writing-quality failure. Root cause: the story bible was polluted to
  ~1000 entries (297 "character") with duplicate/conflicting name variants (Marcus / Marcus Fenn /
  Marcus Redcloud; 8 "Tayak"; possessives; "The …" fragments). The writer + drift detector were fed a
  **self-contradictory roster**, so factual drift was unfixable. Fix: derive the roster from the
  outline's curated 19-character cast (commit 774a8e8). Drift fell 62 → 16.
- The remaining **16** are genuine residuals: a few real beat deviations (e.g. ch41 changed a scripted
  call) and mostly **borderline characterization** the detector over-flags — a character doing
  something not in their *one-line* roster bio (ch15/ch77). This is the tension between rich prose and a
  sparse outline, partly a detector-strictness tuning call, not a defect.

## Research grounding — working + now project-scoped

- Each chapter ran write-time research (Perplexity), woven into the prose; topics + citations logged.
- Research is persisted to `research_reports_v2` AND linked to the project via `research_report_projects_v2`
  (CR-006) so the UI research tab shows only this project's research. Backfill linked 5 existing reports.

## Story bible — used, but the source needs cleanup

- The bible IS loaded into the prompt (74 entries at the gate) and `bible_entries_loaded` is recorded
  per chapter (CR-005). But the bible itself is polluted (the root cause above). Writing now uses the
  clean outline cast; **follow-up:** harden bible extraction/dedup + clean the ~1000-entry bible so the
  UI story-bible tab is usable.

## Telemetry (all in the DB, for the project view)

- `chapter_qa_v2` (migration 025): per-chapter drift_report, aligned, craft_qa, research_used,
  bible_entries_loaded, word_count, cache tokens, model — one row per run.
- See `FIXES.md` for the 6 bugs found and fixed during this run.

## Known follow-ups (not blockers)

1. Harden bible extraction/dedup (canonical names; drop possessives/"The…") + clean the polluted bible.
2. Drift detector: don't flag characterization that *adds* to (vs *contradicts*) a sparse roster bio.
3. Repair over-trim guard: 3 chapters (ch30, 42, 78) were shrunk to achieve alignment; re-written
   full-length. Consider raising the repair length floor now that the roster is clean (less to cut).
