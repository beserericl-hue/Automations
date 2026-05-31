---
name: Writer Engine framework — per-step microservices (the product)
description: Program-level architecture for the salable Writer Engine — per-step Python microservices on a shared engine library, combining the newsletter + write-workshop rewrites into one scalable framework, sequenced ahead of Stripe/B2B. Revises the master-plan modular-monolith decision.
type: concept
tags: [architecture, python-backend, engine, microservices, framework, product, scalability, gate-3]
last_reviewed: 2026-05-29
---

# Writer Engine framework — per-step microservices (the product)

> **Status: DESIGN / DIRECTION (locked by user 2026-05-29).** This page sets the program-level architecture that
> [[newsletter-microservices]] is the first concrete instance of. It **revises** two [[master-plan]] decisions:
> (a) *modular monolith → true per-step microservices*; (b) *backend-as-supporting-infra → the engine **is** the
> product*. It also **re-sequences** the work: build this **framework first** (write-workshop + newsletter together),
> **ahead of Stripe / B2B billing**, because it is the major architectural change that changes the nature of the
> product.

## 1. Thesis

The Python backend is not just a faster way to run the n8n tools — **it is the product**. It is a **salable engine
library**: the AI writing engine that other entrepreneurs license to build their own writing applications on. The
Writers Workbench becomes the **reference application** that runs on the same engine.

Three consequences drive the architecture:

1. **Composable per-step microservices.** The engine is a set of small, independently deployable services — one per
   pipeline step — so a customer can adopt the whole pipeline *or* license individual capabilities (just the story
   picker, just the segment writer, just the chapter writer). Composability is a product feature, not just an
   ops choice.
2. **A shared engine library is the salable core.** All services import one versioned Python package (`writer_engine`)
   that holds the LLM clients (with prompt caching), the prompt store, the Pydantic step schemas/contracts, the
   data/queue/storage adapters, and the orchestration primitives. The library is what we sell/ship; the services are
   thin deployables on top of it.
3. **Scalability is a hard requirement** (per user): the engine must scale to the customer-bandwidth goals. Per-step
   services that scale independently behind a queue are the path to that (see §4).

## 2. Architecture — four layers

```
        ┌──────────────────────────── API gateway layer ────────────────────────────┐
        │  /internal/* (X-Service-Secret: Workbench + n8n hub)   /v1/* (API-key, B2B) │
        └───────────────┬───────────────────────────────────────────────┬────────────┘
                        │                                                 │
                ┌───────▼────────┐  orchestrators (saga coordinators)  ┌──▼──────────────┐
                │ chapter-orch   │  drive durable state machines,      │ newsletter-orch │
                │ brainstorm-orch│  invoke step services, own HITL gates│ (see newsletter-│
                │ research-orch …│                                     │  microservices) │
                └───────┬────────┘                                     └──┬──────────────┘
                        │                                                 │
   ┌────────────────────▼─────────────────── step services ──────────────▼─────────────────────┐
   │ writing-engine steps:                          newsletter steps:                            │
   │ context · subchapter-write · continuity-merge  gather · pick · subject · scrape · segment    │
   │ extract-bible · qa · drift-scan · genre-eval   image · assemble · render · persist · deliver │
   │ brainstorm · edit-outline · research(perplexity)                                            │
   │ media(cover-art/social/scrape) · library · story-bible · approval · notify                   │
   └──────────────────────────────────── shared engine library ────────────────────────────────┘
   │  writer_engine:  llm_clients(prompt-cache, multi-LLM) · prompt_store · schemas/step-contract │
   │                  supabase_adapter · redis/arq · storage · postal · state_machine · telemetry │
   └────────────────────────────────────────────┬──────────────────────────────────────────────┘
                       ┌─────────────────────────┼─────────────────────────┐
                       ▼                         ▼                         ▼
                 Supabase (state)         Redis (arq + budget +      LLM providers
                 + Storage                 progress pub/sub)         (Anthropic / Gemini / Perplexity)
```

- **Engine library** (`writer_engine`) — the salable core. Versioned; published internally (and externally as the
  licensable SDK). Every service depends on it; nothing else is duplicated.
