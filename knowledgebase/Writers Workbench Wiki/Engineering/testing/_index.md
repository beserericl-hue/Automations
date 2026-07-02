---
name: Testing index
description: Catalog of testing pages — unit, E2E, regression, CI, newsletter test plan, conventions.
type: index
last_reviewed: 2026-06-10
---

# Testing

- [[unit-tests]] — Vitest + RTL. Per-sprint test files.
- [[e2e-tests]] — Playwright projects (chromium-noauth, chromium-authenticated). Spec files per sprint.
- [[newsletter-test-plan]] — 114-test **manual** QA plan (PR #69-#75). Manual/UI; n8n era.
- [[engine-api-system-tests]] — automated **system tests against the Python engine API** (contract, orchestrated E2E, HITL, SSE, parity, **scalability/load**, failure-injection, tenancy). Rewrites the newsletter plan for the API era + extends to the write-workshop services.
- [[engine-chat-e2e-suite]] — **functional E2E through the engine CHAT interface** (`/api/chat/proxy` → hub). One test per catalog op + lifecycle sub-ops + genre/arc matrix + prologue/epilogue + Workbench buttons, with pass/fail criteria. Engine-era rewrite of the repo `regressiontest_prompts.md`; Section 9 pins the CR-010 known-gap behaviors.
- [[engine-e2e-full-rerun-report]] — **results** of re-running all 157 suite tests live (chat + voice) after repairing the 20 gaps (G1-G20): 151/157 pass; the 6 non-passing are all non-engine-bugs. DEV, 2026-07-01/02.
- [[video-prep-e2e]] — E2E that seed the marketing-video demo ("The Last Signal") through the chat interface (`scripts/e2e_video_prep.py`).
- [[ci-pipeline]] — `.github/workflows/ci.yml` jobs + required status checks.
- [[regression-tests]] — R-tests that must pass per release. The sticky bugs that recur.
- [[test-conventions]] — testing rules: real-data sample, scope coverage, every-element-tested.
