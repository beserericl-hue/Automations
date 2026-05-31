---
name: Master plan — Python backend rewrite
description: Architectural decision, scope, service-group deployment model, internal vs external APIs, dual-product positioning (Writers Workbench + B2B Author Agent API).
type: concept
tags: [architecture, python-backend, master-plan, decision]
last_reviewed: 2026-05-09
---

# Master plan — Python backend rewrite

> **2026-05-29 revision — the engine IS the product; per-step microservices; framework-first.**
> Per user direction, the program-level architecture is now defined in **[[engine-framework]]**, which **revises two
> decisions on this page**:
> 1. **Granularity:** *modular monolith / 3 service-groups* → **true per-step microservices** on a shared salable
>    **engine library** (`writer_engine`). Each pipeline step is its own deployable service + image; composable and
>    individually licensable.
> 2. **Positioning:** the Python engine is **the product** — a **salable library/API** ("the engine behind writing
>    apps"); Writers Workbench is its reference app.
> Plus two reinforcements: the **newsletter + write-workshop rewrites are one combined framework** (not separate
> efforts — see [[newsletter-microservices]] as the first instance), **built ahead of Stripe/B2B**; and
> **scalability to the customer-bandwidth goals is a hard requirement** (independent per-step horizontal scaling — see
> [[engine-framework]] §4 + [[scaling-architecture]]). Everything else below (dual-product positioning, `/internal`
> vs `/v1`, arq queue, prompt store, auth model) carries forward unchanged. Read [[engine-framework]] first.

## Architectural decision

Rebuild the entire n8n tool tree as a Python backend (`author-agent-api`). The hub `PROD - The Author Agent` stays in n8n as the routing/agent layer. Every other workflow becomes a Python service module called via HTTP from the hub.

**Why:**

1. **Scalability**: n8n engine overhead (~100ms/node × ~30 nodes) ≈ 3s/chapter of pure orchestration cost. Python reclaims this. See [[design-feasibility]] for the math.
2. **Cost at scale**: ~75% cheaper at 1000 daily users. ~45% cheaper at 100. See [[microservice-alternative]] cost tables.
3. **Idempotency**: Mid-execution crash recovery is hard in n8n, easy in HTTP services with `chapter_run_id` keys.
4. **Capability gap**: Cross-chapter continuity (project-wide consistency check) is awkward in n8n; natural in Python.
5. **Vendor independence**: Python runs anywhere. n8n workflows are n8n-specific.
6. **Productization**: A coherent Python API can be sold as a standalone B2B product (see [[productization]]).
7. **Hard gate**: User has stated scaling must be solved before paid-seat rollout (Sprint 9). Either path solves scaling, but Python supports the wider growth roadmap.

**What stays in n8n: NOTHING (active path).**

Updated 2026-05-10: per user direction, the hub also migrates. **All active production traffic flows through Python**; n8n hosts only V1 (Orig) workflows for legacy customers.

- **Hub** (`PROD - The Author Agent`) — migrates to Python. See [[hub-architecture]].
- **Reset Eve Greeting** — folded into notify module as a delayed background job.
- **Approval Token Generator** — folded into approval module.
- **All 22 tool workflows** — migrate per [[service-decomposition]].
- **Newsletter cluster** — migrates to Python (newsletter module).
- **V1 (Orig) workflows** — stay in n8n indefinitely per CLAUDE.md baseline protection. Used only by V1 customers on the baseline Eve agent.

Production runtime path (post-migration): Eve / ChatDrawer / B2B → Cloudflare LB → Python api-svc (hub + endpoints) → Python workers → Supabase. **Zero n8n in the active path.**

## Dual-product positioning

This rewrite enables two products from one codebase:

### Product 1: Writers Workbench (existing)

The current SaaS app at `writersworkbench-production.up.railway.app`. After rewrite:
- Frontend unchanged.
- Workbench Express server unchanged (still proxies chat, handles auth, etc.).
- n8n hub unchanged (just calls HTTP APIs instead of `executeWorkflow`).
- Heavy lifting moves to `author-agent-api`.

### Product 2: Author Agent API (NEW)

Standalone B2B backend. Other writing-app developers (or large customers) buy API access. They write their own front-end / agent / orchestration; we provide:
- Chapter writing
- Brainstorm
- Research
- QA + drift scanning
- Story bible management
- Cover art generation
- Multi-chapter continuity

Pricing: per-token usage with markup, plus tier-based subscription for SLA + features. See [[productization]].

The same code serves both. Internal callers (hub, Workbench server) use `/internal/*` endpoints with shared-secret auth. External customers use `/v1/*` endpoints with API-key auth + multi-tenancy.

## Deployment: service groups behind a load balancer

Full visual topology: see [[scaling-architecture]].

The entire backend is one Python codebase (modular monolith). It deploys as **service groups** — different Docker images with overlapping but distinct module sets, optimized for different scaling profiles.

```
                 ┌──────────────────────────────┐
                 │ Cloudflare Load Balancer     │
                 │ (sticky on chapter_run_id)   │
                 └─────────────┬────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
  │ heavy-group  │      │ light-group  │      │ cron-group   │
  │ Docker image │      │ Docker image │      │ Docker image │
  │              │      │              │      │              │
  │ • chapter    │      │ • library    │      │ • scheduler  │
  │ • brainstorm │      │ • retrieve   │      │ • newsletter-│
  │ • research   │      │ • storybible │      │   cron       │
  │ • media      │      │ • approval   │      │ • trial-cron │
  │ • qa         │      │ • notify     │      │              │
  │              │      │              │      │              │
  │ N=3-10 reps  │      │ N=2-3 reps   │      │ N=1 rep      │
  │ scaled by    │      │ scaled by    │      │ singleton    │
  │ chapter load │      │ CRUD volume  │      │              │
  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
         │                     │                      │
         └─────────────────────┼──────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
        ┌──────────────────┐    ┌────────────────────┐
        │ Supabase         │    │ Redis (BullMQ +    │
        │ (PROD/DEV/Test)  │    │  rate limit +      │
        └──────────────────┘    │  token budget)     │
                                └────────────────────┘
```

**Three service groups** (revised 2026-05-10 — split api from workers):

| Group | Docker image | Process model | Modules | Replicas | Scaling driver |
|---|---|---|---|---|---|
| **api-svc** | `author-agent-backend:api` | uvicorn (HTTP server) | hub (agent loop), all `/v1/*` routes, all `/internal/*` routes, sync-op handlers (library, story_bible, approval, notify) | 3-10 | User request rate; p95 latency |
| **worker-heavy** | `author-agent-backend:worker` | arq worker (heavy-ops queue) | chapter, brainstorm, research, media, qa, cross-chapter | 3-10 | heavy-ops queue depth |
| **worker-light** | `author-agent-backend:worker` | arq worker (medium-ops + background-ops queues) | medium-ops dispatched modules + background tasks (webhook delivery, eve_reset_greeting) | 2-4 | medium-ops queue depth |
| **worker-cron** | `author-agent-backend:worker` | arq worker (cron schedules + background-ops) | scheduler, newsletter ingestion cron, cadence cron | 1-2 (leader-elected) | manual |

**Same codebase, two Dockerfiles** (`api` + `worker`), service-group selected via env var `SERVICE_ROLE` at boot.

Sticky load balancer pins requests with `chapter_run_id` cookie/header to the same api-svc instance for the duration of an SSE stream. Other requests round-robin.

## API surface

Three layers of HTTP endpoints:

### `/v1/*` — Public B2B API

API-key authenticated. Multi-tenant. Rate-limited. Versioned.

```
POST /v1/chapters/write
POST /v1/chapters/qa
POST /v1/chapters/scan-drift
POST /v1/chapters/rewrite-with-research
POST /v1/projects/{id}/cross-chapter-continuity
POST /v1/brainstorm/story
POST /v1/brainstorm/chapter
POST /v1/research
POST /v1/media/cover-art
POST /v1/media/social-posts
POST /v1/library/{action}
GET  /v1/library/projects/{id}/chapters
... (full surface in [[api-contracts]])
```

Used by external customers. Documented via OpenAPI auto-spec at `/docs`.

### `/internal/*` — Hub + Workbench callers

Shared-secret auth (`X-Service-Secret`). Same business logic; identity comes from request payload (`user_id`) instead of an API key. No multi-tenancy logic — internal trust.

```
POST /internal/chapters/write
POST /internal/chapters/qa
... (same operations, internal auth)
```

### `/admin/*` — Operational endpoints

Admin-token auth. Health, queue depth, cache invalidation, prompt reload, etc.

```
GET  /admin/health
GET  /admin/queues
POST /admin/reload-prompts
POST /admin/flush-cache
```

## Why one codebase, three groups

**Alternatives considered:**

1. **One mega-service**: simpler ops; but a CPU spike in chapter writing impacts CRUD endpoints. Bad isolation.
2. **One service per workflow** (true microservices): excellent isolation; but ~20 services × deploy/observe/secret-rotate is ops nightmare for our scale.
3. **Three service groups, one codebase**: ✓ chosen. Good isolation between heavy/light/cron. One codebase = single source of truth, single test suite, shared utilities. Deploy artifacts diverge only in entrypoint.

**Failure isolation properties:**

- Heavy-group thrashing → light-group keeps serving CRUD.
- Cron-group deadlock → user-facing requests unaffected.
- Light-group DB connection exhaustion → heavy-group continues; LB routes around it.

**Scale-independently properties:**

- Chapter rush → scale heavy-group to 10 replicas; light-group stays at 2.
- Library import surge → scale light-group to 6; heavy-group unchanged.
- Off-peak → scale heavy down to 2; cron stays singleton.

## What changes for the user

### For Writers Workbench users

Nothing visible. Behavior should be byte-equivalent (validated via [[sprint-15-testbed|testbed]] Q/A bake-off). Latency ~15-25% better due to engine-overhead reclaim.

### For internal n8n hub

The hub's `ai_tool` definitions change from `executeWorkflow` references to HTTP Request nodes. Tool names + parameters unchanged. System prompt unchanged. Agent's behavior identical.

### For external (B2B) customers

NEW. They sign up at `api.authoragent.dev` (or similar), get an API key, call `/v1/chapters/write` directly. Their app handles UI; we handle the AI.

## Decision gates

- [x] **Scope decision**: full backend rewrite — INCLUDING the hub. n8n eliminated from active path. Confirmed 2026-05-10.
- [x] ~~**Modular monolith vs microservices**: modular monolith with service-group deployment.~~ **SUPERSEDED 2026-05-29 → true per-step microservices on a shared engine library. See [[engine-framework]].**
- [x] **api-svc vs worker split**: separate roles — api receives HTTP, worker consumes queue.
- [x] **Internal vs external API split**: yes, two surfaces.
- [x] **Hub LLM choice**: Claude Haiku 4.5 default; Gemini 2.5 Flash configurable. See [[hub-architecture]].
- [x] **Queue framework**: arq (asyncio-native Redis queue).
- [x] **Hosting**: Railway Phase 1; revisit at 1000+ daily users.
- [x] ~~**Service group count**: 3 (api-svc, worker-heavy, worker-light, worker-cron — with worker-cron as a 4th if singleton enforcement needs it).~~ **SUPERSEDED 2026-05-29 → per-step services (one image per step) on a shared library; see [[engine-framework]] §2-§4.**
- [x] **Background tasks**: arq via shared Redis (Python side); BullMQ on Workbench Express stays until that migrates too.
- [x] **Prompt storage**: hybrid — code default + `app_config_v2.prompts` override; hot-reload via `/admin/reload-prompts`.
- [x] **Service-to-service auth**: shared secret (`X-Service-Secret`).
- [x] **External auth**: API keys (Argon2id hashed).
- [x] **API versioning**: `/v1/*`; `/v2/*` introduced when breaking changes needed.

## Sequencing

The full migration is a multi-quarter program. See [[python-migration-roadmap]] for the phased sprint plan (Sprints 16-26).

**Critical gate**: paid-seat launch ([[planned-sprints|Sprint 9 Stripe]]) cannot ship to PROD until at least Phase 1 (chapter writer) is migrated and validated. Earliest paid-seat date: **week ~14-16 from sprint start.**

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Port misses subtle n8n behavior | [[sprint-15-testbed]] quality bake-off must score ≥ 0.95 of baseline before cutover |
| Multi-tenancy bugs leak customer data | Mandatory tenant_id check in every query; integration tests with two synthetic tenants |
| API breaking changes mid-flight customers | Strict semantic versioning; deprecate via `Sunset:` header per RFC 8594 |
| LLM library version drift | Pin Anthropic SDK; integration test on every release |
| Hub-to-service auth secret leak | Rotate quarterly; per-environment values |
| Open-source competitors copy the API | Defensible via prompt engineering quality + customer data + integration depth, not API surface |
| Productization distracts from core Workbench product | Phase the rollout; B2B customers come after internal Phase complete |

## Cross-system implications

| System | Change |
|---|---|
| [[chapter-writer-architecture]] | Becomes legacy reference; new architecture is the Python service. Major rewrite of that page after migration. |
| [[workflows/_index|Workflows]] | ~22 of 24 PROD workflows decommission post-migration. Hub + a few stay. [[workflow-tiers]] gets a deprecation status column. |
| [[deployment-railway|Railway]] | Three new services (heavy/light/cron) per environment. Existing Workbench services unchanged. |
| [[security-model]] | New API-key auth + tenant isolation. Existing JWT auth for Workbench unchanged. |
| [[base-tables]] | New tables: `api_keys_v2`, `tenants_v2`, `api_usage_v2`. All meta tables; migrations 018+ governance-compliant. |
| [[testing/_index|Testing]] | New pytest suite for backend. Integrated with [[sprint-15-testbed|testbed]]. |
| [[ci-pipeline]] | Add Python lint + test + Docker build job. |
| [[runbooks]] | New runbooks: deploy backend, rotate API keys, scale service groups, customer onboard. |
| [[planned-sprints]] | Sprints 16-18 reframe as Phases A/B of migration. New Sprints 19-26 for full backend + productization. |

## Why this is the right call

The user's framing was correct:
> "could we build this as a microservice backend in python running on docker connecting through via an API. ... we could sell this backend separately for people who are writing their own writers application."

Two-for-one. Solves scaling AND opens a B2B revenue stream. The cost of the rewrite (~12-14 weeks of engineering) is comparable to the cost of the n8n multi-instance scaling work (~12 weeks) but yields a productizable asset, not just a scaled deployment.

The trade-off — losing n8n's visual debugging + rapid prompt iteration — is real but mitigable (DB-stored prompts + standard Python observability tooling + thorough Q/A from the testbed).

**Recommendation: proceed with the rewrite.** Begin with [[sprint-15-testbed]] (already planned, validates LLM strategy independent of architecture choice) and proceed into [[python-migration-roadmap|the migration roadmap]] starting Sprint 16.
