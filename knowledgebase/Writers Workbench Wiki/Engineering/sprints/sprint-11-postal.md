---
name: Sprint 11 — Postal email migration
description: Migrate 14 V2 email-sending workflows from Gmail OAuth to Postal via /api/email/send. Plus rate-limiting and bounce auto-flip.
type: concept
tags: [sprints, sprint-11, postal, email]
last_reviewed: 2026-05-09
---

# Sprint 11 — Postal email migration

**Released:** v1.1.0 (2026-04-28). DEV-complete from Newsletter Migration cluster + S11 sweep.
**PRs:** [#16](https://github.com/beserericl-hue/Automations/pull/16) (Postal install runbook), [#17](https://github.com/beserericl-hue/Automations/pull/17) (`/api/email/send` endpoint), [#23](https://github.com/beserericl-hue/Automations/pull/23) (S11-4 rate limiter), [#24](https://github.com/beserericl-hue/Automations/pull/24) (S11-5 bounce + complaint webhook + admin UI).

5 stories. The biggest single sweep was `scripts/s11-migrate-gmail-to-postal.py` (commit `b9303aa`) which replaced Gmail Send nodes in 14 workflows with HTTP Request → `/api/email/send`.

## S11-1, S11-2, S11-3 — Workflow migrations

Done in a single sweep via the script. Each workflow's `send_email` node was replaced with:

```yaml
type: n8n-nodes-base.httpRequest
parameters:
  url: =https://writersworkbench-develop.up.railway.app/api/email/send
  method: POST
  authentication: httpHeaderAuth
  contentType: application/json
  body:
    to: ={{$json.recipient_email}}
    subject: ={{$json.email_subject}}
    html: ={{$json.email_body_html}}
    user_id: ={{$json.user_id}}
credentials:
  httpHeaderAuth: <DEV Workbench Email Secret = kxrSg24PIR2Npfvw>
```

Workflows touched:
- DEV - Tool - Brainstorm Story
- DEV - Tool - Brainstorm Chapter
- DEV - Tool - Edit Outline
- DEV - Tool - Email Research Report
- DEV - Sub - Manage Library (approve/publish/reject/schedule notifications)
- DEV - Tool - Write Blog Post
- DEV - Tool - Write Newsletter
- DEV - Tool - Write Short Story
- DEV - Worker - Write Chapter
- DEV - Tool - Format Kindle Book
- DEV - Tool - Generate Cover Art (send_email_with_image)
- DEV - Tool - Repurpose to Social Posts
- DEV - Tool - QA Chapter (send_clean_email + send_email)
- DEV - Cron: Scheduled Publisher (publish notifications)

DEV: 14/14 on Postal. PROD: 14/14 on Gmail until v1.1.0 release; promoted via `scripts/promote-dev-to-prod.py`.

## S11-4 — Redis-backed email rate limiter

PR #23. [`server/src/lib/rate-limit.ts`](../../../../writers-workbench/server/src/lib/rate-limit.ts).

```ts
emailRateLimit(userId) → {allowed, remaining, resetAt}
  - INCR email:{userId}:{minute}
  - EXPIRE 70   (slightly > 60 to handle clock skew)
  - if count > 30: return {allowed:false, ...}
```

30/min/user_id sliding window. Returns 429 on exceed.

Applied in `routes/email.ts`:
```ts
if (user_id) {
  const limit = await emailRateLimit(user_id);
  if (!limit.allowed) return res.status(429).json({error:'rate_limited', remaining: 0});
}
```

## S11-5 — Bounce + complaint webhook + admin UI

PR #24.

- Migration `010_email_bounces.sql` — `email_bounces_v2` table.
- Postal webhook → server endpoint accepts bounce notifications.
- INSERT `email_bounces_v2` row.
- If hard bounce + email matches `newsletter_subscribers_v2.email` → UPDATE that row `status='bounced'` (later expanded by Newsletter PR #74).
- AdminPanel "Email Bounces" tab — type filter (hard/soft) + severity badges.

`email_bounces_v2` schema:
```
id              uuid PK
user_id         text FK              -- the original recipient (if known)
email           text NOT NULL
type            text CHECK ('hard_bounce','soft_bounce','complaint','unsubscribe')
postal_id       text                 -- Postal's bounce id
postal_message_id text                -- the original message that bounced
detail          jsonb
created_at      timestamptz DEFAULT now()
```

## Postal install runbook

PR #16. [`writers-workbench/docs/postal-install-runbook.md`](../../../../writers-workbench/docs/postal-install-runbook.md).

Captured all the install-time gotchas:
- Postal 3.x image tag `:3` doesn't exist on GHCR — use `:latest` or `:3.3.5`.
- `postal start` is NOT a real command. Each process is its own service: `postal web-server`, `postal worker`, `postal smtp-server`. Custom Start Command per service.
- `BIND_ADDRESS=0.0.0.0`, `PORT=8080`. Default is loopback.
- MariaDB user needs `GRANT ALL PRIVILEGES ON \`postal-%\`.* TO 'postal'@'%'`.
- `web_hostname` from `postal.yml` is the only allowed host — others 403.
- "LIVE" badge ≠ Live mode. Check Server Settings.
- Cloudflare Return Path CNAME must be DNS-only (grey cloud).

See [[postal-mail-stack]].

## `/api/email/send` endpoint

PR #17. See [[email-pipeline]] for the deep dive.

```ts
sendEmail({to, subject, html, text?, from?, reply_to?, attachments?, user_id?})
  → DRY_RUN_EMAIL bypass returns dry-run result
  → otherwise POST to Postal /send/message
  → returns {success, message_id, mode}
```

Smoke tests executed live:
- Dry-run: `{success:true, message_id:'dry-run-...', mode:'dry-run'}` — 200.
- Live (Postal called): `{success:true, message_id:'f8c95e3c-...@rp.postal.courseworx.media', mode:'sent'}` — 200.
- `/api/health` shows `checks.postal: ok`.

## Env vars

DEV (set 2026-04-22):
- `POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1`
- `POSTAL_API_KEY=<dev-api-key>` (writers-workbench-mail-dev)
- `EMAIL_SECRET=30c8dc2b3a1339a996c1dff20e5ea28d6e466870cef7635a9a4723819877431d`
- `SENDER_EMAIL=eve@courseworx.media`
- `SENDER_NAME=The Writers Workbench` (was `(Dev)` until v1.1.0 fix)
- `REPLY_TO_EMAIL=support@courseworx.media`
- `DRY_RUN_EMAIL=false` (after smoke tests)

PROD: same shape, different POSTAL_API_KEY (writers-workbench-mail-prod) + own EMAIL_SECRET.

## Status verification

`gh pr list --state all` 2026-04-29 verified:
- DEV: 14/14 email-sending workflows on Postal; zero on Gmail.
- PROD: 14/14 also on Postal as of v1.1.0 release.
- 0 Gmail OAuth dependencies in active V2 workflows.
- V1 (`Orig`) workflows still use Gmail (`CPCSZOInV8Zj1PI1`) — frozen, intentional.

## Common gotchas

- **`X-Server-API-Key`** is Postal's auth header (NOT `Authorization`).
- **Per-tier `POSTAL_API_KEY`** — DEV has its own, PROD has its own. Mode-isolation is at the mail-server level, not infra level.
- **`DRY_RUN_EMAIL=true`** silently skips the call — flip back to false for production.
- **DKIM** requires consistent `signing.key` between postal-web + postal-worker `/config` volumes.
- **Cloudflare grey-cloud** the Return Path CNAME or bounces fail in non-obvious ways.
- **Rate limit** is per-user, NOT per-tier or global. A single user spamming `/api/email/send` 31 times in a minute gets 429 on the 31st.
- **Gmail OAuth refresh tokens** can silently expire — V1 workflows still use this. If V1 emails stop, reauthorize the Gmail OAuth credential.
