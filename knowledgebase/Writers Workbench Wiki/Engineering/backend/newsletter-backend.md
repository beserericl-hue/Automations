---
name: Newsletter backend
description: Newsletter routes, render-html, approvals, generate, cadence cron callback.
type: concept
tags: [backend, newsletter, sprint-newsletter]
last_reviewed: 2026-05-09
---

# Newsletter backend

Six route files cover the newsletter feature surface. All are DEV-only as of 2026-05-09 (PROD migrations 013/014/016/017 not yet applied).

## Files

- [`server/src/routes/newsletter.ts`](../../../../writers-workbench/server/src/routes/newsletter.ts) — editions CRUD + generate.
- [`server/src/routes/newsletter-edition-extras.ts`](../../../../writers-workbench/server/src/routes/newsletter-edition-extras.ts) — logo upload, signoff, subscribers CSV import, feeds-from-genre.
- [`server/src/routes/newsletter-feeds.ts`](../../../../writers-workbench/server/src/routes/newsletter-feeds.ts) — feed sources CRUD.
- [`server/src/routes/newsletter-sends.ts`](../../../../writers-workbench/server/src/routes/newsletter-sends.ts) — sends list + detail + delete.
- [`server/src/routes/approvals.ts`](../../../../writers-workbench/server/src/routes/approvals.ts) — token-based approval flow.
- [`server/src/lib/newsletter-render.ts`](../../../../writers-workbench/server/src/lib/newsletter-render.ts) — Handlebars merge.
- [`server/src/lib/approvals.ts`](../../../../writers-workbench/server/src/lib/approvals.ts) — token gen + expiry.

