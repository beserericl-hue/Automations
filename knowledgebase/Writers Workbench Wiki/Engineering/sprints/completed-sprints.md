---
name: Completed sprints
description: Quick-reference table of every shipped sprint with PR numbers, story counts, and key deliverables.
type: concept
tags: [sprints, completed, history]
last_reviewed: 2026-05-09
---

# Completed sprints

Source of truth: `gh pr list --state all` + `git log --all --oneline | grep <sprint id>`. Anything in this page that disagrees with those is wrong; open a PR to fix it.

## Sprint 0 — Testing infrastructure + security foundation

**Status:** SHIPPED v1.0. Date: 2026-04-11. Commit `9cbe005`.

**9 stories / 34 pts:**
- S0-1 Playwright installed + e2e folder scaffolded
- S0-2 DOMPurify added to client (XSS hardening on TipTap content)
- S0-3 Server JWT auth middleware (`requireAuth`)
- S0-4 Admin role column + `is_admin()` function (later replaced by Sprint 8 meta tables)
- S0-5 CORS / helmet / rate-limiting on Express
- S0-6 Zod validation everywhere
- S0-7 Test infrastructure (Vitest + RTL + jsdom)
- S0-8 + S0-9 misc security tightening

## Sprint 1 — Data integrity + delete operations

**Status:** SHIPPED v1.0. Date: 2026-04-11.

**7 stories / 34 pts:**
- S1-1 FK cascades fixed (`SET NULL` on `published_content_v2.project_id`); soft-delete columns added everywhere; `discovery_question` added to `story_arcs_v2`. Migration `002_sprint1_data_integrity.sql`.
- S1-2 Content delete with cascade-info dialog
- S1-3 Project delete + TrashView + Restore
- S1-4 Research report and story bible delete
- S1-5 `VersionHistory.tsx` — list/view/compare/restore modes
- S1-6 Reusable `ConfirmDialog` (danger/warning/default)
- S1-7 Unsaved changes warning (useBlocker)

## Sprint 2 — UI restructure + navigation

**Status:** SHIPPED v1.0. Date: 2026-04-11.

**5 stories / 34 pts:**
- S2-1 Sidebar restructured — project-centric. Removed 8 flat nav items; added "My Projects" expandable + "Reference" collapsible.
- S2-2 `ContentLibrary.tsx` — filter bar + sortable + bulk actions. Replaces 4 type-specific pages. Legacy redirects.
- S2-3 ProjectWorkspace 8-tab layout
- S2-4 Breadcrumb entity-title resolution + global search (Cmd+K) + mobile-responsive sidebar
- S2-5 Reusable `Pagination.tsx` applied across all list pages

## Sprint 3 — CRUD completeness

**Status:** SHIPPED v1.0. Date: 2026-04-12.

**7 stories / 34 pts:**
- S3-1 ProjectEditForm + Postgres trigger `trg_snapshot_outline` (auto outline_versions). Migration `003`.
- S3-2 Story bible CRUD (add/edit + key-value metadata)
- S3-3 Custom story arc CRUD
- S3-4 ResearchDetail page (was list-only)
- S3-5 Genre ArrayField UX (numbered + reorder + URL validation); deletion protection
- S3-6 Schedule button on ContentDetail (datetime-local picker)
- S3-7 Account deletion endpoint (cascades + auth user delete)

## Sprint 4 — Image + social media management

**Status:** SHIPPED v1.0. Date: 2026-04-12.

**6 stories / 34 pts:**
- S4-1 `generated_images_v2` + `social_posts_v2` tables; Storage buckets `cover-images`, `social-images`, `writing-samples`. Migration `005`.
- S4-2 n8n workflows updated to save images to Storage + insert rows.
- S4-3 `ImageGallery.tsx` — grid + filters + Select callback (picker reuse).
- S4-4 `SocialMediaPanel.tsx` — platform tabs.
- S4-5 Cover image banner on ContentDetail.
- S4-6 ChatDrawer rewrite — resizable, persistent history, Quick Commands, async detection.

## Sprint 5 — Observability + advanced features

**Status:** SHIPPED v1.0. Date: 2026-04-12.

**6 stories / 34 pts:**
- S5-1 `CostDashboard.tsx` + `token_usage_v2` table + `token_usage_daily_v2` view. Migration `006`.
- S5-2 `ProvenancePanel.tsx` + `SourceBrowser.tsx` (content_index browsing).
- S5-3 `QAReportPanel.tsx` reading metadata.qa_report.
- S5-4 Web callback architecture (server `/api/session/*` + `/api/callback/*`).
- S5-5 n8n `Sub - Eve Knowledge Callback V2` updated to check session before web vs phone.
- S5-6 Dashboard auto-refresh every 30s + SSE-driven invalidation.

