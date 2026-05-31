---
name: Newsletter cluster
description: Newsletter sprint chronology — Migration v1.1, Compose Newsletter (S1-S10), Templates, Multi-User, Flow Fixes, Fan-out + Cadence + Bounces + CSV.
type: concept
tags: [sprints, newsletter, sprint-newsletter]
last_reviewed: 2026-05-09
---

# Newsletter cluster

A series of related sprints across 2026-04-22 to 2026-05-01 that rebuilt the newsletter feature from a single-user V1 hardcoded-feeds pipeline into a multi-tenant, DB-driven, fully UI-managed system.

**Status:** **DEV-only** as of 2026-05-09. PROD migrations 013/014/016/017 + n8n workflow promotion pending. See [[newsletter-workflows]] and [[newsletter-ui]].

## Sub-sprints

### Newsletter Migration sprint (v1.1)

Spec: `writers-workbench/sprint-newsletter-migration.md` (v1.1, 11 stories / 39 pts).

Branched off `develop` in a sibling worktree (`Automations-newsletter-s1`) so in-flight Sprint 10b-3 work in main worktree wasn't disturbed.

**S1** — Scrape URL wire-up. Cloned `Node - Scrape Url` (`bXBsnU4d6OseXWho`) → **`Node - Scrape Url V2` (`BJaUNEt6PPIqbWLa`)**, active. Firecrawl credential preserved. Legacy `glJfsY6KaO0aoX0A` renamed to `[OLD]` and disabled (was wired to broken `BZku8v1a2K12iFGQ` httpHeaderAuth cred).

**S2** — Supabase schema + storage bucket. Migration `009_newsletter_ingestion.sql`. Three new tables (`content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2`). Private storage bucket `newsletter-ingestion` (10 MB, md/html/plain MIME). Applied to DEV; PROD got it at v1.1.0 release.

**S3** — Supabase-backed ingestion endpoints. `POST /api/ingestion/upload`, `GET /api/ingestion/search`, `GET /api/ingestion/get/:key`. Shared-secret middleware factory `requireSecret('X-Ingestion-Secret', 'INGESTION_SECRET')`. 17 new server tests, all passing. See [[ingestion-routes]].

**S4** — n8n compose-agent rewrite (`Content - Newsletter Agent V2`, `bMvMKyK8obwYZmNb`). Stage-emit callback to `/api/newsletter/cron-callback`. Approvals SSE.

**S5** — Client sidebar + 8 route stubs + `useNewsletterEvents` hook.

PR #19 (draft against develop). Operational decision captured: **n8n Community edition does not allow `$env.*` references in expressions**, so shared secrets live in `httpHeaderAuth` credentials and URLs/identity values are hardcoded in workflow JSON + substituted at promotion.

### Compose Newsletter sprint (S1–S10)

PRs #41–#67. Earlier portion of newsletter rewrite.

Major deliverables:
- Composer chain: gather → draft → render → save.
- Approval token flow.
- 5 default templates with Handlebars body.
- Live execution status via SSE.

### Newsletter Templates sprint (T1-T4)

PRs #60, #61, #62, #73.

`newsletter_templates_v2` table (migration 014). Default templates seeded. `TemplateEditor` UI with live preview.

PR #73 specifically: `/api/newsletter/templates/:id/preview` reads the edition + merges `stamp_url` (logo) + signoff fields into Handlebars data so editor preview shows the uploaded logo.

### Multi-User Newsletters sprint (PR #69)

The big one. Replaces V1's single-user 17-trigger ingestion model with a per-user DB-driven system.

- Migration 016 — `newsletter_feed_sources_v2` (per-user feed URLs) + `newsletter_ingestion_runs_v2` (cron audit).
- Editions CRUD routes (server).
- n8n cron: `DEV - Newsletter Ingestion (Multi-User Cron)` `JAQ8rmCaDoddqt2k` — every 30 min, reads feed sources grouped by user, scrapes, dedupes, uploads.
- Seed of 17 baseline feeds.
- UI: EditionsList, EditionEditor, FeedsList, NewsletterDetail.
- User guide: `writers-workbench/docs/newsletter-user-guide.md`.

### Newsletter Flow Fixes sprint (PR #70)

Migration 017 — adds `stamp_url`, `signature_name`, `signature_role`, `cadence`, `cadence_send_time` columns to `newsletter_editions_v2`. New `newsletter_subscribers_v2` table. New `newsletter-logos` storage bucket.

UI: Logo upload component. Real `IngestionBrowser` (replacing placeholder). Real `ScheduledSends` (replacing placeholder). `EditionSetupWizard` onboarding. `HelpButton` on every newsletter screen.

### IngestionBrowser improvements (PR #72)

- Default to most-recent-with-data day.
- New `GET /api/ingestion/mine/days` endpoint.
- Scanned column showing count of feeds run per day.
- Manage feeds shortcut.

### Template preview merges edition overrides (PR #73)

`/api/newsletter/templates/:id/preview` merges edition's stamp_url + signoff into Handlebars data. The editor preview now shows the uploaded logo.

### Newsletter fan-out + cadence + bounces + CSV (PR #74)

The biggest single PR in the cluster. Adds:

