---
name: Regression tests
description: R-tests R70-R81 + sticky bugs that recur. Must pass per release.
type: concept
tags: [testing, regression, sticky-bugs]
last_reviewed: 2026-05-09
---

# Regression tests

Beyond per-sprint QA tests, certain bug-types have recurred and warrant explicit regression coverage. R-tests are documented in `writers-workbench/AUDIT_REPORT.md` and per-sprint test files.

## R-tests R70-R81 (Sprint 12 prologue/epilogue)

Per memory file, the prologue + epilogue work in Sprint 12 added R70-R81 covering:
- Retrieve outline → revise with prologue/epilogue
- Write prologue (chapter_number=0)
- Write epilogue (chapter_number=999)
- Brainstorm including Prologue / Epilogue
- Story bible handling for non-numeric chapters (Prologue=0, Epilogue=999)
- Single-task rules ("write the prologue", "write the epilogue")
- chapter_count NOT incremented for prologue/epilogue
- Email subject + filename labels correct for prologue/epilogue

Implementation in `Worker - Write Chapter`. Tests are integration-style — run against DEV n8n + DEV Supabase.

## Sticky bug categories

These bug types recur. Test for them on every release:

### B1 — Cross-tier wiring

Symptom: PROD writes appear in DEV (or vice versa).

Specific cases:
- `N8N_HUB_WEBHOOK_URL` has `_dev` on PROD (caught at v1.1.0).
- DEV workflow points at PROD Supabase URL/key.
- ElevenLabs DEV agent uses PROD forwarding tool.
- `executeWorkflow` ref crosses tiers.

Test:
```bash
python3 scripts/verify-env-isolation.py
```
3 layers must all pass: workflow config / data isolation / Railway env.

### B2 — n8n PUT settings rejection

Symptom: PUT-via-REST returns 400 `must NOT have additional properties`.

n8n's PUT only accepts `executionOrder` in `settings`. Strip allowlist before posting.

Test: any release script that updates workflows must use `clone-prod-to-dev.py`'s allowlist OR strip manually.

### B3 — n8n 2.x activeVersion stale

Symptom: REST PUT changes don't take effect at runtime.

Cause: activeVersion is a snapshot at activation time. PUT updates the saved JSON but doesn't rebuild activeVersion.

Test: after every meaningful workflow change, refresh n8n UI tab + click Publish (⌘P). OR via REST: `deactivate → PUT → activate`.

Newsletter PR #74 currently in this state — `Content - Newsletter Agent V2` has new fan-out nodes saved but activeVersion is still old. Operator must Publish in UI.

### B4 — Story-bible silent regression

Symptom: New chapters write fine but Story Bible tab shows "No entries yet."

Cause: `concatenate_chapter` returns hardcoded `new_story_bible_entries: []`. The 4-node `extract_bible_*` chain (Sprint 12 hotfix 2026-04-29) must be present.

Test: write a chapter on a project with characters in `outline.characters[]`. Open Story Bible tab. Should see ≥3 entries auto-created.

Backfill helpers:
- `scripts/hotfix-backfill-story-bible.py` (DEV)
- `scripts/hotfix-backfill-story-bible-prod.py` (PROD)

### B5 — Drift scanner false positives

Symptom: Scan flags story-specific names ("Justice Brennan", "Yick Wo") as unknown.

Cause: HEADER_TOKENS / NON_PERSON_PATTERNS too narrow OR project-specific names not in `outline._scanner_exclusions`.

Test: run `scan_character_drift` on a project that's known clean. Expect zero false positives.

### B6 — Email rate limit lockout

Symptom: Eve user's email fails with 429 after several rapid actions.

Cause: 30/min/user rate limit kicks in when chat ops generate emails (each chapter write sends one).

Test: write 5 chapters back-to-back as one user. Should NOT hit 429.

If repeatedly hits, raise rate or audit which n8n node is calling /api/email/send unnecessarily.

### B7 — Approval token expiry race

Symptom: User clicks approval link 47-49h after issuance. Token expired by 48h cutoff.

Cause: Default expiry is 48h. Tokens issued at very end of cron tick fire when approval cron has been delayed.

Test: simulate 47h-old token → should still approve. 49h-old → should 404.

### B8 — Cloudflare 524 on hub sync calls

Symptom: ChatDrawer "list outlines" shows error after ~100s.

Cause: Cloudflare cuts long sync hub responses at ~100s with 524.

Test: any sync op should respond in <60s. If approaching, classify as async.

### B9 — `+` URL encoding in user_id query

Symptom: PostgREST returns 0 rows when filtering `user_id=eq.+14105914612`.

Cause: PostgREST treats `+` as space.

Test: any URL query param containing user_id must use `encodeURIComponent`. Caught in `scripts/hotfix-backfill-story-bible-prod.py`.

### B10 — Site URL factory default

Symptom: Password reset email lands on `localhost:3000`.

Cause: Supabase Auth → URL Configuration → Site URL defaulted to `http://localhost:3000` on both projects.

Test: trigger password reset; email should link to the production Workbench URL.

Pending fix in Supabase Dashboard. See [[hotfixes]].

### B11 — Annotation apply over-matches

Symptom: Annotation apply replaces the target string in unintended places.

Cause: `text.split(target).join(replacement)` replaces ALL occurrences. Usually desired.

Mitigation: `content_versions_v2` snapshot before mutation. User can restore.

Test: apply an annotation on a chapter where target string appears 3x. Verify all 3 replaced + content_versions_v2 row inserted.

### B12 — Cover image cascade orphan

Symptom: Deleted project's cover image still in storage.

Cause: `cover_image_path` is a text reference (no FK to storage object); cascade-delete on `published_content_v2` doesn't touch storage.

Mitigation: best-effort sweep on account delete. No automated cleanup for project delete.

Test: delete a project. Storage should still have the image (intentional).

### B13 — Soft-delete query miss

Symptom: TrashView shows "0 items" even though deleted_at is set.

Cause: `.is('deleted_at', null)` filter on a list view; trash needs `.not('deleted_at', 'is', null)` OR no filter.

Test: soft-delete a project. TrashView should show it. ProjectList should NOT.

## How to add a new R-test

1. Pick the next R-number (R82, R83, ...).
2. Add one-line description here under Sticky bug categories.
3. Add an automated test in `client/src/test/` or `server/src/test/` whose name includes `regression-rN`.
4. Update `AUDIT_REPORT.md` (legacy doc) if the bug came from there.

## Cross-link

- [[unit-tests]] — automated tests per sprint.
- [[e2e-tests]] — end-to-end coverage.
- [[newsletter-test-plan]] — manual 114-test plan.
- [[hotfixes]] — sticky fixes that became R-tests.
