---
name: Data flow
description: How a request traverses the system — from chat input through queue, n8n, tool sub-workflows, DB, storage, email, and back via SSE.
type: concept
tags: [architecture, data-flow]
last_reviewed: 2026-05-09
---

# Data flow

Three primary entry points: web chat, Eve voice, scheduled cron. All converge on the n8n hub.

## 1. Web chat — async write op (e.g. "Write Chapter 8")

```
User → ChatDrawer
   → POST /api/chat/proxy {user_message_request, caller_id}
   → requireAuth (loads role meta + account meta + subscription)
   → preflight credit check (returns 402 if insufficient)
   → classifier (jobs/classifier.ts)
       └─ heavy-ops queue, job type = N8nWebhookJob
   → addTrackedJob() → INSERT job_queue_v2 row + BullMQ enqueue
   → respond {jobId, trackerRowId, status:'queued', creditsRequired, creditsRemaining}
   → deduct credits (UPDATE user_subscriptions, INSERT credit_transactions)
   ChatDrawer pill: Queued

BullMQ worker dequeues
   → tryAcquireUserSlot (Redis INCR with 30-min TTL)
       └─ if exhausted: moveToDelayed(now+5s) + DelayedError
   → POST {N8N_HUB_WEBHOOK_URL} {user_message_request, user_id}
   ChatDrawer pill: Processing

n8n hub (PROD - The Author Agent)
   → preprocess_message Code node (regex pre-route)
   → Gemini 2.5 Flash Agent picks tool
   → executeWorkflow → Worker - Write Chapter
       → build_chapter_context → Sub-chapter parallel write → continuity merge → extract_bible
       → INSERT published_content_v2 + content_versions_v2
       → UPSERT story_bible_v2 entries
       → POST {WORKBENCH_API_URL}/api/email/send (Postal)
       → POST {WORKBENCH_API_URL}/api/callback/content-ready
   → return result to hub agent

Server /api/callback/content-ready
   → publishSseEvent(user_id, {type:'content-ready', content_id, content_type})
   → SSE forwarder fans out to all open EventSource connections
   → AppShell SSE listener: invalidate dashboard + content queries; show toast
   → ChatDrawer pill: Complete
```

Total wall time for a chapter: 3–10 minutes.

## 2. Web chat — sync op (e.g. "list my outlines")

```
User → ChatDrawer "list my outlines"
   → POST /api/chat/proxy
   → classifier → sync-ops queue (no enqueue — direct call)
   → POST {N8N_HUB_WEBHOOK_URL} (synchronous)
   → n8n hub → Retrieve Content tool → SELECT writing_projects_v2 → return rows
   → server returns {success, items}
ChatDrawer renders the list immediately (no SSE).
```

Wall time: <2s.

## 3. Eve voice — write op

```
User talks to Eve widget on web
   → ElevenLabs streams audio + transcribes
   → Gemini agent (Eve's LLM) picks tool: forward_writing_request_v2 (PROD) or _dev (DEV)
   → POST /webhook/author_request_v2 directly to n8n hub
       (bypasses Workbench server — Eve calls n8n directly)
   → n8n hub same as above
   → tool sub-workflow → DB write + email + (callback)

Eve session is registered server-side for callback routing:
   - On widget mount: POST /api/session/register {user_id}
   - On widget unmount: DELETE /api/session/unregister
   - n8n's eve_knowledge_callback queries GET /api/session/active?user_id=X
       - If web session active: POST /api/callback/content-ready (SSE push)
       - Else: trigger Eve outbound phone call
```

## 4. Scheduled cron — newsletter ingestion

```
n8n DEV - Newsletter Ingestion Multi-User Cron (JAQ8rmCaDoddqt2k)
   - Schedule trigger every 30 min
   - SELECT newsletter_feed_sources_v2 grouped by user_id
   - For each feed:
       → POST /api/ingestion/search?prefix=YYYY-MM-DD/&user_id=...
           (X-Ingestion-Secret header)
       → Firecrawl scrape via Node - Scrape Url V2 (BJaUNEt6PPIqbWLa)
       → POST /api/ingestion/upload {markdown, html, metadata}
   - INSERT newsletter_ingestion_runs_v2

DEV - Newsletter Cadence Cron (7l1z4uMS9kdkYIT4) — hourly
   - GET /api/newsletter/cron/editions/due
   - SplitInBatches over due editions
   - POST /webhook/compose-newsletter-dev for each
       → Content - Newsletter Agent V2 (bMvMKyK8obwYZmNb)
       → Generates HTML + saves newsletter_sends_v2 row
       → Fan-out to subscribers (after operator clicks Publish in n8n UI)
```

Currently DEV-only; PROD promotion pending. See [[newsletter-workflows]].

## 5. Cross-tier RLS-aware data access

**Frontend → Supabase direct:**
```
client.tsx imports @supabase/supabase-js
   → uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
   → JWT from Supabase Auth attached automatically
   → RLS function get_current_user_id() resolves auth.uid() → users_v2.user_id
   → row-level filtering applied
```

**Server → Supabase service-role:**
```
server uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
   → bypasses RLS
   → must enforce ACL in code (e.g. .eq('user_id', req.userId))
   → req.userId is the impersonated id when X-Impersonate-User header is set
       AND the superuser has an active impersonation_log row
```

## 6. Credit deduction flow (Sprint 8)

```
Pre-check at /api/chat/proxy:
   SELECT credits_remaining FROM user_subscriptions WHERE user_id = req.userId
   if (remaining < op_cost) return 402 INSUFFICIENT_CREDITS
   else continue

Post-success:
   UPDATE user_subscriptions
     SET credits_remaining = credits_remaining - cost,
         credits_used_this_period = credits_used_this_period + cost
   INSERT credit_transactions {user_id, transaction_type:'usage', amount:-cost, balance_after}
   Response header: X-Credits-Remaining

Op costs (configurable in app_config_v2.sprint8_superuser_config.credit_costs):
   write: 5, brainstorm: 3, research: 2, cover_art: 10, social: 3, list/retrieve: 0
```

See [[sprint-8-rbac]] for RBAC + credit ledger details.

## 7. Newsletter generation flow

```
User → /newsletter/generate UI → POST /api/newsletter/generate
   → enqueues compose-newsletter job (medium-ops)
   → POST /webhook/compose-newsletter-dev
   → Content - Newsletter Agent V2 (bMvMKyK8obwYZmNb)
       - Gathers ingestion items via /api/ingestion/search
       - Drafts via Claude Sonnet
       - Renders HTML via /api/newsletter/render-html (Handlebars merge)
       - INSERT newsletter_sends_v2 status='scheduled', scheduled_send_at = now+24h
       - INSERT newsletter_approvals_v2 {token, expires_at}
       - POST email to user with approval link
   → User clicks /newsletter/approvals/:token
       → Approve → status='approved' → cadence cron fires fan-out
       → Reject → status='rejected'
   → DEV - Newsletter Cadence Cron picks up scheduled+approved:
       - fetch_subscribers (newsletter_subscribers_v2 WHERE status='active')
       - send_to_subscribers via Postal /api/email/send
```

See [[newsletter-cluster]] for sprint chronology.
