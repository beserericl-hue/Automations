---
name: UI Regression Suite — change log
description: History of the UI regression suite and its findings.
type: log
last_reviewed: 2026-07-02
---

# UI Regression Suite — log

## 2026-07-02 — suite created (Goal 2)

- Built a **complete UI regression suite** from a verified inventory of `App.tsx` + every route
  component (7-agent inventory, cross-checked against source — not the session summary).
- New Playwright specs under `writers-workbench/e2e/regression/` (chromium project, runs vs DEV):
  `nav-render`, `project-detail`, `content-detail`, `library`, `reference`, `settings`, `newsletter`
  (+ shared driver `e2e/pages/regression.page.ts`).
- Coverage: every reachable top-level route renders (not blank / not stuck on Loading / not the
  ErrorBoundary), guarded routes self-guard, all 9 ProjectDetail tabs, ContentDetail editor/lifecycle/
  versions/rewrite-modal, Library filters+sort+bulk, Story-Arc/Genre/Brainstorm/Research forms, Settings
  theme+danger-zone, Newsletter editions/generate/template/help + approvals/sends.
- **Bug fixed (surfaced by the suite):** `RewriteWithResearchModal` had no `role="dialog"`/`aria-modal`
  (unlike ConfirmDialog/ExportDialog). Added the dialog role + `aria-modal` + `aria-labelledby`; verified
  live on DEV. Commit on `develop`.
- **Test-robustness fixes:** Library/Research/Genre row assertions now wait for the async Supabase fetch
  to settle (first row OR empty state) before counting — removed 3 false skips. Editor-toolbar selectors
  corrected to the real accessible names (glyph for B/I/H*, title for icon buttons, "Save").
- **Findings recorded** (not yet fixed — tracked per area page): newsletter dead controls (template
  override not sent; setup→generate `?edition=` ignored; help doc link 404; approval `resumed` flag
  dropped; hardcoded edition badge); unlabeled inputs across forms; icon-only buttons without accessible
  names (image-picker X, remove-reference, gallery cards); `/sources` dead `'other'` filter + not
  user-scoped; credits purchase is a Stripe-deferred stub; hidden pager at ≤10 items; hard vs soft deletes.
- One documented data-gated skip: story-arc delete-confirm (requires a user-owned custom arc; DEV user
  owns 0). Correct behavior — Delete is custom-only.

### Engine E2E harness (Goal 1, same session)

- `scripts/e2e_full_verify.py` + engine router: threaded voice/chat conversation context + demonstrative
  pronoun resolution ("blog about that", "email me that research"), isolated lifecycle-test data with
  seeded disposable known-state rows, R79 verify-by-DB-row, R89 last-step route grading.
- **Real engine bug fixed (surfaced by V22):** Gemini nondeterministically classified an explicit
  "write a blog post about that …" as *conversation* (~half of calls, temperature-driven), so the 2nd
  turn of the research→blog voice flow produced no blog. Added deterministic pre-Gemini overrides for
  one-shot writes (blog / newsletter / short story). Verified live: routing went 6/6 `chapter.blog`
  after deploy and V22 re-ran green (blog persisted, 1292 words).
- **Result: all 6 previously non-passing suite tests now PASS live on DEV** — R79, R89, R98, V03, V22,
  V36 → 6/6. See [[engine-e2e-full-rerun-report]].

## [2026-07-02] build | Full UI regression GREEN — 173 tests, 0 failures (develop @ c9d7d99)
Two-pass runner (light@3 / heavy@1 / signout, retries=2). Fixed this pass: chapter cover picker had no
projectId (listed every user image → picked another project's cover); reference-render Outlines locator
ambiguous with the sidebar; newsletter-templates Default+Active hydration race; TS2322 build break
(project_id null coalesce). Confirmed all remaining failures were concurrency-timing / external engine
flakiness (each passes in isolation) — absorbed by assertion-preserving retries. Remaining gaps: admin/
superuser (role-gated, needs elevated account) + a few no-DB-effect items (LogoUploader, Apply Fix,
ingestion drawer, onboarding/password). Runner: e2e/run-regression.sh; env: e2e/.env.e2e.example.
