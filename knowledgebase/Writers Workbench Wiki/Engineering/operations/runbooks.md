---
name: Runbooks
description: Common operational tasks — backfill story bible, add genre, debug Cloudflare 524, reset password, etc.
type: concept
tags: [operations, runbooks]
last_reviewed: 2026-05-09
---

# Runbooks

Step-by-step procedures for common ops tasks.

## RB-1 — Backfill story bible for a project

When chapters were written before the 2026-04-29 hotfix, their `story_bible_v2` is empty. Backfill via:

### DEV
```bash
N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json) \
python3 scripts/hotfix-backfill-story-bible.py \
  --project-id <uuid> --user-id "+1XXXXXXXXXX"
```

This drives the standalone DEV workflow `hXkfrkuiWbJtJlEl` per-chapter.

### PROD
```bash
# Service-role + Anthropic API directly; no n8n route
python3 scripts/hotfix-backfill-story-bible-prod.py \
  --project-id <uuid> --user-id "+1XXXXXXXXXX"
```

`scripts/hotfix-backfill-story-bible-prod.py` aborts if `SUPABASE_URL` doesn't start with `https://faklxfakgzkpkbxfihzh` — defensive.

Cost: ~$0.10–0.30 per project depending on chapter count.

Flags:
- `--dry-run` — parse + show counts without inserting.
- `--only-chapter N` — backfill a single chapter.

Verify after:
```sql
SELECT entry_type, count(*) FROM story_bible_v2 WHERE project_id = '<uuid>' GROUP BY entry_type;
```

## RB-2 — Add a new genre

```sql
-- Run against PROD (or DEV) Supabase via session pooler:
INSERT INTO genre_config_v2 (slug, name, description, prompt_text, research_topics, is_public)
VALUES (
  'cyberpunk-noir',
  'Cyberpunk Noir',
  'High-tech low-life thrillers with detective sensibilities',
  '<long prompt: themes, voice, conventions, classic examples>',
  ARRAY['cyberpunk fashion', 'corporate dystopia', 'neon-noir aesthetics'],
  true
);
```

Then in n8n hub system prompt: add the new genre under "Available genres" section. Promote DEV → PROD or hotfix.

If RSS feeds are needed: add to `genre_config_v2.genre_urls` (text array) — used by newsletter ingestion (multi-user cron).

Frontend will pick up the new genre automatically (GenreList queries `is_public=true` rows).

## RB-3 — Add a new story arc

```sql
INSERT INTO story_arcs_v2 (name, description, prompt_text, discovery_question, is_public)
VALUES (
  'The Hero''s Two Wolves',
  'Internal conflict structure with two opposing forces',
  '<long prompt with examples>',
  'What two forces are pulling at your protagonist?',
  true
);
```

Arc available immediately in `StoryArcBrowser` and `Brainstorm Story` workflow.

## RB-4 — Reset a user's password (admin)

Service-role:
```bash
curl -X PATCH "https://faklxfakgzkpkbxfihzh.supabase.co/auth/v1/admin/users/<uuid>" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"password":"NewPassword123!"}'
```

Or via Supabase Dashboard → Authentication → Users → click user → Reset password.

For users without a `supabase_auth_uid` (admin-created profile only):
```bash
# 1. Create auth user
curl -X POST "https://…supabase.co/auth/v1/admin/users" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -d '{"email":"...","password":"...","email_confirm":true}'
# Returns {id: <uuid>}

# 2. Link to users_v2
curl -X PATCH "https://…supabase.co/rest/v1/users_v2?user_id=eq.+1XXXXXXXXXX" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -d '{"supabase_auth_uid":"<uuid>"}'
```

This is the v1.1.2 hotfix flow — automated via Edit User dialog now.

## RB-5 — Diagnose Cloudflare 524 on hub sync call

Symptom: ChatDrawer shows error after ~100s on a sync op.

Steps:
1. Check the hub workflow execution log (n8n UI → Executions). If still running, the hub call is just slow.
2. Cloudflare cuts at ~100s. Async ops shouldn't hit this — they return `{jobId}` immediately.
3. If a sync op (list/retrieve) takes >60s, that's a perf bug. Investigate:
   - Slow Supabase query? Check `pg_stat_activity`.
   - Hub Agent re-trying? Check Gemini API logs in n8n.
   - Tool sub-workflow stuck? Check execution log for the sub.

Workaround: classify the op as async in `lib/jobs/classifier.ts` → enqueues + returns jobId quickly.

## RB-6 — Investigate a stuck job in BullMQ

```bash
# Check Redis directly (DEV or PROD)
redis-cli -u $REDIS_URL
> KEYS bull:*
> ZRANGE bull:medium-ops:active 0 -1
> HGETALL bull:medium-ops:<jobId>
```

Or via Workbench:
```bash
curl -H "Authorization: Bearer <jwt>" \
  https://writersworkbench-production.up.railway.app/api/jobs/<jobId>
```

If a job is stuck `active` for > timeout, the worker is dead or hanging. Restart Workbench Railway service.

## RB-7 — Activate / deactivate an n8n workflow

