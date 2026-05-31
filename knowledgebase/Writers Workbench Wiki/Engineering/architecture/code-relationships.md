---
name: Code relationships
description: Module dependency graph for client + server. What imports what, what calls what, where boundaries live.
type: concept
tags: [architecture, code-structure]
last_reviewed: 2026-05-09
---

# Code relationships

Dense reference. For depth on each subsystem see [[frontend-stack]], [[backend-stack]], [[express-routes]], [[components]].

## Top-level layout

```
writers-workbench/
├── client/         (React SPA — Vite)
│   └── src/
│       ├── App.tsx                    routes; wraps with ToastProvider, AuthProvider, etc.
│       ├── main.tsx                   ReactDOM render
│       ├── config/supabase.ts         Supabase client (anon key)
│       ├── config/constants.ts        env vars
│       ├── contexts/AuthContext.tsx   Supabase Auth session
│       ├── contexts/UserContext.tsx   user profile + impersonation state
│       ├── contexts/ToastContext.tsx  global toast queue
│       ├── hooks/useDashboardData.ts  TanStack Query: counts + recent items
│       ├── hooks/useTheme.ts          dark/light/system
│       ├── hooks/useNewsletterEvents.ts  SSE subscriber for newsletter SSE
│       ├── lib/content-utils.ts       markdown → HTML (marked) + sanitize
│       ├── lib/api-fetch.ts           apiFetch helper (X-Impersonate-User header)
│       ├── types/database.ts          all TypeScript types for Supabase tables
│       └── components/                see frontend/components
└── server/         (Express)
    └── src/
        ├── index.ts                   app boot, middleware, route registration, shutdown
        ├── swagger.ts                 OpenAPI 3.0.3 spec
        ├── schemas.ts                 Zod request schemas
        ├── routes/                    see backend/express-routes
        ├── middleware/
        │   ├── auth.ts                requireAuth, requireAdmin, requireSuperuser, requireTierFeature, requireCredits
        │   ├── error-handler.ts       central error → JSON response
        │   ├── shared-secret.ts       factory: requireSecret('X-...-Secret')
        │   └── validate.ts            Zod request validation
        ├── lib/
        │   ├── redis.ts               IORedis lazy client + reconnect handling
        │   ├── queue.ts               BullMQ Queue factory + name registry
        │   ├── jobs/
        │   │   ├── types.ts           QueueName, PriorityTier, QUEUE_SETTINGS, payload interfaces
        │   │   ├── classifier.ts      regex-rule message classifier
        │   │   ├── n8n-worker.ts      BullMQ Worker factory; HTTP retry semantics
        │   │   ├── concurrency.ts     per-user slot acquire/release (Redis INCR)
        │   │   ├── job-tracker.ts     addTrackedJob + attachTrackerToQueue
        │   │   ├── sse-forwarder.ts   bullmq events → SSE
        │   │   └── boot.ts            startAllWorkers (called from index.ts)
        │   ├── session-store.ts       SessionStore interface; Redis impl + in-memory fallback
        │   ├── sse-pubsub.ts          publishSseEvent, subscribeSseChannel (Redis pub/sub)
        │   ├── email.ts               sendEmail() Postal client (DRY_RUN_EMAIL aware)
        │   ├── newsletter-render.ts   Handlebars merge for newsletter templates
        │   ├── approvals.ts           token gen + expiry
        │   ├── rate-limit.ts          per-user/window Redis counter (email)
        │   └── logger.ts              pino logger
        └── services/
            └── supabase-admin.ts      lazy supabase service-role client
```

## Critical request paths (server)

### `POST /api/chat/proxy`

```
chat.ts
 → requireAuth (auth.ts)
 → requireCredits('chat') (auth.ts)
 → classifier.classify(message) → {tier, jobType}
 → if (tier === 'sync')
       fetch(N8N_HUB_WEBHOOK_URL) → return body
   else
       jobTracker.addTrackedJob(queueName, jobName, payload, userId)
           → INSERT job_queue_v2
           → queue.add() → Redis
       deductCredits()
       return {jobId, trackerRowId}
```

### Worker → n8n

```
boot.ts → startAllWorkers()
 → for each tier in QUEUE_SETTINGS:
     n8n-worker.createN8nWorker({queueName, concurrency, timeout})
       → Worker.process: tryAcquireUserSlot → fetch(N8N_HUB_WEBHOOK_URL) → releaseUserSlot
       → 2xx → return ok; 4xx → return ok:false (no retry); 5xx/network → throw (retry)
job-tracker.attachTrackerToQueue(queue) → QueueEvents listener
 → 'waiting'/'active'/'completed'/'failed' → UPDATE job_queue_v2.status
sse-forwarder.attachSseForwarder(queue, pushSseEvent)
 → emits {type:'job-status', jobId, status, progress} on user channel
```

