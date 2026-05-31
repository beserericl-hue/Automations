---
name: Callback architecture (web vs phone)
description: How n8n's eve_knowledge_callback chooses between SSE-to-web and outbound-phone-call.
type: concept
tags: [elevenlabs, callbacks, sse, sprint-5]
last_reviewed: 2026-05-09
---

# Callback architecture

When Eve needs to "call back" the user with new content (e.g. "I've finished writing chapter 7 — let's review it"), she has two options:
1. **Web SSE callback** — push a notification to the open web session.
2. **Outbound phone call** — call the user's phone via Twilio + ElevenLabs.

Sprint 5 (S5-4 + S5-5) introduced the routing logic: web is preferred when a session is active.

## The decision

`Sub - Eve Knowledge Callback V2` (DEV `aNRBW0djYtpCwXRW`, PROD `Q0K3aQrBMhw48lCB`):

```
trigger payload: {user_id, content_id, content_type, callback_mode}
   ↓
Set: WORKBENCH_API_URL  (DEV: https://writersworkbenchdev-... ; PROD: https://writersworkbench-...)
   ↓
HTTP GET {WORKBENCH_API_URL}/api/session/active?user_id={{user_id}}
   ↓
IF $json.active === true:
   ├── (web branch) HTTP POST {WORKBENCH_API_URL}/api/callback/content-ready
   │     {user_id, content_id, content_type, title}
   │   → server publishSseEvent → AppShell shows toast + invalidates queries
   │   (no Eve voice call)
   │
   └── (phone branch — only when no web session)
       1. ElevenLabs KB upload: POST /v1/convai/knowledge-base/documents
          - agent_id (PROD or DEV agent based on tier)
          - content (text of the chapter)
          - title (e.g. "Chapter 7: The Efficiency Report")
       2. ElevenLabs PATCH agent.first_message
          (e.g. "I've prepared chapter 7. Let me know when you're ready to review.")
       3. ElevenLabs POST /v1/convai/twilio/outbound-call
          - to_number = users_v2.phone (i.e. user_id)
       4. Wait 30s (in-workflow Wait node)
       5. executeWorkflow → Reset Eve Greeting (g59QidpmVzQUjQNj for V1, t8xslqa3PWOFMAIM for PROD)
          → resets agent.first_message to default
```

## Server side: `/api/session/*`

Implemented in [`server/src/routes/session.ts`](../../../../writers-workbench/server/src/routes/session.ts).

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/session/register` | POST | user JWT | Eve widget mount → register session (Redis hash, 30-min TTL) |
| `/api/session/unregister` | DELETE | user JWT | Eve widget unmount → drop session |
| `/api/session/active` | GET | (none — query param) | n8n queries: is there an open Eve session for `user_id`? |
| `/api/session/events` | GET (EventSource) | `?token=...` query | SSE channel for content-ready, job-status, etc. |
| `/api/callback/content-ready` | POST | (server-internal — should be `X-Callback-Secret`) | n8n posts here when web mode chosen |
| `/api/callback/events` | GET | `?token=...` | Alias for /api/session/events (legacy URL) |

`X-Callback-Secret` was tagged as TODO during the Sprint 5 build; currently the endpoint is open. Tighten before Stripe sprint.

## Why the 30s `Reset Eve Greeting` delay

Setting `agent.first_message` is a global agent property — it changes the greeting for ALL future calls (inbound or outbound) until reset. Without delay:
- The user's outbound callback call captures the contextual greeting → success.
- The next inbound call ALSO captures the contextual greeting → confusing ("I've prepared chapter 7" said when the user is calling about an unrelated request).

With 30s delay:
- Outbound call starts (within ~5s).
- User answers + listens to greeting.
- ~25s in, the reset workflow fires, restoring the default greeting.
- Next inbound call gets the default.

If the call doesn't connect within 30s, the user gets the default greeting on retry. Tradeoff acceptable.

## Web mode: what the client sees

```
Eve widget mounted
  → POST /api/session/register
       INSERT session:{userId} hash
  → SSE channel chan:{userId} subscribed (via AppShell)

n8n calls /api/callback/content-ready
  → publishSseEvent('chan:{userId}', {type:'content-ready', content_id, title})
  → AppShell receives via subscriber → window.dispatchEvent('app-sse', detail)
  → ChatDrawer / NewsletterDetail / etc. handle accordingly
  → toast: "Eve has loaded chapter 7"
  → invalidate dashboard + content queries
```

User can keep working in the Workbench; the chapter shows up in the library, with a side toast.

## Phone mode: what the user hears

Phone rings → ElevenLabs's Twilio number → user picks up → Eve voice plays the contextual `first_message` → conversation starts.

The `agent.first_message` is shown to the user via voice; they can interrupt at any time. Eve's KB has the chapter content injected, so when the user asks "tell me about chapter 7", the agent has context.

## Tier-specific tools

The callback workflow uses tier-specific URLs for the Workbench API:

```
DEV - Sub - Eve Knowledge Callback (aNRBW0djYtpCwXRW)
  WORKBENCH_API_URL = https://writersworkbench-develop.up.railway.app

PROD - Sub - Eve Knowledge Callback (Q0K3aQrBMhw48lCB)
  WORKBENCH_API_URL = https://writersworkbench-production.up.railway.app
```

Promotion script substitutes this when promoting DEV → PROD.

## Eve agent KB cleanup

Each KB document upload returns a `document_id`. The current implementation does NOT delete prior documents — they accumulate. Affects token cost and Eve's response coherence over many sessions.

Cleanup options:
- Manual (admin in ElevenLabs dashboard).
- Periodic cron deleting documents older than X days (not yet built).
- Fresh-per-call: delete previous, upload new (preferred but more API calls).

Open issue tracked in MEMORY.md under planned-features.

## Common gotchas

- **`callback_mode` parameter** — when calling the sub-workflow with `callback_mode='auto'` it picks based on session-active check. `'force_web'` and `'force_phone'` skip the check (used in test scenarios).
- **`/api/session/active`** is currently un-authenticated. Anyone with a user_id can probe whether a session is active. Tighten with `X-Session-Probe-Secret` if/when this becomes sensitive.
- **`first_message` race**: if two callbacks fire within 30s of each other, the second's greeting overwrites the first's, then the reset trigger restores default — middle call gets the wrong greeting. Rare but possible. Use callback queueing if it becomes a problem.
- **Session TTL is 30 min** — if user opens the widget at 9am and walks away, the session expires at 9:30. After that, callbacks go phone. Good default; users who want web-only callbacks should keep the widget mounted.
- **`isActive` race**: `HEXISTS` check before `MULTI`-write. See [[redis-bullmq]] — was a real bug.
