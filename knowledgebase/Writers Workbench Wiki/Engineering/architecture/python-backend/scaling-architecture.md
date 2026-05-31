---
name: Scaling architecture (visual)
description: Top-down visual diagrams of the Python backend at production scale. Service-group deployment, request flow, queue topology, multi-replica scaling, capacity math, multi-region future state.
type: concept
tags: [architecture, python-backend, scaling, deployment, visual]
last_reviewed: 2026-05-10
---

# Scaling architecture

How the entire stack ties together at production scale. Visual-first.

## Top-level system topology

```
                                    Internet
                                       │
                                       │
          ┌────────────────────────────▼────────────────────────────┐
          │                  Cloudflare DNS + CDN                    │
          │   - api.authoragent.dev      (B2B customers)             │
          │   - workbench.app            (Writers Workbench users)   │
          │   - n8n.agileadautomation.com (V1 baseline only)         │
          └────────────────────────────┬────────────────────────────┘
                                       │
          ┌────────────────────────────▼────────────────────────────┐
          │            Cloudflare Load Balancer                      │
          │   - sticky session: chapter_run_id cookie                │
          │   - per-instance health checks                            │
          │   - automatic failover                                    │
          └────────────────────────────┬────────────────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              │                        │                          │
              ▼                        ▼                          ▼
    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
    │  api-svc         │    │  workbench-svc   │    │  n8n V1 baseline │
    │  (Python)        │    │  (Express)       │    │  (legacy only)   │
    │                  │    │                  │    │                  │
    │  3-10 replicas   │    │  2-3 replicas    │    │  1 replica       │
    │  scales w/ users │    │  serves frontend │    │  V1 customers    │
    │                  │    │  + chat proxy    │    │  only            │
    │  Endpoints:      │    │                  │    │                  │
    │   /webhook/*     │    │  /api/*          │    │  /webhook/       │
    │   /v1/*          │    │  Static assets   │    │   author_request │
    │   /internal/*    │    │  SSE callbacks   │    │  (frozen)        │
    │   /admin/*       │    │                  │    │                  │
    └─────────┬────────┘    └─────────┬────────┘    └──────────────────┘
              │                       │
              └───────────────┬───────┘
                              │
              ┌───────────────▼─────────────────────┐
              │         Redis (per environment)      │
              │   - Queues (arq, BullMQ legacy)      │
              │   - Token budget (sliding window)    │
              │   - Slots (per-user, per-tenant)     │
              │   - Idempotency cache                 │
              │   - Rate limits                       │
              │   - Sessions                          │
              │   - SSE pub/sub                       │
              │   - Auth cache                        │
              │   - Cron leader-election locks        │
              └───────────────┬─────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ worker-      │  │ worker-      │  │ worker-      │
    │ heavy        │  │ light        │  │ cron         │
    │              │  │              │  │              │
    │ 3-10 reps    │  │ 2-3 reps     │  │ 1-2 reps     │
    │ chapter,     │  │ library,     │  │ scheduler,   │
    │ brainstorm,  │  │ story_bible, │  │ newsletter   │
    │ research,    │  │ approval,    │  │ ingestion,   │
    │ media, qa    │  │ notify       │  │ cadence,     │
    │              │  │              │  │ trial-check  │
    │              │  │              │  │ (leader-     │
    │              │  │              │  │  elected)    │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
    ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐
    │  Supabase    │ │  Postal mail │ │  External APIs     │
    │  PG 17        │ │  stack       │ │  - Anthropic       │
    │              │ │  (3 services)│ │  - Perplexity      │
    │  Tables:     │ │              │ │  - ElevenLabs      │
    │  - core      │ │              │ │  - KIE.AI          │
    │  - meta      │ │              │ │  - OpenAI fallback │
    │  - b2b       │ │              │ │  - Firecrawl       │
    │              │ │              │ │  - Stripe          │
    │  Storage:    │ │              │ │                    │
    │  - 8 buckets │ │              │ │                    │
    │              │ │              │ │                    │
    └──────────────┘ └──────────────┘ └────────────────────┘
```

