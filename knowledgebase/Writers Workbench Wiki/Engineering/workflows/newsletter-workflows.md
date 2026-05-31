---
name: Newsletter workflows
description: The DEV-only newsletter cluster — multi-user ingestion cron, compose agent, cadence cron, plus the Workbench-side endpoints they call.
type: concept
tags: [workflows, newsletter, n8n]
last_reviewed: 2026-05-09
---

# Newsletter workflows

Status: **DEV-only as of 2026-05-09.** PROD promotion pending. Migrations 013/014/016/017 must apply to PROD Supabase first; then `scripts/promote-dev-to-prod.py` syncs the workflow set.

Background: V1 had a single-user newsletter pipeline (`AI News Data Ingestion Orig` + 17 hardcoded RSS triggers). The Multi-User Newsletter sprint cluster (PRs #69, #70, #72-75) replaces it with a fully DB-driven, multi-tenant pipeline.

## Workflows

### `Node - Scrape Url V2`

- **DEV ID:** `BJaUNEt6PPIqbWLa`
- **Purpose:** Wraps Firecrawl with metadata extraction. Replaces the broken `glJfsY6KaO0aoX0A`.
- **Credential:** Firecrawl `oWli4irymtVqSDyC` (shared).
- **Input:** `{url, user_id, source_id?}` via webhook trigger.
- **Output:** `{markdown, html, metadata: {title, author, published_at, ...}}`.

### `DEV - Newsletter Ingestion (Multi-User Cron)`

- **DEV ID:** `JAQ8rmCaDoddqt2k`
- **Created:** PR #69 (Multi-User Newsletters Sprint).
- **Schedule:** Hourly (every 30 min).
- **Nodes (13):**
  1. Schedule trigger.
  2. Read `newsletter_feed_sources_v2` grouped by `user_id`.
  3. SplitInBatches by user.
  4. For each user → for each feed:
     - Search existing ingestion via `GET /api/ingestion/search?prefix=YYYY-MM-DD/&user_id=...&type_not=approval` (dedupe).
     - If not present: `executeWorkflow Node - Scrape Url V2`.
     - `POST /api/ingestion/upload` — uploads `{markdown, html, metadata}` to `newsletter-ingestion` bucket + INSERT `content_ingestion_v2`.
     - INSERT `newsletter_ingestion_runs_v2` row (audit).
- **Workbench credentials:** `jQBRJbmiUeTk8c11` (DEV Workbench Ingestion Secret).
- **Replaces:** `AI News Data Ingestion V2` (`2T3TwGHhdGQlTpQ5`) which had 17 hardcoded triggers.

### `Content - Newsletter Agent V2`

- **DEV ID:** `bMvMKyK8obwYZmNb`
- **Modified:** PR #74 to add `fetch_subscribers` + `send_to_subscribers` nodes after `save_scheduled_newsletter`. Total 100 → 102 nodes.
- **Operator step pending:** the PUT changed the JSON, but n8n 2.x runtime needs a UI Publish click to pick up. Until that, generation still hits the OLD path (writes to `newsletter_sends_v2` but doesn't fan out to subscribers).
- **Trigger:** Webhook `/webhook/compose-newsletter-dev`.
- **Flow:**
  1. Read edition by id.
  2. Gather ingestion items via `/api/ingestion/search` (last N hours per edition's frequency).
  3. Claude Sonnet drafts content.
  4. `/api/newsletter/render-html` — Handlebars merge with template + edition (logo, signoff, etc.).
  5. INSERT `newsletter_sends_v2` `status='scheduled'`, `scheduled_send_at = now() + 24h`.
  6. INSERT `newsletter_approvals_v2` `{token, expires_at: now()+48h}`.
  7. POST email to user with approval link (`/newsletter/approvals/:token`).
  8. **(After Publish in n8n UI)** `fetch_subscribers` — SELECT `newsletter_subscribers_v2 WHERE edition_id=X AND status='active'`.
  9. `send_to_subscribers` — for each, POST `/api/email/send` (Postal).

### `DEV - Newsletter Cadence Cron`

- **DEV ID:** `7l1z4uMS9kdkYIT4`
- **Schedule:** Hourly.
- **Nodes (5):**
  1. Schedule trigger.
  2. `GET /api/newsletter/cron/editions/due` — server endpoint that queries `newsletter_editions_v2` for editions whose `next_send_at <= now()`.
  3. SplitInBatches.
  4. `POST /webhook/compose-newsletter-dev` for each edition.
  5. Update `newsletter_editions_v2.next_send_at` based on `cadence` + `cadence_send_time`.
- **Note:** The cadence cron currently only checks day-interval expiration, not time-of-day or day-of-week. Phase 2 of the cron should parse `cadence_send_time` (e.g. "09:00 fri") for proper scheduling. Outstanding from PR #74 audit.

## Workbench-side endpoints called by these workflows

| Endpoint | Method | Auth | Caller |
|----------|--------|------|--------|
| `/api/ingestion/search` | GET | `X-Ingestion-Secret` | Multi-User Cron |
| `/api/ingestion/upload` | POST | `X-Ingestion-Secret` | Multi-User Cron |
| `/api/ingestion/get/:key` | GET | `X-Ingestion-Secret` | (admin lookup) |
| `/api/ingestion/mine/days` | GET | user JWT | IngestionBrowser UI |
| `/api/newsletter/templates/:id/preview` | GET | user JWT | TemplateEditor UI |
| `/api/newsletter/render-html` | POST | `X-Ingestion-Secret` (or internal) | Newsletter Agent V2 |
| `/api/newsletter/cron/editions/due` | GET | `X-Cron-Secret` (planned — currently bypass) | Cadence Cron |
| `/api/newsletter/cron-callback` | POST | `X-Newsletter-Callback-Secret` | Newsletter Agent V2 stage callbacks |
| `/api/email/send` | POST | `X-Email-Secret` | Newsletter Agent V2 |
| `/api/approvals/:token` | GET / POST | `X-Approval-Secret` | (server-internal) |

## Database tables

DEV-only as of now:

| Table | Migration | Purpose |
|-------|-----------|---------|
| `newsletter_editions_v2` | 012, expanded 017 | Per-user newsletter identity (name, sender_name, schedule, intro, stamp_url, signature_name, signature_role, cadence, cadence_send_time) |
| `newsletter_feed_sources_v2` | 016 | Per-user feed sources (URL, name, frequency, type) |
| `newsletter_ingestion_runs_v2` | 016 | Cron audit per (user_id, feed_id, started_at, finished_at, items_added) |
| `newsletter_subscribers_v2` | 017 | Per-edition subscriber list (email, name, status, source) |
| `newsletter_templates_v2` | 014 | Handlebars body + name + section_order. 5 default templates (PR #62, #73). |
| `content_ingestion_v2` | 009 | Ingested article metadata (body in storage). Already on PROD. |
| `newsletter_approvals_v2` | 009 | Open approval gates. Already on PROD. |
| `newsletter_sends_v2` | 009 | Finished newsletters parked status='scheduled'. Already on PROD. |

See [[migrations]].

## Storage buckets

- `newsletter-ingestion` (private, service-role only) — exists on PROD via migration 009 but DEV-only ingestion endpoints currently write to it. Phase 2 opens to authenticated read for IngestionBrowser.
- `newsletter-logos` (public-read, owner-write) — DEV-only as of migration 017.

## Frontend routes (already shipped to DEV; PROD will get them at next release)

```
/newsletter                       → NewsletterHome
/newsletter/generate              → NewsletterGenerate
/newsletter/execution/:id         → ExecutionStatus (live progress via SSE)
/newsletter/approvals             → PendingApprovals
/newsletter/approvals/:token      → ApprovalDetail (approve/reject/edit)
/newsletter/sends                 → ScheduledSends
/newsletter/sends/:id             → NewsletterDetail
/newsletter/ingestion             → IngestionBrowser (article scan results)
/newsletter/templates             → TemplatesList
/newsletter/templates/:id (or new) → TemplateEditor
/newsletter/editions              → EditionsList (with show-disabled toggle)
/newsletter/editions/:id (or new) → EditionEditor (genre dropdown PR #75; logo + signoff PR #70)
/newsletter/editions/:id/feeds    → FeedsList
/newsletter/editions/:id/setup    → EditionSetupWizard (imports N feeds from chosen genre)
```

## Outstanding operator step

After PR #74 merge, the operator must:
1. Open `https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb`
2. Refresh tab (Cmd-R)
3. Click **Publish** (⌘P)
4. Trigger via `/newsletter/generate` UI; verify `eric@agileadtesting.com` receives the rendered email.

Until Publish is clicked, the DEV runtime keeps the OLD `activeVersion` of `Content - Newsletter Agent V2` and skips the subscriber fan-out.

## PROD promotion checklist

When releasing newsletter cluster:

1. Apply migrations 013, 014, 016, 017 to PROD Supabase (idempotent).
2. Create PROD-tier credentials in n8n:
   - PROD Workbench Email Secret (X-Email-Secret)
   - PROD Workbench Ingestion Secret (X-Ingestion-Secret)
   - PROD Workbench Approval Secret (X-Approval-Secret)
   - PROD Workbench Newsletter Callback Secret (X-Newsletter-Callback-Secret)
3. Set the corresponding env vars on PROD Workbench Railway service.
4. Promote the 4 newsletter workflows DEV→PROD via `scripts/promote-dev-to-prod.py` (will need entries in [[workflow-id-map]] for them).
5. Activate them on PROD.
6. Optionally: deactivate `AI News Data Ingestion Orig` (`53SlwZMS21gpvz3H`) once new pipeline is verified.
7. Seed `newsletter_feed_sources_v2` for any PROD users who want it.
8. Verify a real generation end-to-end with a single subscriber.

## Open audit items (from PR #74 review)

1. **Recurring schedule UI is decorative** — `cadence` + `cadence_send_time` exist on editions but cadence cron only checks day-interval. Needs day-of-week + time-of-day parsing.
2. **Subscribers count not enforced anywhere** — no UI shows total subscribers per edition on EditionsList.
3. **Bounce → subscriber flip is reactive only.** No retroactive sweep over historical `email_bounces_v2` rows.
4. **Approvals UX gaps** — in-place story editing, A/B subject picker, expiry banner. Multi-day, lowest urgency.
5. **Pending-approvals badge in sidebar** is wired-but-empty — populate from `/api/newsletter/approvals/open?count_only=1`.
6. **Cron health dashboard** missing — no UI on `newsletter_ingestion_runs_v2`.
7. **Story-source chips on Approval payload** deep-link into IngestionBrowser via `?date=YYYY-MM-DD` (PR #74). Smoke once a real run completes.