- **Step services** — one tiny FastAPI app per step, uniform contract `POST /run {execution_id}` + `/admin/health`
  + `/metrics`. Stateless. Each its own Docker image, independently scalable.
- **Orchestrators** — saga coordinators (one per long-running pipeline: chapter, newsletter, research, …). Drive the
  durable state machine, invoke step services (HTTP or arq), own the HITL approval gates + revision loops.
- **API gateway** — `/internal/*` (shared-secret, for the Workbench server + the n8n hub during migration) and
  `/v1/*` (API-key, multi-tenant, for B2B). Same business logic; auth + tenancy differ (per [[api-contracts]]).

## 3. Unified service catalog (newsletter + write workshop combined)

Per user direction the **newsletter** rewrite and the **write-workshop** rewrite are **one framework**, not separate
efforts. Every n8n tool (from [[service-decomposition]]) becomes one or more step services on the shared library:

| Domain | Step services (each its own image) | Replaces n8n |
|---|---|---|
| **Chapter / long-form** | `context`, `subchapter-write`, `continuity-merge`, `extract-bible`, `qa`, `drift-scan`, `genre-eval`, `format-kindle`, `cross-chapter` | Worker/Tool - Write Chapter + blog/short-story/newsletter-content variants, QA, drift, genre, build-context |
| **Ideation / research** | `brainstorm`, `edit-outline`, `research` (Perplexity + synth) | Brainstorm Story/Chapter, Edit Outline, Research Pipeline |
| **Media** | `cover-art`, `social-posts`, `scrape-url` | Cover Art, Repurpose Social, Scrape URL |
| **Content lifecycle** | `library`, `story-bible`, `approval`, `notify` | Manage/Retrieve Library, Story Bible, Approval Token, Eve Callback |
| **Newsletter** | `gather`, `pick`, `subject`, `scrape`, `segment`, `image`, `assemble`, `render`, `persist`, `deliver` (+ `newsletter-orch`) | Content - Newsletter Agent V2 (see [[newsletter-microservices]]) |
| **Scheduling** | `cadence-cron`, `ingestion-cron`, `scheduled-publisher` | Newsletter crons, Scheduled Publisher |

The **hub** (`PROD - The Author Agent`) stays as the agent/routing layer for now (its Python port is the later
[[hub-architecture]] phase); during migration it routes per-tool to these services via the `app_config` flag.

## 4. Scalability — to the customer-bandwidth goals

Per-step microservices are the scalability mechanism (this is why the granularity decision matters):

- **Independent horizontal scaling per step.** Each service has its own replica count keyed to its own load. During a
  chapter write, `subchapter-write` fans out to N replicas; during a newsletter run, `segment-svc`/`image-svc` fan
  out per story; CRUD-ish steps (`library`, `gather`) stay small. No step's spike starves another (the isolation the
  [[master-plan]] wanted, achieved per-step instead of per-group).
- **Queue-driven concurrency** (arq on Redis) with an **Anthropic token-budget gatekeeper** + per-key rate limiting,
  so we saturate our own compute without breaching provider limits. Backpressure via queue depth → autoscale.
- **Stateless services + durable state** (Supabase rows + Redis) → replicas add **linearly**; any worker can pick up
  any step; crash-safe via **idempotency keys** (`*_run_id`, `(execution_id, step)`).
- **Multi-LLM strategy** (Claude / Gemini / Perplexity, per-step configurable) spreads load across providers and
  raises the effective ceiling — the lever behind the **~100 → ~1500+ daily-user** target and the cost curve in
  [[design-feasibility]] / [[scaling-architecture]] (≈75% cheaper at 1000 users vs n8n).
- **Autoscaling triggers** per service (queue depth, p95 latency); cron/orchestrator services stay singleton/leader-
  elected. Targets + capacity math are tracked in [[scaling-architecture]]; this framework must hit the
  customer-bandwidth goals defined there before B2B GA.
- **Stateless gateway + sticky only for SSE** (pin an execution's SSE stream to one gateway replica; everything else
  round-robins).

## 5. The salable engine library (productization)

- **Dual-use, one codebase.** Internal callers (Workbench server, n8n hub) hit `/internal/*`; external customers hit
  `/v1/*` (API-key, multi-tenant). Same engine.