## Service-group deployment detail

Each service group is one Docker image with role-specific entrypoint:

```
                          author-agent-backend repo
                                      │
                                      ▼
                          Three Dockerfiles, one codebase
       ┌──────────────────────────────┼──────────────────────────────┐
       ▼                              ▼                              ▼
┌────────────────┐           ┌────────────────┐           ┌────────────────┐
│ Dockerfile.api │           │Dockerfile.worker│           │Dockerfile.cron │
│                │           │                │           │                │
│ CMD uvicorn    │           │ CMD arq worker │           │ CMD arq worker │
│ app.api:app    │           │   --tier=heavy │           │   --tier=cron  │
│                │           │   OR =light    │           │                │
└────────┬───────┘           └────────┬───────┘           └────────┬───────┘
         │                            │                            │
         │ docker push                 │ docker push                 │ docker push
         ▼                            ▼                            ▼
   ┌──────────┐                  ┌──────────┐                  ┌──────────┐
   │ Railway  │                  │ Railway  │                  │ Railway  │
   │ api-svc  │                  │ worker-  │                  │ worker-  │
   │ (3-10)   │                  │ heavy    │                  │ cron     │
   │          │                  │ (3-10)   │                  │ (1-2)    │
   └──────────┘                  ├──────────┤                  └──────────┘
                                 │ worker-  │
                                 │ light    │
                                 │ (2-3)    │
                                 └──────────┘
```

## Inside a single api-svc container

```
┌──────────────────────────────────────────────────────────────────┐
│ Container: api-svc                                                │
│   FastAPI process (uvicorn, 4 workers per container)              │
│                                                                    │
│   Routers:                                                         │
│   ┌──────────────────────────────────────────────────────┐        │
│   │  /webhook/author_request  → Hub module (agent loop)  │        │
│   │  /v1/agent/run             → Hub module (agent loop)  │        │
│   │  /v1/chapters/*            → chapter dispatch         │        │
│   │  /v1/brainstorm/*          → brainstorm dispatch      │        │
│   │  /v1/research/*            → research dispatch        │        │
│   │  /v1/media/*               → media dispatch           │        │
│   │  /v1/library/*             → library (sync, in-proc)  │        │
│   │  /v1/story-bible/*         → story_bible (sync)       │        │
│   │  /v1/approvals/*           → approval (sync)          │        │
│   │  /v1/notify/*              → notify (sync + enqueue)  │        │
│   │  /v1/jobs/{id}             → job status               │        │
│   │  /v1/account/*             → tenant management        │        │
│   │  /v1/webhooks/*            → webhook registration     │        │
│   │  /internal/*               → mirror with shared-secret│        │
│   │  /admin/*                  → ops endpoints            │        │
│   └──────────────────────────────────────────────────────┘        │
│                                                                    │
│   Middleware stack (top to bottom):                                │
│     1. CORS                                                        │
│     2. Request logging (structlog)                                 │
│     3. OTel instrumentation                                        │
│     4. Auth (API key OR service secret OR admin token)             │
│     5. Tenant resolution (B2B only)                                │
│     6. Rate limit (Redis sliding window)                           │
│     7. Idempotency cache lookup                                    │
│     8. Pydantic validation                                         │
│     9. Route handler                                               │
│    10. Audit log (api_usage_v2 INSERT)                             │
│    11. Response                                                    │
│                                                                    │
│   In-process modules (sync ops execute here):                      │
│     - library (CRUD)                                                │
│     - story_bible (CRUD)                                            │
│     - approval (token gen + validation)                             │
│     - notify (email, SSE pub)                                       │
│                                                                    │
│   Async dispatch (heavy ops):                                       │
│     - enqueue arq job → Redis                                       │
│     - worker-heavy or worker-light picks up                         │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Inside a single worker-heavy container

```
┌──────────────────────────────────────────────────────────────────┐
│ Container: worker-heavy                                            │
│   arq worker process                                               │
│                                                                    │
│   Coroutines: ARQ_HEAVY_CONCURRENCY=2 (default)                   │
│   ┌──────────────────────────────────────────────────────┐        │
│   │  Coroutine 1:                                          │        │
│   │    while True:                                         │        │
│   │      job = await poll_queue('heavy-ops')               │        │
│   │      acquire_user_slot(job.user_id, kind='heavy')      │        │
│   │      reserve_anthropic_budget(model, tokens)           │        │
│   │      try:                                              │        │
│   │        result = await dispatch(job.function, args)     │        │
│   │        update_job_queue_v2(status='completed')         │        │
│   │        publish_sse(user_id, completed)                 │        │
│   │      except RetryableError:                            │        │
│   │        re_enqueue with backoff                         │        │
│   │      finally:                                          │        │
│   │        release_user_slot                                │        │
│   │  Coroutine 2: same                                     │        │
│   └──────────────────────────────────────────────────────┘        │
│                                                                    │
│   Modules (functions registered with arq):                         │
│     - chapter.write_chapter                                         │
│     - chapter.qa_chapter                                            │
│     - chapter.scan_drift (deterministic; fast)                     │
│     - chapter.evaluate_genre                                        │
│     - chapter.rewrite_with_research                                 │
│     - chapter.cross_chapter_continuity                              │
│     - chapter.format_kindle                                         │
│     - brainstorm.brainstorm_story                                   │
│     - brainstorm.brainstorm_chapter                                 │
│     - research.run                                                  │
│     - media.cover_art                                               │
│     - media.social_posts                                            │
│     - media.scrape_url                                              │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Inside worker-cron container