## Sprint 6 — Admin, settings, polish

**Status:** SHIPPED v1.0. Date: 2026-04-12.

**7 stories / 34 pts:**
- S6-1 Admin server routes (users CRUD + metrics + workflows + storage)
- S6-2 AdminPanel rewrite — 7 tabs.
- S6-3 Dark mode (light/dark/system).
- S6-4 Toast notification system.
- S6-5 Loading skeletons + empty states.
- S6-6 Accessibility (keyboard nav, focus rings, status icons).
- S6-7 Polish (Ctrl+S, health-check Supabase probe, genre reference count).

## Sprint 7 — Testing, documentation, deployment

**Status:** SHIPPED v1.0. Date: 2026-04-15. Tag `v1.0.0`.

**5 stories / 28 pts:**
- S7-1 `e2e/sprint7-critical-paths.spec.ts` — 60+ E2E tests across 9 critical paths.
- S7-2 OpenAPI 3.0.3 docs at `/api/docs` (swagger-ui-express).
- S7-3 GitHub Actions CI pipeline at `.github/workflows/ci.yml`.
- S7-4 Production Dockerfile + railway.toml verified.
- S7-5 `OnboardingTutorial.tsx` (5-step modal — replaced by anchored tour in PR #51).

## Sprint 8 — RBAC + tiers + credits + impersonation

See [[sprint-8-rbac]] for the deep dive. Released v1.1.0. PRs #50, #51, #53, #54, #55, #57.

## Sprint 10.a — V1/DEV/PROD tier separation

See [[sprint-10a-tier-separation]]. Released v1.1.0. PRs #5, #6, #7, #8, #9.

## Sprint 10.b — Redis + BullMQ + concurrency + SSE pub/sub

See [[sprint-10b-bullmq]]. Released v1.1.0. PRs #10, #11, #13, #15, #20.

## Sprint 11 — Postal email migration

See [[sprint-11-postal]]. **DEV-complete** — all 14 DEV email workflows on Postal. PROD also migrated at v1.1.0 release. PRs #16, #17, #23, #24.

## Sprint 12 — Chapter tools (Tracks B + C)

See [[sprint-12-chapter-tools]]. Track A deferred to Sprints 16/17/18. Released DEV at PR #40; PROD via PR #71 hotfix. PRs #31, #32, #33, #38, #39, #40.

## Newsletter cluster

See [[newsletter-cluster]]. **DEV-only** as of 2026-05-09. PRs #19, #58-67 (Compose Newsletter sprints), #69 (Multi-User), #70 (Flow Fixes), #72 (Ingestion Browser), #73 (Template preview), #74 (Fan-out + Cadence + Bounce + CSV), #75 (Genre dropdown).

## Onboarding tour rebuild (PR #51)

Anchored, spotlight-cutout product tour. `data-tour` attributes on sidebar, EveOrb, credits pill, topbar chat button. Smart 4-way placement; ResizeObserver tracking. Released v1.1.0.

## Side sprints

- **Compose Newsletter Sprint** (PRs #41–#67) — earlier portion of newsletter rewrite.
- **Newsletter Templates Sprint** (T1–T4 via PRs #60, #61, #62, #73) — Handlebars body templates.
- **Per-user ingestion URLs + admin/superuser ingestion read** (PR #55) — newsletter side-sprint that landed during Sprint 8.
- **Hotfix story-bible extraction** (PR #71, 2026-04-29) — deterministic 4-node extraction stage in Worker - Write Chapter. PROD + DEV both updated.

## Aggregate state at v1.1.0 release

- **Sprints 0-8 + 10.a + 10.b + 11 + 12** all DEV-complete.
- **PROD** running v1.1.0 with all of the above except newsletter cluster + parts of newsletter Sprints 13-17.
- **Tests:** 508/508 passing at v1.1.0; ~580+ on develop (with newsletter cluster tests added).

## Aggregate state at 2026-05-09

`develop` HEAD: `3945761` (PR #75 merge — EditionEditor genre dropdown + setup wizard import-from-genre). `main` HEAD: `d55baaf` (last release was v1.1.1 hotfix).

## Where each sprint's planning doc lives

- `writers-workbench/sprint_document.md` — original Sprint 0-9 spec.
- `writers-workbench/sprint_document_v2.md` — Sprint 10+ spec including Sprints 14, 16, 17, 18 rearchitecture.
- `writers-workbench/sprint-newsletter-migration.md` — Newsletter Migration v1.1.
- `writers-workbench/docs/compose-newsletter-sprint.md` — Compose Newsletter sprint (S1-S10).
- `writers-workbench/docs/newsletter-templates-sprint.md` — Templates sprint.