- **Composable licensing.** Because steps are discrete services + the core is a library, we can sell: the **hosted
  API** (per-token + tier subscription), the **engine library/SDK** (self-host), or **individual capabilities**
  (e.g. "newsletter engine" or "chapter writer" alone). This is the "engine behind writing apps" framing.
- **Packaging.** Monorepo → shared base image + per-service images (build matrix) + `docker compose` for the full set
  + (later) a Helm chart for customer self-host. SDKs (Python/TS) generated from the OpenAPI of `/v1/*` (per
  [[productization]]).
- **Defensibility** = prompt/quality engineering + data + integration depth, not the API surface (see [[master-plan]]
  risk table).

## 6. Re-sequencing — framework first, ahead of Stripe

This framework is the **headline initiative** and runs **before** Stripe/B2B billing, because it changes the nature
of the product and everything else (paid seats, B2B) sits on top of it. Reframing of [[python-migration-roadmap]]:

| Stage | Was (roadmap) | Now (framework-first) |
|---|---|---|
| **F0 — Engine foundation** | (implicit in S16) | Build `writer_engine` library + step-service template + orchestrator pattern + gateway + CI/build-matrix + `docker compose` + [[scaling-architecture]] harness. **Prerequisite for everything.** |
| **F1 — Write-workshop step services** | Sprints 16-19 | Chapter/brainstorm/research/media/library/story-bible/approval/notify as per-step services. |
| **F2 — Newsletter step services** | Sprint 20 | The [[newsletter-microservices]] set (combined with F1 — same framework, same sprint train). |
| **F3 — Scale + cutover + n8n removal** | S17-S22 cutovers | Per-step shadow → cutover; load-test to bandwidth goals; archive replaced n8n workflows. |
| **F4 — Hub port** | Sprint 22 | Hub → Python (optional/last of internal). |
| **Stripe / paid seats (Sprint 9)** | gated behind Phase A | **After** the engine framework is proven on PROD (unchanged: still gated, now explicitly behind F1-F3). |
| **B2B productization (Phase F)** | Sprints 23-27 | Built **on** the now-proven engine (API keys, billing, SDKs, GA). |

[[sprint-15-testbed]] remains the prerequisite Q/A engine. The combined F1+F2 train replaces the separate
Sprint 16-20 framing; [[planned-sprints]] + [[work-ordering-2026-05]] to be updated to this order.

## 7. Reconciliation with the master plan

This **supersedes** these [[master-plan]] decision gates: *"Modular monolith vs microservices → modular monolith"*
and *"Service group count → 3"*. New decision: **true per-step microservices** on a shared library. The master plan's
stated objection was ops cost of ~20 services; the **mitigations** (monorepo + shared base image + build matrix +
uniform health/metrics/auth from the library + IaC-generated manifests + one versioned release) make it manageable,
and the **upside** (independent scaling + composable/sellable services) directly serves the scalability + product
goals the master plan also wanted. The dual-product positioning, `/internal` vs `/v1` split, arq queue, prompt
store, and shared-secret/API-key auth from the master plan all **carry forward unchanged**.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Many services = ops/deploy sprawl | Monorepo + base image + build matrix + IaC manifests + uniform library-provided ops; one versioned release of the set |
| Inter-service latency from fine granularity | Co-locate hot chains; arq in-process fast path; orchestrator batches; measure in [[scaling-architecture]] harness |
| Distributed failure modes | Durable state machine + idempotency keys + per-step retries/DLQ; saga compensation in orchestrators |
| Quality parity vs n8n | [[sprint-15-testbed]] bake-off ≥0.95 baseline per step before cutover; verbatim prompt port |
| Provider rate limits under scale | Token-budget gatekeeper + multi-LLM + per-key throttling |
| Framework-first delays revenue (Stripe) | Stripe was already gated; framework unblocks both scaling *and* B2B revenue, so it is the higher-leverage path |

See also: [[master-plan]] · [[service-decomposition]] · [[newsletter-microservices]] · [[api-contracts]] ·
[[queueing-architecture]] · [[scaling-architecture]] · [[design-feasibility]] · [[python-migration-roadmap]] ·
[[engine-api-system-tests]] · [[productization]].