1. **Subscriber fan-out** — replaced hardcoded `eric@agileadtesting.com` recipient. `Content - Newsletter Agent V2` modified (PUT) to add `fetch_subscribers` + `send_to_subscribers` nodes after `save_scheduled_newsletter`. Total 100 → 102 nodes.

2. **Cadence cron** — `DEV - Newsletter Cadence Cron` `7l1z4uMS9kdkYIT4`. Hourly. Polls `/api/newsletter/cron/editions/due`, splits in batches, posts to `compose-newsletter-dev` for each.

3. **Re-enable disabled newsletters** — UI toggle.

4. **Postal bounce auto-flips** subscriber.status='bounced'. (Reactive; no historical sweep.)

5. **CSV import** — idempotent upsert into `newsletter_subscribers_v2` with create/update/skip counts.

6. **Cleaned all "Phase 2b" stale strings.**

**Outstanding operator step** (still pending as of 2026-05-09): operator must open n8n UI, refresh `Content - Newsletter Agent V2` workflow tab, click Publish (⌘P) so runtime activeVersion picks up the new fan-out nodes. Until then, generation writes to `newsletter_sends_v2` but doesn't actually fan out.

### EditionEditor genre dropdown + setup wizard (PR #75)

- `GET /api/genres` returns active genres with feed counts.
- EditionEditor "Genre" `<input>` → `<select>`.
- `POST /editions/:id/feeds/import-from-genre` (idempotent — skips duplicates).
- SetupWizard step 1: "Copy N feeds from <genre>" instead of hardcoded 6.

## Workflow IDs (DEV-only)

| Workflow | ID | State |
|----------|----|----|
| Node - Scrape Url V2 | `BJaUNEt6PPIqbWLa` | Active |
| Content - Newsletter Agent V2 | `bMvMKyK8obwYZmNb` | Active (modified PR #74; pending UI Publish) |
| DEV - Newsletter Ingestion (Multi-User Cron) | `JAQ8rmCaDoddqt2k` | Active hourly |
| DEV - Newsletter Cadence Cron | `7l1z4uMS9kdkYIT4` | Active hourly |
| AI News Data Ingestion V2 (legacy) | `2T3TwGHhdGQlTpQ5` | Active (will deactivate once new cron verified) |
| AI News Data Ingestion Orig (V1) | `53SlwZMS21gpvz3H` | Still active (frozen) |

## Migrations applied

| # | DEV | PROD |
|---|-----|------|
| 009 (newsletter ingestion) | yes | yes (released v1.1.0) |
| 010 (email bounces) | yes | yes |
| 012 (editions) | yes | NO |
| 013 (user-specific ingestion + genre URLs) | yes | NO |
| 014 (templates) | yes | NO |
| 016 (feed sources + ingestion runs) | yes | NO |
| 017 (logos + subscribers + signoff) | yes | NO |

## What still needs to happen for PROD

1. Apply migrations 013, 014, 016, 017 to PROD Supabase.
2. Create PROD-tier credentials in n8n (Workbench Email/Ingestion/Approval/Newsletter-Callback Secrets).
3. Set corresponding env vars on PROD Workbench Railway service.
4. Promote 4 newsletter workflows DEV→PROD via `scripts/promote-dev-to-prod.py` (with new entries in [[workflow-id-map]]).
5. Activate them on PROD.
6. Optionally: deactivate `AI News Data Ingestion Orig`.
7. Seed `newsletter_feed_sources_v2` for any PROD users who want it.
8. Verify a real generation end-to-end with a single subscriber.

## Test plan

`writers-workbench/docs/newsletter-test.md` — 114-test end-to-end manual QA plan covering everything the cluster shipped. PDF version at `newsletter-test.pdf` (32 pages). User has run through; T-01.4 was reported failing but identified as browser cache issue (hard refresh fixed).

See [[testing/newsletter-test-plan]].

## Open audit items

1. Cadence cron checks day-interval only — not time-of-day or day-of-week. Phase 2 fix.
2. Subscriber count not displayed on EditionsList.
3. Bounce → subscriber flip is reactive only; no historical sweep.
4. Pending-approvals badge in sidebar wired-but-empty.
5. Cron health dashboard for `newsletter_ingestion_runs_v2` missing.
6. Inline approval editing not built.
7. A/B subject picker not built.

## PROD story-bible backfill (one-off, not a sprint)

`scripts/hotfix-backfill-story-bible-prod.py` (untracked as of 2026-05-09 — should be committed). Self-contained per-chapter re-extract for PROD projects. Used to backfill *The Invisible Wall* (43 entries inserted). See [[hotfixes]].

## Lessons captured

1. **n8n Community edition disallows `$env.*`** — credentials + hardcoded JSON only.
2. **`POST /workflows/{id}/deactivate`** returns 403 on already-active workflows in n8n 2.x. UI toggle or PUT-in-place.
3. **n8n PUT only accepts** `executionOrder` in settings (everything else 400s).
4. **`webhookId` is globally unique per instance** — clones must regenerate.
5. **n8n 2.x runtime activeVersion** needs UI refresh + Publish (⌘P) to pick up REST PUT changes.
6. **PostgREST `+` in user_id query params** treated as space — URL-encode.
7. **Cloudflare** Return Path CNAME must be DNS-only (grey cloud).