## Editions CRUD

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/newsletter/editions` | GET / POST | List + create |
| `/api/newsletter/editions/:id` | GET / PUT / DELETE | CRUD |
| `/api/newsletter/editions/:id/feeds` | GET / POST | List + add feed |
| `/api/newsletter/editions/:id/feeds/:feedId` | DELETE | Remove |
| `/api/newsletter/editions/:id/feeds/import-from-genre` | POST | PR #75 — copy feeds from a genre (idempotent — skips duplicates) |
| `/api/newsletter/editions/:id/subscribers` | GET / POST | List + import (CSV) |
| `/api/newsletter/editions/:id/subscribers/:id` | DELETE | Remove |

## CSV subscriber import

`POST /editions/:id/subscribers` with `multipart/form-data`:

```ts
const csv = await req.file('subscribers');
const parsed = parseCSV(csv);  // expects email,name columns
const result = await supabaseAdmin.from('newsletter_subscribers_v2').upsert(
  parsed.map(r => ({edition_id, email: r.email, name: r.name, status:'active'})),
  {onConflict: 'edition_id,email'}
);
return {created: ..., updated: ..., skipped: ...};
```

Idempotent on `(edition_id, email)`.

## Generate

`POST /api/newsletter/generate`:

```ts
const {edition_id, custom_subject?} = req.body;
const job = await addTrackedJob('medium-ops', 'generate_newsletter', {
  url: `${N8N_BASE}/webhook/compose-newsletter-${tier}`,
  body: {edition_id, user_id: req.userId, custom_subject},
  user_id: req.userId,
  trackerRowId: '...',
  isHeavy: false,
}, req.userId);
return {jobId: job.jobId, executionId: edition_id};  // for /newsletter/execution/:id deep link
```

## Templates

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/newsletter/templates` | GET / POST | List + create |
| `/api/newsletter/templates/:id` | GET / PUT / DELETE | CRUD |
| `/api/newsletter/templates/:id/preview` | GET | Handlebars preview merging edition data (PR #73) |

`/preview` reads the edition row + merges `stamp_url` (logo) + signoff fields into the Handlebars data so the editor preview shows the uploaded logo. PR #73 specifically: edition overrides the template's defaults for logo + signature.

## Render HTML

`POST /api/newsletter/render-html` — internal endpoint called by the n8n compose agent.

```ts
async function renderNewsletter(template, edition, articles): Promise<string> {
  const data = {
    edition: {
      name: edition.name,
      sender_name: edition.sender_name,
      stamp_url: edition.stamp_url,            // logo URL
      signature_name: edition.signature_name,
      signature_role: edition.signature_role,
      intro: edition.intro_text,
    },
    articles: articles.map(a => ({
      title: a.title, url: a.url, summary: a.summary,
      ingestion_date: a.ingested_at,
    })),
    generated_at: new Date().toISOString(),
  };
  return Handlebars.compile(template.body)(data);
}
```

Template body is Handlebars syntax with `{{edition.name}}`, `{{#each articles}}...{{/each}}`, etc.

## Approvals

`POST /api/approvals/:token` (gated by `X-Approval-Secret`):

```ts
const {action} = req.body;  // 'approve' | 'reject' | 'extend'
const approval = await supabaseAdmin.from('newsletter_approvals_v2').select('*').eq('token', token).single();
if (!approval || approval.expires_at < new Date()) return res.status(404);

if (action === 'approve') {
  await supabaseAdmin.from('newsletter_sends_v2').update({status:'approved'}).eq('id', approval.send_id);
  await publishSseEvent(approval.user_id, {type:'newsletter:approval-changed', token, status:'approved'});
}
// ...
```

Public token-flow (no auth) but URL is unguessable + expiry-bound.

## Cadence cron callbacks

`GET /api/newsletter/cron/editions/due` — n8n cadence cron probes here:

```ts
SELECT * FROM newsletter_editions_v2
WHERE next_send_at <= now()
  AND is_disabled = false
  AND deleted_at IS NULL
```

`POST /api/newsletter/cron-callback` (gated by `X-Newsletter-Callback-Secret`) — n8n compose-agent stages emit here:

```ts
{stage: 'gathering' | 'drafting' | 'rendering' | 'saving' | 'sending', execution_id, progress?}
→ publishSseEvent(user_id, {type:'newsletter:execution-status', execution_id, stage, progress})
→ ExecutionStatus UI updates live
```

## Sends list

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/newsletter/sends` | GET | List newsletter_sends_v2 (filter by status) |
| `/api/newsletter/sends/:id` | GET / DELETE | Detail + delete |
| `/api/newsletter/approvals/open` | GET | List open approvals (for sidebar badge counter; UI not wired yet) |

## Bounce-driven subscriber flip

Sprint 11 + PR #74. Postal webhook → bounce inserted into `email_bounces_v2`. If hard bounce + email matches a subscriber:

```ts
UPDATE newsletter_subscribers_v2 SET status = 'bounced'
WHERE email = ? AND edition_id IN (SELECT id FROM newsletter_editions_v2 WHERE user_id = ?)
```

Reactive only — does not retroactively sweep historical bounces. Open audit item.

## Database tables

See [[database/migrations]]. Key newsletter tables:

| Table | Migration | DEV | PROD |
|-------|-----------|-----|------|
| `content_ingestion_v2` | 009 | yes | yes |
| `newsletter_approvals_v2` | 009 | yes | yes |
| `newsletter_sends_v2` | 009 | yes | yes |
| `newsletter_editions_v2` | 012, expanded 017 | yes | NO |
| `newsletter_templates_v2` | 014 | yes | NO |
| `newsletter_feed_sources_v2` | 016 | yes | NO |
| `newsletter_ingestion_runs_v2` | 016 | yes | NO |
| `newsletter_subscribers_v2` | 017 | yes | NO |

## Common gotchas

- **`+` in user_id needs URL encoding** in query params. PostgREST treats `+` as space.
- **`stamp_url` vs `logo_url`** — schema uses `stamp_url`. Renderer maps it to a `<img>` in templates.
- **Cadence cron checks day-interval only** — not time-of-day or day-of-week. Phase 2 fix.
- **CSV upsert on `(edition_id, email)`** is idempotent. Re-uploading the same CSV doesn't duplicate.
- **Expired approval tokens** return 404, not 401. Caller can distinguish "wrong token" (would be 404 too unfortunately) — no security cost.
- **Operator must Publish in n8n UI** after PR #74's REST PUT change to `Content - Newsletter Agent V2`. Until then, fan-out doesn't fire.
- **`/preview` endpoint requires the edition to exist** — won't render orphan templates. Use a sample edition id when building a new template.
- **DEV-only state means PROD shows 404 on these routes.** Catch in components with try/catch + null-render.
