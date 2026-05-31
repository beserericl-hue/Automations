---
name: Newsletter UI
description: Frontend pages and components for the newsletter feature cluster.
type: concept
tags: [frontend, newsletter, sprint-newsletter]
last_reviewed: 2026-05-09
---

# Newsletter UI

Status: **DEV-only** as of 2026-05-09. Backend endpoints + DB schema not yet on PROD. PROD release blocked on migrations 013/014/016/017 + n8n workflow promotion.

## Sidebar entry

`Sidebar.tsx` has a `Newsletter` collapsible section under the user's projects:
- My newsletters → `/newsletter/editions`
- Generate → `/newsletter/generate`
- Pending approvals → `/newsletter/approvals` (badge planned but currently empty — open audit item)
- Scheduled sends → `/newsletter/sends`
- Article scan results → `/newsletter/ingestion`
- Templates → `/newsletter/templates`

## Pages

### `NewsletterHome` (`/newsletter`)

Hub view with shortcuts to all the sub-pages. Mostly a landing page.

### `EditionsList` (`/newsletter/editions`)

Lists `newsletter_editions_v2` rows for the user. Columns:
- Name
- Sender name
- Cadence (daily/weekly/monthly)
- Subscriber count (open audit item — not yet shown)
- Last send
- Disabled badge if `is_disabled = true`

Filters: Show disabled toggle (PR #74). Re-enable button on disabled rows.

Header: `?` HelpButton (PR #70) + "+ New newsletter".

### `EditionEditor` (`/newsletter/editions/new` or `:id`)

Edit a newsletter edition. Form:
- Name
- Sender name (visible in From)
- **Genre dropdown** (PR #75) — fetches `/api/genres` (active genres + feed counts)
- Logo upload — to `newsletter-logos` bucket
- Signoff: signature_name + signature_role
- Cadence (daily/weekly/monthly)
- Cadence send time (e.g. "09:00 fri") — currently decorative; cron only checks day-interval
- Intro text

PR #73: `/api/newsletter/templates/:id/preview` reads the edition + merges stamp_url + signoff so the editor preview shows the uploaded logo.

### `EditionSetupWizard` (`/newsletter/editions/:id/setup`)

Onboarding wizard for a new edition. Step 1 (PR #75): "Copy N feeds from <genre>" button uses `POST /editions/:id/feeds/import-from-genre` to seed feeds idempotently.

### `FeedsList` (`/newsletter/editions/:id/feeds`)

Per-edition feed sources. Rows: URL, name, frequency, type. Add / Remove. Drag-to-reorder.

Backed by `newsletter_feed_sources_v2` (migration 016).

### `IngestionBrowser` (`/newsletter/ingestion`)

Browses scanned articles from `content_ingestion_v2`.

PR #72 features:
- Default to most-recent-with-data day.
- Days sidebar (clickable list of dates with item counts).
- Scanned column showing how many feeds ran on each day.
- "Manage feeds" shortcut to `FeedsList`.

`?date=YYYY-MM-DD` URL param deep-links to a specific day (used by approval-payload story-source chips, PR #74).

### `TemplatesList` (`/newsletter/templates`) + `TemplateEditor`

Template CRUD. 5 default templates (PR #62, #73). Each template has a Handlebars body + name + section_order.

`TemplateEditor` shows live preview merging the user's edition data (logo, signoff, sample articles).

### `NewsletterGenerate` (`/newsletter/generate`)

Manual trigger:
- Pick edition.
- Optional: custom subject.
- Submit → `POST /api/newsletter/generate`.
- Redirects to `/newsletter/execution/:id` for live progress.

### `ExecutionStatus` (`/newsletter/execution/:id`)

Live SSE-driven progress page. Stages emit via `newsletter:execution-status`:
- Gathering ingestion items
- Drafting (Claude)
- Rendering HTML
- Saving
- Sending (after operator clicks Publish in n8n UI on PR #74)

### `PendingApprovals` (`/newsletter/approvals`)

Lists open `newsletter_approvals_v2` rows. Each row links to:

### `ApprovalDetail` (`/newsletter/approvals/:token`)

Token-loaded. Shows the rendered newsletter HTML preview. Actions:
- Approve → flips `newsletter_sends_v2.status = 'approved'`. Cadence cron picks up.
- Reject → status = 'rejected'.
- Edit (in-place editing) — open audit item; not yet built.

`X-Approval-Secret` header gates the token-flow on the server.

### `ScheduledSends` (`/newsletter/sends`)

Lists `newsletter_sends_v2 status='scheduled'`. Click row → `NewsletterDetail`.

### `NewsletterDetail` (`/newsletter/sends/:id`)

Full send view. HTML preview + metadata + subscriber count + actions.

## Subscriber CSV import (PR #74)

`/newsletter/editions/:id/subscribers` (page), or via FeedsList action:
- Upload CSV (email,name).
- Preview parsed rows.
- Idempotent upsert into `newsletter_subscribers_v2`.
- Shows counts: created, updated, skipped (duplicates).

## Help drawer pattern (PR #70)

Each major newsletter page has a `?` icon in the header (`HelpButton`). Click → right-side drawer with feature-specific help text. Footer link to `/docs/newsletter-user-guide.md`.

## Bounce handling UI

`AdminPanel` "Email Bounces" tab shows `email_bounces_v2` rows. Type filter (hard/soft). Severity. Subscriber email auto-flipped to `status='bounced'` on hard bounce (PR #74).

## SSE wiring

`useNewsletterEvents` hook (`hooks/useNewsletterEvents.ts`) subscribes via the AppShell-level CustomEvent to:
- `newsletter:approval-changed` — refresh PendingApprovals.
- `newsletter:execution-status` — push to ExecutionStatus.

## Known UI gaps (open audit items)

1. Pending-approvals badge in sidebar wired-but-empty.
2. Subscribers count not displayed on EditionsList.
3. In-place story editing on ApprovalDetail.
4. A/B subject picker on ApprovalDetail.
5. Expiry banner on stale approvals.
6. Cron health dashboard for `newsletter_ingestion_runs_v2`.

## Common gotchas

- **DEV-only state.** Querying `newsletter_editions_v2` etc. on PROD returns "table does not exist." Catch in components with try/catch + null-render.
- **Cache after PR #74 merge.** Browser cached `EditionsList-Bopw34eF.js` chunk without the new strings ("Show disabled", "Re-enable"). Hard refresh required after deploy.
- **Logo upload via `newsletter-logos` bucket** requires migration 017. Doesn't work on PROD until release.
- **Feed reorder** persists via `display_order` column. Bulk update on drag-end.
- **Genre dropdown in EditionEditor** (PR #75) — empty if no genres exist for the user. Shows "Create a genre" CTA.