```
┌──────────────────────────────────────────────────────────────────┐
│ Container: worker-cron (1-2 replicas; leader-elected per job)      │
│   arq worker + scheduled triggers                                  │
│                                                                    │
│   Scheduled jobs (every replica polls; leader-election dedupes):   │
│   ┌──────────────────────────────────────────────────────┐        │
│   │  every 30 min:                                         │        │
│   │    if acquire_lock('newsletter_ingestion', 60s):        │        │
│   │      run_newsletter_ingestion_cron()                    │        │
│   │                                                          │        │
│   │  every 1 hour:                                         │        │
│   │    if acquire_lock('newsletter_cadence', 60s):          │        │
│   │      run_newsletter_cadence_cron()                      │        │
│   │    if acquire_lock('scheduled_publisher', 60s):         │        │
│   │      run_scheduled_publisher()                          │        │
│   │                                                          │        │
│   │  daily at 02:00 UTC:                                   │        │
│   │    if acquire_lock('credit_reset', 60s):                │        │
│   │      run_credit_reset()                                 │        │
│   │    if acquire_lock('trial_check', 60s):                 │        │
│   │      run_trial_check()                                  │        │
│   │    if acquire_lock('trial_warnings', 60s):              │        │
│   │      run_trial_warnings()                               │        │
│   │                                                          │        │
│   │  also processes background-ops queue:                  │        │
│   │    - eve_reset_greeting (delayed 30s)                  │        │
│   │    - webhook_dispatch                                   │        │
│   │    - tenant_data_export                                 │        │
│   │    - tenant_deletion_sweep                              │        │
│   │    - ingestion_per_url (called from cron above)        │        │
│   └──────────────────────────────────────────────────────┘        │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Request flow — async heavy op (chapter write)

```
[Eve / Workbench / B2B customer]
         │
         │ POST /webhook/author_request OR /v1/chapters/write
         │ Body: {user_message_request, user_id} OR {project_id, chapter_number, ...}
         ▼
[Cloudflare LB]
         │ sticky-route on tenant_id (B2B) OR round-robin
         ▼
