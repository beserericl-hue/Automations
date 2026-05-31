---
name: System overview
description: End-to-end system diagram. Surfaces, server, queue, n8n hub, tool workflows, databases, storage, email, voice agent.
type: concept
tags: [architecture, system]
last_reviewed: 2026-05-09
---

# System overview

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  Web client (React)     │        │  Eve voice (ElevenLabs) │
│  ChatDrawer + Eve embed │        │  agent_2801…(PROD)      │
└──────────┬──────────────┘        └────────┬────────────────┘
           │ POST /api/chat/proxy           │ POST /webhook/author_request_v2
           ▼                                │
┌─────────────────────────┐                 │
│  Express server         │                 │
│  • requireAuth + RBAC   │                 │
│  • classifier           │                 │
│  • credit gate          │                 │
│  • impersonation header │                 │
└──────┬───────────┬──────┘                 │
       │           │                        │
   sync│           │async (BullMQ)          │
       │           ▼                        │
       │      ┌─────────────────┐           │
       │      │ Redis (BullMQ)  │           │
       │      │ • sync-ops      │           │
       │      │ • medium-ops    │           │
       │      │ • heavy-ops     │           │
       │      │ • background    │           │
       │      └────────┬────────┘           │
       │               │ worker dequeues    │
       └───────────────┼────────────────────┤
                       ▼                    ▼
            ┌──────────────────────────────────┐
            │ n8n hub  /webhook/author_request_(v2|dev) │
            │ • Gemini 2.5 Flash routing agent │
            │ • preprocess_message regex pre-route │
            │ • dispatches to ~24 tool sub-flows │
            └────────────┬─────────────────────┘
                         │ executeWorkflow / ai_tool
                         ▼
              ┌──────────────────────────┐
              │ Tool sub-workflows       │
              │ • Worker - Write Chapter │
              │ • Brainstorm Story       │
              │ • Generate Cover Art     │
              │ • Repurpose to Social    │
              │ • Retrieve Content       │
              │ • + 19 more              │
              └──┬──────────┬───────┬────┘
                 │          │       │
                 ▼          ▼       ▼
       ┌──────────────┐  ┌─────┐  ┌──────────┐
       │ Supabase     │  │Storage│  │ Postal   │
       │ Postgres 17  │  │buckets│  │ /api/email/send
       └──────────────┘  └─────┘  └──────────┘
                 │
                 ▼
       SSE callback /api/callback/content-ready
                 │
                 ▼
              client gets toast + invalidate
```

## Per-tier wiring

Two parallel copies of everything except n8n itself, which is one shared instance with `PROD - <name>` and `DEV - <name>` workflows isolated by:

- **Supabase URL/key in Set nodes** — each tier hits its own Supabase project.
- **Webhook path suffix** — `_v2` for PROD, `_dev` for DEV. Workers use `-v2` / `-dev`.
- **`executeWorkflow` refs** — the DEV hub only references DEV sibling ids (per [[workflow-id-map]]); PROD only references PROD ids. Cross-tier wiring is the most common promotion bug — see [[promotion-dev-to-prod]].

## Surfaces

- **Web** — React 18 SPA. Two surfaces: ChatDrawer (top bar) + Eve widget (sidebar). See [[frontend-stack]].
- **Voice** — ElevenLabs `<elevenlabs-convai>` embed widget. See [[chat-and-eve]].
- **Phone** — Eve outbound call via `POST /v1/convai/twilio/outbound-call`. Used by callbacks when no web session. See [[callback-architecture]].

## Server boundaries

The Express server is intentionally small:
- `/api/health` — liveness + dep checks (Supabase, Redis, Postal).
- `/api/chat/proxy` — credit gate + classify + dispatch (sync direct call, async via BullMQ).
- `/api/admin/*` — RBAC-protected admin operations.
- `/api/superuser/*` — superuser-only (impersonation, tier admin).
- `/api/impersonate/{data,write}/*` — full read/write data plane during impersonation.
- `/api/newsletter/*` — newsletter feature surface.
- `/api/ingestion/*` — newsletter ingestion shared-secret API (called from n8n).
- `/api/email/send` — Postal proxy (called from n8n).
- `/api/callback/{content-ready,events}` — n8n→Workbench callback.
- `/api/session/{register,unregister,active,events}` — Eve session tracking.
- `/api/cron/{trial-check,credit-reset,trial-warnings}` — externally-triggered cron, gated by `X-Cron-Secret`.

Frontend talks to Supabase **directly** with anon key + JWT (RLS enforces scope). The server is for things that need a service-role key, secret-gated webhook receivers, or queue-orchestration.

## Where each tier's traffic lands

| Surface | DEV → | PROD → |
|---------|------|--------|
| Web client | DEV Workbench Railway → DEV Supabase | PROD Workbench Railway → PROD Supabase |
| n8n hub | `/webhook/author_request_dev` → DEV tools → DEV Supabase | `/webhook/author_request_v2` → PROD tools → PROD Supabase |
| Eve agent | DEV Eve → tool `forward_writing_request_dev` → DEV hub | PROD Eve → tool `forward_writing_request_v2` → PROD hub |
| Postal mail | `writers-workbench-mail-dev` (Development mode — swallowed) | `writers-workbench-mail-prod` (Live) |
| Ingestion cron | DEV cron workflow → `/api/ingestion/*` on DEV Workbench → DEV Supabase | (Not yet promoted to PROD) |

See [[deployment-railway]] for env-var details.