### Impersonation read

```
apiFetch (client lib/api-fetch.ts)
 → if (UserContext.isImpersonating) headers['X-Impersonate-User'] = targetId
 → fetch(url, ...)

server requireAuth (middleware/auth.ts)
 → resolve auth.uid() → users_v2 row
 → if (header X-Impersonate-User AND role IN superuser AND active impersonation_log row)
     req.userId = header value
     req.isImpersonating = true
   else
     req.userId = original userId

routes/impersonate-data.ts
 → uses req.userId (which is target user's id during impersonation)
 → service-role client + .eq('user_id', req.userId)
```

## Critical paths (client)

### Login → app shell

```
App.tsx
 → AuthGuard (auth/AuthGuard.tsx)
   → useAuth() (contexts/AuthContext.tsx)
   → if (!session) <Navigate to="/login" />
   → else <UserProvider> <AppShell> <Outlet /> </AppShell> </UserProvider>

UserProvider (contexts/UserContext.tsx)
 → loads users_v2 row by supabase_auth_uid
 → loads role_meta + subscription
 → exposes {user, role, isImpersonating, impersonateAs(targetId), endImpersonation()}

AppShell (layout/AppShell.tsx)
 → mounts SSE EventSource → /api/callback/events?token=…
 → onmessage: {content-ready, job-status, newsletter:*, eve:*} → fan to window
 → renders ImpersonationBanner, TrialBanner, ToastContainer, OnboardingTutorial
```

### ChatDrawer

```
ChatDrawer.tsx
 → reads chat history from localStorage (100-msg cap)
 → on submit: apiFetch(POST /api/chat/proxy)
 → if response has jobId → push to activeJobs (localStorage); render Queued pill
 → onWindowMessage('chat-job-status', {jobId, status}) → update pill
 → SSE comes from AppShell's listener fanned via window.dispatchEvent
```

### ContentDetail (chapter / blog / newsletter editor)

```
ContentDetail.tsx
 → useQuery({ queryKey:['content', id], queryFn: supabase select })
 → marked → HTML for editor body
 → TipTap StarterKit + Link + Placeholder
 → debounced auto-save: PATCH published_content_v2 (or POST impersonate/write/content/:id)
 → status flow: draft → approved → published / rejected / scheduled
 → ProvenancePanel + QAReportPanel + AnnotationsPanel side panels
 → cover-image banner from cover_image_path
 → Ctrl+S keyboard shortcut to save immediately
 → useBlocker (React Router) for unsaved-changes warning
```

### Impersonation write surface

```
Whenever a mutation happens AND useUser().isImpersonating:
  use apiFetch instead of supabase client
  routes through /api/impersonate/write/<resource>
  - field whitelist per resource
  - audit entry appended to impersonation_log.actions_taken (cap 500)

Wired surfaces (verified Sprint 8 review):
  ProjectEditForm, ProjectDetail delete, ContentDetail save+delete+status+schedule+cover,
  StoryBiblePanel/EntryForm CRUD, ResearchDetail save+delete, ResearchList delete,
  TrashView restore, ContentLibrary bulk approve+publish+delete (per-id audit),
  AnnotationsPanel apply+dismiss
```

## Cross-cutting patterns

| Pattern | Where | Why |
|---------|-------|-----|
| TanStack Query for all reads | Hooks + components | Auto-refetch, cache invalidation on SSE |
| Direct Supabase for reads (anon key + JWT) | Client | RLS enforces scope; no server roundtrip |
| Service-role + ACL-in-code for writes | Server impersonate-write/admin/etc. | Bypass RLS for admin tasks; check req.userId scope manually |
| Shared-secret middleware for n8n→server | shared-secret.ts factory | n8n calls /api/email/send, /api/ingestion/*, /api/callback/* with `X-*-Secret` headers |
| BullMQ for any op > 500ms | jobs/ | Don't tie up HTTP; SSE callback for completion |
| Zod schemas in schemas.ts | Server route handlers | Type-safe validation at the boundary |

## Known dead/legacy code

- `client/src/components/content/ContentList.tsx` — superseded by `ContentLibrary.tsx` (Sprint 2). Safe to delete after import audit.
- Legacy chapter routes in `App.tsx` — `/chapters`, `/short-stories`, `/blog-posts`, `/newsletters` redirect to `/library?type=…` for back-compat.
- `BZku8v1a2K12iFGQ` (OpenAI httpHeaderAuth credential) in n8n — referenced by no active workflow; legacy. Use native `xSzPIySN61drme77` instead.