[api-svc replica N]
         │
         │ middleware: auth → rate-limit → idempotency-check → validate
         │ if hub path:
         │   preprocess_message → flags
         │   if direct_op: dispatch directly
         │   else: agent_loop (Haiku tool-use)
         │     agent picks 'write_chapter' tool
         │     dispatch_tool('write_chapter', {...})
         │ else (direct /v1/chapters/write):
         │   handler routes to chapter dispatch
         │
         │ classify('write_chapter') → 'heavy-ops'
         │
         ▼
[arq enqueue]
         │ INSERT job_queue_v2 (status='queued')
         │ ZADD arq:queue:heavy-ops {timestamp} {job_id}
         │
         ▼
[Response to client: 202 + {job_id, status:'queued'}]
         │
         │ (api-svc returns immediately; client polls or webhooks)
         │
         ▼
[worker-heavy replica M dequeues]
         │ ZPOPMIN arq:queue:heavy-ops
         │ HSET arq:in_progress {job_id} {worker_id}
         │ UPDATE job_queue_v2 status='active'
         │
         │ try_acquire_user_slot(user_id, 'heavy')
         │   if !ok: ZADD + delay 5s; raise DelayError
         │
         │ reserve_anthropic_budget('claude-sonnet-4-5', 27000)
         │   if budget exhausted: ZADD + delay until next minute
         │
         │ chapter.write_chapter(args):
         │   1. load context (Supabase)
         │   2. build_chapter_context (LOCKED CHARACTER ROSTER)
         │   3. asyncio.gather(*[write_sub_chapter(p) for p in prompts])
         │      - 5 parallel Anthropic calls (Haiku for sub-chapters per tier)
         │   4. continuity_merge (Sonnet)
         │   5. extract_bible (Sonnet)
         │   6. UPSERT published_content_v2 (idempotent on chapter_run_id)
         │   7. UPSERT story_bible_v2 (deduped)
         │   8. enqueue background tasks:
         │      - generate_cover_art (separate medium-ops job)
         │      - send_email (via notify module → Postal)
         │      - track_token_usage (token_usage_v2)
         │
         │ release_user_slot
         │ release_anthropic_budget (or let TTL expire)
         │
         │ UPDATE job_queue_v2 status='completed', result_json={...}
         │ SETEX arq:result:{job_id} 3600 {...}
         │ PUBLISH chan:{user_id} {type:'job-status', status:'completed'}
         │ if webhook_url registered: enqueue webhook_dispatch job
         │
         ▼
[Workbench AppShell SSE listener] OR [B2B webhook delivered]
         │
         │ AppShell: invalidate dashboard query, show toast
         │ B2B: customer's webhook handler receives signed POST
         │
         ▼
[User sees chapter in library]
```

## Scaling triggers + capacity math

### At Anthropic Tier 3 (current)

```
Output token budget: 80,000 tokens/min per model

Per-chapter cost (5 sub-chapters, hybrid strategy):
  Sonnet: 7k output (continuity merge + extract bible)
  Haiku:  20k output (sub-chapters)

Anthropic ceiling at Tier 3:
  Sonnet ceiling:  80k / 7k = 11.4 chapters/min
  Haiku ceiling:   80k / 20k = 4 chapters/min   ← bottleneck
  Combined ceiling: 4 chapters/min = 240/hour

Workers needed:
  240/hr × 5min/chapter = 20 chapter-minutes/min in flight
  Per replica concurrency: 2
  Replicas needed: 20 / 2 = 10 replicas worker-heavy

Reality check at 100 daily users:
  100 users × 2 chapters/day average = 200 chapters/day
  Peak burst (4× concentration): 50 chapters/hour
  50 < 240/hr ceiling → fine
  Replicas needed: 50/hr × 5min / 2 conc = 4.2 replicas → round up 5

→ 5 worker-heavy replicas adequate at 100 daily users on Tier 3.
```

### At Anthropic Tier 4 (post-50-users)

```
Output token budget: 400,000 tokens/min per model (5× headroom)

