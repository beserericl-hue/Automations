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
  seeded disposable known-state rows, R79 verify-by-DB-row, R89 last-step route grading. The 6 previously
  non-passing suite tests (R79, R89, R98, V36, V03, V22) now pass live on DEV. See [[engine-e2e-full-rerun-report]].
