# Stress test — bugs found & fixed (Workbench-Test-Output-7)

Engine hub (Path B, CR-004/005/006) stress test of The Burial Mound, driven through
`POST /internal/hub` (same entry as Eve), 10 concurrent, `user_id +14105914612`.
Autonomous mode: each bug fixed in place, recorded here, testing continued.

## 1. Every hub-driven chapter write 500'd — missing `chapter_run_id`
- **Symptom:** probe job `worker.write_tool.finish status=error`; `step.error` traceback:
  `ValidationError: WriteChapterRequest.chapter_run_id Field required`.
- **Root cause:** the chapter step required `chapter_run_id`; the n8n path always supplied it, but the
  engine hub (and Eve) do not. Total failure of every chapter write through the hub.
- **Caught by:** the CR-005 worker logging added just before the run (would otherwise have looked like
  84 silently-failed jobs).
- **Fix:** `WriteChapterRequest.chapter_run_id` now defaults via `Field(default_factory=uuid4)` — a run
  id is unique-per-run anyway. Commit `f412af3`.

## 2. Harness `_verify_db` crashed on spaces in the REST URL
- **Symptom:** gate chapter wrote fine, but the harness raised
  `http.client.InvalidURL: URL can't contain control characters` on
  `…topic=ilike.*Chapter 11 research*…`.
- **Root cause:** PostgREST filter values contain spaces; `urllib` rejects raw control chars in a URL.
- **Fix:** `scripts/stress_hub_chapters.py::_req` now `urllib.parse.quote`s the URL with a safe set that
  preserves PostgREST operators (`= & , . * ( ) / ? : %`). Added a `--mirror N` mode to verify +
  vault-mirror an already-written chapter without regenerating (used to mirror ch11).

## Content findings (not code bugs — handled by the repair pass)
- **ch11 drifted** (`aligned=False`): duplicated scene loop; invented antagonist "Harwood" not in the
  roster; Okwi's established role (burying the petition) reassigned to Saya. Story bible WAS used
  (74 entries loaded); research WAS grounded (3 topics) but the detector flagged 5 research gaps.
  → queued for the chapter-`repair` pass.

## 3. 10-concurrent timeout/retry loop — every chapter killed at 30 min (0 completions)
- **Symptom:** 10 jobs `in_progress` for 30 min, 0 DB writes; then all 10 logged a FRESH
  `worker.write_tool.start` at exactly +30:00 (an arq retry). The solo gate (~12 min) completed fine.
- **Root cause:** under 10-concurrent the batch shares ONE Anthropic account's output-TPM (90k Sonnet)
  + the per-process LLM semaphore, serializing ~90 sub-chapter calls, so a single chapter's wall-time
  exceeds 30 min. BOTH binding timers were 1800s — arq `job_timeout` AND the worker→step HTTP read
  timeout (`WORKER_STEP_TIMEOUT_S`) — so arq killed each job at 30 min and retried (`max_tries=2`):
  a perpetual timeout→retry loop that never completes.
- **Diagnosis aided by:** the suppressed step access logs (`uvicorn --log-level warning`) initially
  looked like a hang; the structured `worker.write_tool.start` at +30:00 revealed the retry.
- **Fix (commit 3bbee96):** raise the whole timer chain — `job_timeout` 1800→5400s, `keep_result`
  3600→7200s, `WORKER_STEP_TIMEOUT_S` 1800→5460s (just above job_timeout so httpx isn't the killer),
  harness poll ceiling 2400→6300s.
- **Go-live finding:** the throughput ceiling is the **account-wide Anthropic TPM** (the Redis budget
  is shared across instances), so adding engine instances does NOT speed up simultaneous heavy writes —
  only a higher Anthropic tier does. 10 truly-simultaneous chapter writes are inherently slow on Tier 4.

## 4. Telemetry read ~90% drifted because aligned was the PRE-correction state
- **Symptom:** the write pass stored ~85-90% of chapters as `aligned=False`, yet the persisted text
  was the cycle-2-corrected version. The number reflected "cycle-1 found something to fix", not the
  final state.
- **Root cause:** `_drift_correct_pass` returned the pre-correction drift report; the write op persisted
  the corrected text but that stale report.
- **Fix (commit d3b7e40):** re-scan the CORRECTED text and report the final drift, so `aligned`
  reflects reality and the repair pass can target chapters that STILL drift.

## 5. Repair didn't persist when it found a chapter already clean
- **Symptom:** re-scanning a clean chapter left the stale `aligned=False` in `chapter_qa_v2`.
- **Root cause:** `_op_repair` persisted only when `passes>=1` (a correction happened).
- **Fix (commit bab7cac):** repair always persists the post-scan state when persist is requested, so a
  verified-clean chapter flips to `aligned=True`. Added harness `--repair-drifted` (re-scan + fix every
  aligned=false chapter through the hub, 10-concurrent).

## Write-pass result (10-concurrent, ch12→95)
- **84/84 chapters completed, 0 failures** through `POST /internal/hub` (same entry as Eve).
- Wall-clock ~109 min for 84 chapters at 10-concurrent (~1.3 min/chapter effective); per-chapter
  600-1350s. Words 5040-10454, avg ~7,776. Story bible used (74 entries loaded into the gate prompt);
  research grounded per chapter. Pre-correction drift 71/84 — true rate from the repair re-scan.

## 6. ROOT CAUSE of persistent drift — polluted story bible → self-contradictory roster
- **Symptom:** after BOTH cycle-2 correction and a full repair pass, 62/85 chapters still `aligned=False`
  (177 drift items; 95 factual contradictions, 47 beat deviations, 35 interpretive). The correction
  loop never converged.
- **Root cause:** the writer AND the drift detector took their character roster from `story_bible_v2`,
  which the per-chapter bible extraction pollutes — a NEW row per name variant: "Marcus"/"Marcus Fenn"/
  "Marcus Redcloud", 8 "Tayak" variants, 5 "Wren", possessives ("Kimi's boyfriend", "Tayak's
  grandmother"), 40 "The ..." fragments. Exact-name dedup never merges them, so the project's bible grew
  to ~1000 entries (297 "character") that CONTRADICT each other (e.g. Marcus tribal-chair "6 years" in
  one entry vs "11 years" elsewhere). A self-contradictory roster makes factual drift UNFIXABLE — the
  writer can't satisfy it and the detector correctly flags the contradiction every pass.
- **Fix (commit 774a8e8):** `_load_context` now derives the roster from the OUTLINE's curated cast
  (19 characters, with exact ages/roles — "Marcus Redcloud: 52, Piscataway…"), falling back to the bible
  only if the outline has none. With a consistent roster the factual contradictions disappear and the
  detect→correct loop can converge.
- **Follow-up (open):** harden bible extraction/dedup (canonical names, drop possessives/"The…"
  fragments) and clean the existing ~1000-entry polluted bible so the UI story-bible tab is usable.

## Repair pass result (pre-roster-fix)
- 72 chapters repaired through the hub; 62 still `aligned=False` — because the roster they were checked
  against was self-contradictory (the bug above). Re-validate after 774a8e8 deploys.