Anthropic ceiling at Tier 4:
  Sonnet ceiling:  400k / 7k = 57 chapters/min
  Haiku ceiling:   400k / 20k = 20 chapters/min
  Combined: 20/min = 1200/hour

Workers needed at 1000 daily users:
  1000 users × 2 chapters/day × 4× burst = 333 chapters/hour peak
  333/hr × 5min / 2 conc = 14 replicas

→ ~15 worker-heavy replicas serves 1000 daily users on Tier 4.
```

### Cost at scale

```
@ 100 daily users (Tier 3, 5 replicas):
  api-svc: 3 × $7/mo = $21
  worker-heavy: 5 × $7/mo = $35
  worker-light: 2 × $5/mo = $10
  worker-cron: 1 × $4/mo = $4
  Redis: $10
  Workbench-svc: 2 × $8/mo = $16
  LB: $20
  ────────────────────
  Total: $116/mo infrastructure
  Anthropic: ~$300/mo (chapter writes)
  Total: ~$416/mo
  Per-user: $4.16/mo

@ 1000 daily users (Tier 4, 15 replicas):
  api-svc: 5 × $7/mo = $35
  worker-heavy: 15 × $7/mo = $105
  worker-light: 4 × $5/mo = $20
  worker-cron: 1 × $4/mo = $4
  Redis: $30 (clustered)
  Workbench-svc: 3 × $8/mo = $24
  LB: $20
  ────────────────────
  Total: $238/mo infrastructure
  Anthropic: ~$3,000/mo
  Total: ~$3,238/mo
  Per-user: $3.24/mo

@ 5000 daily users (Tier 4, 50 replicas):
  api-svc: 10 × $7/mo = $70
  worker-heavy: 50 × $7/mo = $350
  worker-light: 8 × $5/mo = $40
  worker-cron: 2 × $4/mo = $8
  Redis: $80 (clustered)
  Workbench-svc: 5 × $8/mo = $40
  LB: $30
  ────────────────────
  Total: $618/mo infrastructure
  Anthropic: ~$15,000/mo
  Total: ~$15,618/mo
  Per-user: $3.12/mo
```

Per-user infrastructure cost falls slightly with scale. Anthropic dominates.

## Auto-scaling rules

Configured in Railway / Kubernetes:

| Service | Scale up when | Scale down when | Min | Max |
|---|---|---|---|---|
| api-svc | p95 latency > 500ms for 5 min OR CPU > 70% sustained | CPU < 30% for 15 min | 2 | 20 |
| worker-heavy | heavy-ops queue depth > 20 OR oldest job age > 60s | queue depth < 5 for 10 min | 2 | 30 |
| worker-light | medium-ops queue depth > 50 | queue depth < 10 for 10 min | 1 | 10 |
| worker-cron | (manual) | (manual) | 1 | 2 |
| workbench-svc | CPU > 70% | CPU < 30% | 1 | 5 |

Min 2 replicas for production-critical services (api-svc, worker-heavy) for high availability — single-replica-down doesn't drop service.

## Multi-region (future state, post-Sprint 26)

Not in scope for initial roadmap, but the architecture supports it:

```
                    ┌──────────────────────────┐
                    │  Global DNS              │
                    │  (Cloudflare)            │
                    └────────────┬─────────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
          ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
          │ us-east-1    │ │ us-west-2    │ │ eu-west-1    │
          │              │ │              │ │              │
          │ api-svc      │ │ api-svc      │ │ api-svc      │
          │ worker-heavy │ │ worker-heavy │ │ worker-heavy │
          │ worker-light │ │ worker-light │ │ worker-light │
          │ Redis        │ │ Redis        │ │ Redis        │
          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                 │                │                 │
                 └────────────────┼─────────────────┘
                                  │
                                  ▼
                      ┌────────────────────────┐
                      │  Supabase (multi-AZ;   │
                      │  read replicas per     │
                      │  region)               │
                      └────────────────────────┘