```bash
N8N_API_KEY=…

# Activate
curl -X POST "https://n8n.agileadautomation.com/api/v1/workflows/<id>/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"

# Deactivate (may 403 in n8n 2.x — toggle in UI instead)
curl -X POST "https://n8n.agileadautomation.com/api/v1/workflows/<id>/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

## RB-8 — Update an n8n workflow via REST

```bash
# Get current
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.agileadautomation.com/api/v1/workflows/<id>" \
  > workflow.json

# Edit (in Python, JS, or jq)
# Strip rejected fields:
jq '{name, nodes, connections, settings: {executionOrder: "v1"}}' workflow.json > workflow-stripped.json

# PUT
curl -X PUT "https://n8n.agileadautomation.com/api/v1/workflows/<id>" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  --data @workflow-stripped.json

# n8n 2.x: refresh UI tab + click Publish (⌘P) so activeVersion rebuilds
```

## RB-9 — Smoke test newsletter generation end-to-end

Pre-conditions on DEV:
- Operator clicked Publish on `Content - Newsletter Agent V2` (`bMvMKyK8obwYZmNb`) after PR #74.
- Newsletter cluster migrations applied (013/014/016/017).
- Edition + 1+ subscriber + 1+ approved feed.

Steps:
1. Trigger: `POST /api/newsletter/generate {edition_id}` from UI.
2. Watch ExecutionStatus page — should see stages: gathering → drafting → rendering → saving → sending.
3. Verify `newsletter_sends_v2` row inserted, `status='scheduled'`, `scheduled_send_at = now() + 24h`.
4. Approval email arrives at `recipient_email`.
5. Click approval link.
6. Approve → status='approved'.
7. Cadence cron picks up next cycle.
8. Subscribers receive email (visible in Postal Messages tab on DEV).

## RB-10 — Force-reload activeVersion on a stuck workflow

Symptom: REST PUT updated workflow but runtime still uses old version.

Fix:
1. Open n8n UI → workflow.
2. Refresh tab (⌘R / Ctrl+R).
3. Click Publish (⌘P).

Or via REST:
```bash
curl -X POST "$N8N/api/v1/workflows/<id>/deactivate"
curl -X POST "$N8N/api/v1/workflows/<id>/activate"
```

## RB-11 — Promote DEV → PROD (release-day)

Full procedure in [[promotion-dev-to-prod]].

Quick version:
1. Apply pending DB migrations to PROD.
2. Audit Railway env vars (NEVER blanket-copy DEV→PROD).
3. Run `scripts/promote-dev-to-prod.py --dry-run` then `--apply`.
4. Tag release on `main`. Push: `git push origin main:release/v1.0`.
5. Verify `/api/health`.
6. Smoke test critical paths.
7. Sync `develop` from `main`.

## RB-12 — Find which n8n workflow handles a specific tool

```bash
N8N_API_KEY=…
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.agileadautomation.com/api/v1/workflows?limit=250" \
  | jq '.data[] | {id, name, active}' | grep -i "<keyword>"
```

Or check [[workflow-id-map]].

## RB-13 — Debug RLS policy

If a user reports "I can't see my projects" on PROD:

```sql
-- Connect as that user (impersonate a JWT — Supabase Dashboard supports this)
SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid();
-- If returns NULL, the auth user has no users_v2 row → onboarding hasn't completed
SELECT * FROM writing_projects_v2 WHERE user_id = '+1XXXXXXXXXX';
```

If RLS blocks but the user owns the row, check `get_current_user_id()` resolves correctly.

## RB-14 — Add a new BullMQ worker / queue

```ts
// 1. Add to types.ts
type QueueName = 'sync-ops' | 'medium-ops' | 'heavy-ops' | 'background-ops' | 'new-tier';
QUEUE_SETTINGS['new-tier'] = {concurrency: 4, timeoutMs: 60_000};

// 2. boot.ts startAllWorkers loops over Object.keys(QUEUE_SETTINGS) — picks up automatically

// 3. Update classifier.ts to route certain messages to 'new-tier'
```

Verify on `/api/admin/queues` — new tier appears.

## RB-15 — Rotate a leaked secret

See [[credentials-map]] rotation table.

## RB-16 — Apply a hotfix to PROD

See [[hotfix-flow]].

## RB-17 — Investigate an Anthropic 429

If chapter writes start failing with 429:

1. Check Anthropic dashboard — what's the per-minute output token quota?
2. Check `token_usage_v2` for the last hour — sum of `output_tokens`.
3. If sum > quota: too many concurrent chapter writes. Reduce heavy-ops concurrency:
   ```ts
   QUEUE_SETTINGS['heavy-ops'].concurrency = 1;   // from 2
   ```
4. Long-term: implement Anthropic Token Budget gatekeeper (Sprint 17 plan).

## Future runbooks (TODO when sprint completes)

- RB-X — Stripe webhook investigation (Sprint 9)
- RB-X — Storage migration (if Sprint 14 picks Option B/C)
- RB-X — Multi-instance chapter writer dispatcher tuning (Sprint 18)
