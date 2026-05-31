---
name: Email pipeline
description: lib/email.ts → Postal API + rate limit + bounce handling.
type: concept
tags: [backend, email, postal, sprint-11]
last_reviewed: 2026-05-09
---

# Email pipeline

`POST /api/email/send` is the universal email entrypoint. n8n calls it; cron calls it; trial-warning emails call it.

## Files

- [`server/src/routes/email.ts`](../../../../writers-workbench/server/src/routes/email.ts) — route handler with `X-Email-Secret` gate + rate limit.
- [`server/src/lib/email.ts`](../../../../writers-workbench/server/src/lib/email.ts) — Postal client wrapper.
- [`server/src/lib/rate-limit.ts`](../../../../writers-workbench/server/src/lib/rate-limit.ts) — Redis sliding-window 30/min/user_id.

## sendEmail signature

```ts
sendEmail({
  to: string | string[],
  subject: string,
  html: string,
  text?: string,
  from?: string,         // defaults to SENDER_EMAIL env
  reply_to?: string,     // defaults to REPLY_TO_EMAIL
  attachments?: Array<{filename: string, content: string|Buffer, content_type: string}>,
  user_id?: string,      // for rate-limit accounting
}) → Promise<{success: boolean, message_id: string, mode: 'sent'|'dry-run', error?: string}>
```

## DRY_RUN_EMAIL handling

```ts
if (process.env.DRY_RUN_EMAIL === 'true') {
  return {success:true, message_id:`dry-run-${Date.now()}`, mode:'dry-run'};
}
```

Set during local dev + Postal smoke tests. Production must be `false`.

## Postal API call

```ts
const response = await fetch(`${POSTAL_API_URL}/send/message`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Server-API-Key': POSTAL_API_KEY,
  },
  body: JSON.stringify({
    to: [...toArray],
    from: from ?? SENDER_EMAIL,
    sender: SENDER_NAME,
    subject,
    plain_body: text ?? htmlToPlain(html),
    html_body: html,
    reply_to: reply_to ?? REPLY_TO_EMAIL,
    attachments: attachments?.map(a => ({
      name: a.filename,
      content_type: a.content_type,
      data: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
    })),
  }),
});
```

Response: `{message_id: '<uuid>@rp.postal.courseworx.media'}`.

## Rate limit

```ts
async function emailRateLimit(userId: string): Promise<{allowed: boolean, remaining: number}> {
  const key = `email:${userId}:${Math.floor(Date.now() / 60_000)}`;
  const count = await redis.incr(key);
  await redis.expire(key, 70);
  return {
    allowed: count <= 30,
    remaining: Math.max(0, 30 - count),
  };
}
```

Sliding-window 30/min per user_id. Sprint 11 S11-4. Returns 429 if exceeded.

## Route handler

```ts
router.post('/send',
  requireSecret('X-Email-Secret', 'EMAIL_SECRET'),
  validate(EmailSendSchema),
  async (req, res) => {
    const {user_id, ...payload} = req.body;
    if (user_id) {
      const limit = await emailRateLimit(user_id);
      if (!limit.allowed) return res.status(429).json({error:'rate_limited', remaining:0});
    }
    const result = await sendEmail({...payload, user_id});
    res.json(result);
  }
);
```

## n8n side

Every n8n workflow that previously used Gmail OAuth now does HTTP Request:

```yaml
url: =https://writersworkbench-develop.up.railway.app/api/email/send
method: POST
authentication: httpHeaderAuth (DEV Workbench Email Secret = kxrSg24PIR2Npfvw)
contentType: application/json
body:
  to: ={{$json.recipient_email}}
  subject: ={{$json.email_subject}}
  html: ={{$json.email_body_html}}
  user_id: ={{$json.user_id}}
```

15 V2 workflows migrated in Sprint 11 sweep `scripts/s11-migrate-gmail-to-postal.py` (commit `b9303aa`).

## Bounce handling (Sprint 11 S11-5)

Postal sends bounce notifications back via webhook. Workbench endpoint accepts them and:
1. INSERT `email_bounces_v2` row.
2. If hard bounce AND email matches a `newsletter_subscribers_v2.email` → UPDATE that row `status='bounced'`.
3. AdminPanel "Email Bounces" tab shows the audit.

`email_bounces_v2` schema:
```
id              uuid PK
user_id         text FK   -- the original recipient (if known)
email           text NOT NULL
type            text NOT NULL CHECK ('hard_bounce','soft_bounce','complaint','unsubscribe')
postal_id       text     -- Postal's bounce id
postal_message_id text   -- the original message that bounced
detail          jsonb
created_at      timestamptz DEFAULT now()
```

## Trial-warning emails (Sprint 8 cron)

`/api/cron/trial-warnings` (gated by `X-Cron-Secret`):
1. SELECT user_subscriptions WHERE status='trialing' AND trial_end_at IN (7d, 3d, 1d) ranges.
2. Filter out users whose `trial_warnings_sent JSONB array` already has the warning.
3. For each: resolve `users_v2.recipient_email` via app_config_v2 → render HTML template → POST `/api/email/send`.
4. Mark `trial_warnings_sent` regardless of email success/fail (avoids spam on hard-bounce).

`CRON_SECRET` is currently UNSET on both tiers — these endpoints return 503 until external scheduler is wired. No regression because nothing currently calls them.

## Postal mode per tier

| Tier | Mail server | Mode | Behavior |
|------|-------------|------|----------|
| DEV | `writers-workbench-mail-dev` | Development | Postal swallows sends; logs in Messages tab |
| PROD | `writers-workbench-mail-prod` | Live | Real outbound delivery |

DEV's Postal mode is "Development" so smoke tests don't spam customers. To verify mode, open Postal admin → server → Settings → Server Settings (NOT the LIVE/online badge).

## Health check probe

`/api/health` includes `checks.postal`:
- `'ok'` — successful HEAD / GET to POSTAL_API_URL.
- `'error'` — unreachable.
- `'skipped'` — when `DRY_RUN_EMAIL=true` (no point pinging).

## Common gotchas

- **`X-Server-API-Key`** (NOT `Authorization`) — Postal's auth header.
- **DKIM signing** requires consistent `signing.key` between postal-web and postal-worker `/config` volumes. Drift breaks signing silently.
- **Return Path CNAME** must be DNS-only (grey cloud) in Cloudflare. Orange-cloud breaks bounces.
- **"LIVE" badge ≠ Live mode** — server tile says LIVE for "online", the actual mode is in Server Settings.
- **`SENDER_NAME=The Writers Workbench (Dev)`** got copied to PROD on v1.1.0 release; users would have seen "(Dev)" in From. Caught + fixed before user traffic.
- **Multiple sendEmail calls without user_id** bypass rate limit. n8n calls always include user_id; tests sometimes skip.
- **Attachments** are base64 in Postal API. `Buffer.toString('base64')`. Don't include the `data:image/png;base64,` prefix.
- **Postal `:3` image tag does NOT exist** — use `:latest` or `:3.3.5`. Real install gotcha.