```

Trade-offs: data residency for EU customers; reduced latency; harder cron coordination (need cross-region leader election); more expensive Redis topology. Defer until customer demand justifies.

## SLA and capacity headroom

For Pro+ customers (99.5% / 99.9% SLAs):
- Always run ≥2 replicas of every service group.
- Auto-scaling has aggressive scale-up (latency-driven) + slow scale-down (15-min hysteresis).
- Capacity reserve: target peak utilization ≤70% so a +50% spike has headroom.
- Anthropic budget reserved at 90% of ceiling (10% headroom for over-counting).

## Disaster recovery

| Failure | RTO | RPO | Mitigation |
|---|---|---|---|
| Single api-svc replica crash | <60s | 0 | Other replicas serve; LB routes around |
| Single worker replica crash | <60s | 0 | Job re-enqueues; another worker picks up |
| Redis instance failure | <5min | <60s of in-flight cache | Restore from snapshot; in-flight cache rebuilds |
| Supabase regional outage | <30min | <5min | All API returns 503; recovery automatic |
| Anthropic outage (full) | dependent | 0 | All write/research/QA fails; CRUD continues |
| Cloudflare outage | dependent | 0 | Direct service URLs (admin-shared) work |
| Postal mail outage | (no impact on chapter generation) | (chapter completes; emails queue) | Postal recovers; emails retry automatically |

Quarterly DR drills: simulate Redis flush, Anthropic 429 burst, Supabase failover. Validate runbooks.

## What this enables

| Capability | Pre-migration (n8n) | Post-migration (Python) |
|---|---|---|
| Daily user ceiling on Tier 3 | ~50 (n8n overhead saturates) | ~250 (Anthropic budget is the bottleneck) |
| Daily user ceiling on Tier 4 | ~250 (n8n still overhead-bound) | ~1500 (Python efficient enough that Anthropic stays bottleneck) |
| Daily user ceiling with multi-LLM | n/a | ~3000+ |
| Cost per user @ 100 daily | $1.45/mo (n8n inefficient) | $0.80/mo |
| Cost per user @ 1000 daily | $1.55/mo | $0.40/mo (efficiencies of scale) |
| B2B revenue stream | impossible (n8n not productizable) | yes (~$50-500k/yr) |
| Rolling deploy time | 5-10 min per workflow × 24 workflows = hours | seconds (Docker pull) |
| Mid-execution recovery | hard (n8n workflow state) | easy (HTTP idempotency keys) |
| Cross-chapter capability | not feasible | native |
| LLM strategy flexibility | per-workflow, hard to coordinate | one config flag, all workers respect |
| Vendor independence | locked to n8n | standard Python; runs anywhere |

## Operational simplicity wins

| Operation | n8n way | Python way |
|---|---|---|
| Deploy new code | PUT 24 workflows × 3 tiers = 72 PUTs + activeVersion fights | docker push + Railway auto-deploy |
| Hotfix a prompt | Edit Code node in n8n UI + Publish | Edit DB row OR file + hot-reload |
| Add new tool | Create n8n workflow + add to hub `ai_tool` list | Add Python function + register in hub.tools |
| Debug stuck job | n8n execution history (good for visual; verbose) | Logs + traces + arq job inspect |
| Roll back | n8n version history per workflow (manual) | LB swap to prior Docker image (seconds) |
| Scale up | Provision new n8n instance + clone workflows + sync | docker scale +N |

## Cross-references

- [[hub-architecture]] — webhook + agent loop in api-svc.
- [[queueing-architecture]] — Redis queue topology + workers.
- [[service-decomposition]] — modules + service group assignment.
- [[api-contracts]] — endpoint surface.
- [[productization]] — B2B platform layer.
- [[multi-tenancy]] — tenant isolation.
- [[observability-deployment]] — monitoring + DR + capacity planning detail.
- [[python-migration-roadmap]] — sprint plan to deliver this.
