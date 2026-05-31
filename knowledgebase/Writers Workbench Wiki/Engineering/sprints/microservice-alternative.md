---
name: Python microservice alternative for chapter writing (SUPERSEDED)
description: Original chapter-writer-only microservice proposal. Superseded by the broader full-backend rewrite plan in [[architecture/python-backend/master-plan]] + [[python-migration-roadmap]]. Kept for historical context.
type: concept
tags: [sprints, architecture-decision, microservice, python, scalability, superseded]
last_reviewed: 2026-05-09
---

> **SUPERSEDED 2026-05-09**: this page proposed migrating only the chapter writer to Python. After review, the user expanded the scope: **full backend rewrite** with productization (sellable B2B API). See [[architecture/python-backend/master-plan]] for the current architectural direction and [[python-migration-roadmap]] for the multi-sprint plan.
>
> Content below preserved for context. The chapter-writer-specific arguments still hold; they're now embedded in the broader rewrite plan.

# Python microservice alternative (chapter-writer-only — historical)

The user has flagged a hard gate: **scalability must be solved before users can purchase seats** (i.e. before [[planned-sprints|Sprint 9 (Stripe)]] ships to PROD). The current plan in [[design-feasibility]] + [[sprint-15-testbed]] assumes n8n multi-instance behind a load balancer is the answer. This page evaluates a different answer: **rebuild chapter writing as a Python microservice**, keeping the hub in n8n.

## The core argument

The chapter writer is doing one thing: orchestrating a sequence of LLM calls + DB reads/writes. n8n's value-add (visual orchestration, execution history, built-in connectors) is real — but at runtime, every node call carries ~50-100ms of n8n engine overhead. For a 36-node chapter writer, that's ~3.6 seconds of pure n8n overhead per chapter. Over thousands of chapters/day at scale, this matters.

A Python service doing the same work has ~0.1-0.5s of HTTP/framework overhead. Same LLM calls, same Anthropic latency, but ~3 seconds saved per chapter. At 100 chapters/hour, that's 5 minutes/hour of compute reclaimed.

That's the **scaling story.** But scaling is only the headline — there's also cost, ops complexity, idempotency, and lock-in. Each evaluated below.

## Architecture

### Service decomposition

```
chapter-writer-service (Docker)
├── POST /write-chapter           # main entry — full chapter pipeline
├── POST /write-sub-chapter       # internal but parallelizable
├── POST /merge-continuity        # post-processing
├── POST /extract-bible           # post-processing
├── POST /qa-chapter              # quality scoring
├── POST /rewrite-chapter         # research-backed rewrite
├── POST /cross-chapter-continuity # NEW: project-wide consistency check
└── GET  /health
```

Each endpoint:
1. Loads context from Supabase (service-role).
2. Calls Anthropic (Sonnet/Haiku per request param).
3. Returns result + writes to Supabase.

**Stateless.** No in-process state between requests. Trivially horizontally scalable.

### What stays in n8n vs what moves

| Layer | Disposition | Rationale |
|---|---|---|
| Hub: `PROD - The Author Agent` | **Stay in n8n** | Gemini Agent + tool selection benefits from visual + iterative dev. Low compute cost. Routing is what n8n is genuinely good at. |
| `Worker - Write Chapter` | **Move to Python** | Heavy compute, scaling-critical, idempotency-sensitive. The 36-node bottleneck. |
| `Tool - Rewrite Chapter with Research` | **Move to Python** | Same pattern as write_chapter. Scaling-critical. |
| `Tool - QA Chapter` | **Move to Python** | LLM-heavy. Scales with chapter volume. |
| `Sub - Research Pipeline` | **Move to Python** | Perplexity + Claude orchestration. Scales with chapter volume. |
| `Sub - Build Chapter Context` | **Move to Python** | Called by Write Chapter; co-locate. |
| `Tool - Brainstorm Story` | **Stay in n8n** | Low volume (~5% of chapter volume). Quality of UX > scaling. |
| `Tool - Brainstorm Chapter` | **Stay in n8n** | Same. |
| `Tool - Edit Outline` | **Stay in n8n** | Lightweight. |
| `Tool - Generate Cover Art` | **Stay in n8n** | KIE.AI / DALL-E orchestration; rare path. |
| `Tool - Repurpose to Social Posts` | **Stay in n8n** | Multi-platform fan-out; native to n8n. |
| `Sub - Manage Library` | **Stay in n8n** | Simple CRUD. |
| `Sub - Retrieve Content` | **Stay in n8n** | Sync, low cost. |
| `Sub - Manage Story Bible` | **Stay in n8n** | Simple CRUD. |
| `Sub - Eve Knowledge Callback` | **Stay in n8n** | Web/phone routing logic; low volume. |
| `Cron: Scheduled Publisher` | **Stay in n8n** | Periodic, simple. |
| Newsletter cluster | **Stay in n8n** | Low volume + complex data flow. |

**Net: ~5 of 24 PROD workflows migrate. The remaining 19 stay.**

### How the hub calls the microservice

n8n's `ai_tool` for `write_chapter` becomes an HTTP Request node:

```yaml
type: n8n-nodes-base.httpRequest
parameters:
  url: =https://chapter-writer-service.up.railway.app/write-chapter
  method: POST
  authentication: httpHeaderAuth
  contentType: application/json
  body:
    user_id: ={{$fromAI('user_id', '...', 'string')}}
    project_id: ={{$fromAI('project_id', '...', 'string')}}
    chapter_number: ={{$fromAI('chapter_number', '...', 'number')}}
    llm_strategy: ={{$fromAI('llm_strategy', '...', 'string', 'tier-default')}}
  timeout: 1200000   # 20 min
credentials:
  httpHeaderAuth: <Workbench Service Secret>
```

Hub system prompt unchanged — agent still calls a tool named `write_chapter`. Underneath: HTTP call to Python service instead of `executeWorkflow` to a sub-workflow.

### Service code shape

```python
# chapter_writer/main.py
from fastapi import FastAPI, BackgroundTasks
from contextlib import asynccontextmanager
import anthropic
from supabase import create_client

app = FastAPI()
anthropic_client = anthropic.AsyncAnthropic()
supabase = create_client(SUPABASE_URL, SERVICE_ROLE_KEY)

@app.post("/write-chapter")
async def write_chapter(req: WriteChapterRequest, bg: BackgroundTasks):
    # 1. Load context (project, outline, characters, prior chapters)
    ctx = await load_chapter_context(req.project_id, req.chapter_number)

    # 2. Build sub-chapter prompts with LOCKED CHARACTER ROSTER
    prompts = build_sub_chapter_prompts(ctx, req.llm_strategy)

    # 3. Parallel sub-chapter writes (asyncio.gather)
    sub_chapters = await asyncio.gather(*[
        anthropic_client.messages.create(model=p.model, ...)
        for p in prompts
    ])

    # 4. Continuity merge
    merged = await merge_continuity(sub_chapters, ctx)

    # 5. Extract bible
    bible_entries = await extract_bible(merged, ctx.existing_bible)

    # 6. Persist (idempotent — chapter_run_id keyed)
    await persist_chapter(req, merged, bible_entries)

    # 7. Background: cover art, email, telemetry
    bg.add_task(generate_cover_art, req)
    bg.add_task(send_completion_email, req)
    bg.add_task(track_token_usage, req)

    return {"chapter_id": ..., "status": "complete"}
```

**~800-1500 LOC** for the full chapter writer. ~500 LOC for Q/A engine. ~300 LOC for cross-chapter continuity. Standard FastAPI + asyncio.

### Idempotency

Every request carries `chapter_run_id` (UUID). External writes upsert keyed on `(content_id, chapter_run_id)`. Re-runs don't double-write. Crashed mid-execution → caller retries with same `chapter_run_id` → service detects duplicate, returns prior result OR resumes from checkpoint.

This is **dramatically easier** in HTTP services than in n8n workflows. Mid-workflow-execution death is non-trivial in n8n; mid-HTTP-request death is just a normal retry.

### Cross-chapter continuity (NEW capability)

Currently n8n has no concept of "rewrite chapter 4 to fix the contradiction with chapter 7." Adding this in n8n = 50+ nodes, slow, hard. In Python:

```python
@app.post("/cross-chapter-continuity")
async def cross_chapter_continuity(req: ContinuityCheckRequest):
    chapters = await load_all_chapters(req.project_id)
    contradictions = await detect_contradictions(chapters)
    if req.auto_fix:
        rewrites = await generate_rewrites(contradictions, chapters)
        return {"contradictions": contradictions, "rewrites": rewrites}
    return {"contradictions": contradictions}
```

~200 LOC. The user explicitly mentioned this as a goal. n8n approach makes this hard; microservice makes this natural.

## Scalability comparison

Real numbers, not hand-waving.

| Dimension | n8n multi-instance | Python microservice |
|---|---|---|
| Per-chapter engine overhead | ~3.6s (36 nodes × ~100ms) | ~0.3s (HTTP + framework) |
| Memory per instance | ~1-2 GB (n8n + Postgres + workflows in memory) | ~200-500 MB (Python + libs) |
| Cold start | 30-60s (n8n boot + workflow load) | 2-5s (Python import + bind) |
| Scaling unit | n8n container + Postgres + workflow deploy | Stateless Docker container |
| Deploy time | Workflow PUT + activate cycle per instance | `docker push` + container restart |
| 50-instance feasibility | Each needs Postgres + state cleanup; complex | Trivial — same image, N replicas |
| Throughput per instance (5-min chapter) | ~12 chapters/hour | ~12 chapters/hour (Anthropic-bound, not engine-bound) |
| Throughput per instance with overhead reduction | n/a | **~14 chapters/hour** (3s saved × 50/hr = 2.5 min reclaimed) |
| Concurrency at fixed cost ceiling | Limited by n8n engine + DB pool | Limited by Anthropic rate only |

**At equal cost, Python supports ~15-25% more throughput** because we reclaim engine overhead. The gain compounds at high concurrency.

The Anthropic per-minute output token budget remains the ultimate bottleneck — that doesn't change. Both architectures are gated by it.

## Cost comparison (monthly infrastructure)

For 100 daily users / ~50 chapters/hour peak / 5-instance deployment:

| Item | n8n approach | Python approach |
|---|---|---|
| Compute instances | 5 × $15/mo = $75 | 5 × $7/mo = $35 |
| Per-instance Postgres (n8n metadata) | 5 × $5/mo = $25 | $0 (stateless) |
| Shared Redis (BullMQ + token budget) | $10 | $10 |
| Load balancer | $20 (Cloudflare LB) | $20 |
| Workbench Express | $15 | $15 |
| **Subtotal** | **$145/mo** | **$80/mo** |
| **Δ** | | **−45% (saves $65/mo)** |

At 50 instances (1000 daily users):
- n8n: $1,250/mo + $250 Postgres + $30 LB + $15 Workbench = **$1,545/mo**
- Python: $350/mo + $0 + $30 + $15 = **$395/mo** — **~75% cheaper**

The cost gap **widens at scale.** Python wins decisively past ~10 instances.

## Operational comparison

| Concern | n8n | Python |
|---|---|---|
| Visual debugging | Excellent — execution history per node | Logs + Sentry + APM (Datadog/Honeycomb) |
| Prompt iteration | Click-to-edit in UI; no deploy | Code change + redeploy; or DB-stored prompts with hot-reload |
| Credential rotation | Built-in n8n credential manager | Env vars per service; rotate via Railway dashboard |
| Failure isolation | n8n workflow execution survives some crashes via resume | Worker dies → supervisor (Railway) restarts |
| Idempotency | Hard (workflow-execution mid-state) | Easy (HTTP request semantics + chapter_run_id) |
| Schema/dependency changes | Edit workflow + repromote to N instances + Publish in UI | Code change + Docker rebuild |
| Cross-tier consistency | Promotion script substitutes URLs/keys | Same Docker image; env-var-driven config |
| Observability | n8n UI + execution log | Standard (logs, metrics, traces) |
| Onboarding new dev | Learn n8n + node types + expression syntax | Standard Python (industry-standard) |
| Tooling for tests | Limited (n8n has no native test framework) | Pytest, async fixtures, mocks — full ecosystem |
| Hot-fix mid-incident | Edit workflow in UI + Publish | Code change + redeploy (~5 min) |
| Vendor lock-in | n8n-specific workflow JSON; rewrite to leave | Standard Python; runs anywhere |

**Operational verdict**: Python is more standard but loses n8n's visual debugging. For a team with strong Python fluency, this trade is favorable.

## What we lose by leaving n8n for chapter writing

Honest list, no minimization:

1. **Visual execution history.** When a chapter fails mid-stream, n8n shows you the exact node + data at failure. Python = logs + maybe a trace span. Replicable but more work to set up.
2. **Rapid prompt iteration.** Editing a Code node prompt in n8n is a click + Publish. Python = code + redeploy. Mitigation: store prompts in `app_config_v2` JSONB or a `prompts/*.txt` directory loaded at startup with file-watch reload.
3. **Built-in retry.** n8n has retry per node. Python needs explicit retry decorators (already a pattern in BullMQ workers).
4. **Sub-workflow orchestration.** `executeWorkflow` is one click in n8n. Python = HTTP call between services (slightly more code, much more flexible).
5. **For non-engineers.** n8n is editable by less-technical staff. Python is engineer-only.

These are real costs. The chapter-writer code becomes engineering-managed, not ops-editable. That's the price of scaling.

## Migration plan

### Phase A: Build the service (5-7 weeks)

Sprint A1 — Foundation (8 pts):
- Provision `chapter-writer-service` Railway service.
- FastAPI skeleton, `/health` endpoint, Supabase client wired.
- Docker build pipeline (Railway-native or GitHub Actions → Railway).
- Shared-secret auth middleware (`X-Service-Secret`).

Sprint A2 — Port `Worker - Write Chapter` (13 pts):
- Port `Build Chapter Context` (LOCKED CHARACTER ROSTER builder).
- Port sub-chapter prompt builder + parallel async LLM calls.
- Port continuity merge (chainLlm equivalent).
- Port extract_bible (defensive JSON parse).
- Port DB writes (idempotent via chapter_run_id).
- Port email + cover art as background tasks.

Sprint A3 — Port Q/A engine (8 pts):
- Port rule-based checks.
- Port Sonnet-as-judge for chapter quality.
- Port research pipeline (Perplexity + Claude derive_questions).

Sprint A4 — Cross-chapter continuity (NEW capability) (5 pts):
- Load all chapters in project.
- LLM-based contradiction detection.
- Optional auto-rewrite endpoint.

Sprint A5 — Hub integration (5 pts):
- Update DEV hub `ai_tool` for `write_chapter` from `executeWorkflow` to HTTP Request.
- Update DEV hub for `rewrite_chapter_with_research`.
- Update DEV hub for `qa_chapter`.
- DEV smoke test: end-to-end chapter via HTTP path.

### Phase B: Validate (2-3 weeks)

Sprint B1 — Quality bake-off via testbed (5 pts):
- Use [[sprint-15-testbed|Sprint 15 testbed]] infrastructure.
- 5th LLM variant: `TEST - Worker - Write Chapter (Python)` calls the new service.
- Score 50 chapters via Q/A engine.
- Compare dimensional scores: Python service vs n8n baseline (Sonnet variant).
- **Acceptance**: Python service scores ≥ 0.95 of n8n baseline on every dimension. (Should be ≥1.0 — same prompts, same LLM. Validates the port.)

Sprint B2 — Load + collapse testing (5 pts):
- k6 burst-50, burst-200, sustained-100 against the Python service.
- Compare collapse points vs n8n.
- Verify chapter_run_id idempotency under instance restart.
- Document failure modes.

Sprint B3 — Cost + perf measurement (3 pts):
- Anthropic token cost comparison: Python vs n8n (should be identical — same calls).
- Wall time per chapter: target 15-25% reduction from engine overhead.
- Per-chapter $ cost (compute + Anthropic) at 5/10/50 instances.

### Phase C: Production migration (3-4 weeks)

Sprint C1 — PROD service deploy (5 pts):
- Provision PROD `chapter-writer-service` Railway service.
- Set env vars (PROD Supabase, Anthropic, etc.).
- Deploy + verify health.

Sprint C2 — Shadow mode (5 pts):
- PROD hub calls BOTH n8n worker and Python service (in parallel).
- Discard Python result; use n8n.
- Compare outputs every chapter for 7 days.
- Quality + latency dashboards.

Sprint C3 — 10/50/100 cutover (8 pts):
- Classifier flag: `use_python_service: bool` based on hash(user_id) bucket.
- Phase 1: 10% of users → Python.
- Phase 2: 50% (after 1 week clean).
- Phase 3: 100% (after 1 week clean).
- **Zero-quality-regression gate**: Q/A scores during shadow + cutover phases must match.

Sprint C4 — Decommission n8n worker (3 pts):
- Archive `PROD - Worker - Write Chapter` (don't delete; keep for 30-day rollback).
- Remove from `executeWorkflow` references.
- Update [[workflow-id-map]] + [[workflow-tiers]].

### Total: ~12-14 weeks across Phases A + B + C

vs n8n multi-instance (Sprints 16-18): ~12 weeks.

**Comparable timeline. Python wins on scale + cost; n8n wins on dev velocity + visual debugging.**

## Decision matrix

| Criterion | Weight | n8n multi-instance | Python microservice | Notes |
|---|---|---|---|---|
| Scalability ceiling at fixed cost | High | 6/10 | 9/10 | Python reclaims ~3s/chapter overhead; cost gap widens past 10 instances |
| Infrastructure cost at 100 daily users | High | 6/10 | 9/10 | $145/mo vs $80/mo (−45%) |
| Infrastructure cost at 1000 daily users | High | 5/10 | 10/10 | $1,545/mo vs $395/mo (−75%) |
| Implementation cost (engineer-weeks) | Medium | 12 weeks | 12-14 weeks | Roughly equal |
| Operational simplicity | Medium | 6/10 | 8/10 | Standard Python tooling |
| Idempotency / restart resilience | High | 5/10 | 9/10 | HTTP semantics native; n8n workflow-resume is hard |
| Cross-chapter continuity capability | Medium | 4/10 | 9/10 | n8n workflow approach is awkward |
| Quality regression risk | High | 9/10 (no change) | 7/10 (port required) | Mitigated by quality bake-off in testbed |
| Vendor lock-in | Low | 5/10 | 9/10 | Python runs anywhere |
| Observability | Medium | 7/10 (n8n UI) | 7/10 (Sentry/APM) | Different but equivalent |
| Prompt iteration speed | Low | 9/10 | 6/10 | Mitigated by DB-stored prompts |
| Team Python fluency | Medium | n/a | High | Existing Express/Node team comfortable |

**Weighted verdict**: Python microservice scores higher on the high-weight criteria (scalability, cost-at-scale, idempotency) at the cost of the lower-weight criteria (prompt iteration speed, port risk).

**Recommendation: build the Python microservice.**

## How this changes Sprint sequencing

Current [[planned-sprints]] order: 9 → 14 → 15 → 16 → 17 → 18.

If we adopt the microservice path:

| Sprint | Scope under microservice path | vs current |
|---|---|---|
| 9 (Stripe) | **Gated** — cannot ship to PROD until scaling solved | unchanged work |
| 14 (Storage) | unchanged — 3 firm pts + 34 conditional | unchanged |
| 15 (Testbed) | unchanged — testbed + bake-off + collapse testing | unchanged. Adds Python service as 5th LLM variant |
| 16 (was: chapter analysis) | **Becomes Phase A1-A2**: Build + port the chapter-writer service | reframe |
| 17 (was: LLM bake-off + dispatcher) | **Becomes Phase A3-A5**: Q/A engine + cross-chapter + hub integration | reframe |
| 18 (was: multi-instance rollout) | **Becomes Phase B + C**: Validate + shadow mode + cutover + decommission n8n worker | reframe |

Net work effort: roughly the same (~50-55 pts across 16-18). Net infrastructure: cheaper, simpler, more scalable.

## Hard gate: scaling before seats

User-stated constraint: **"we have to solve this scalability issue before we start allowing users to purchase seats."**

This means:
- Sprint 9 (Stripe billing) **cannot deploy to PROD** until the chapter-writer architecture is in production and validated.
- Either path (n8n multi-instance OR Python microservice) is acceptable — both solve scaling.
- Sprint 9 development can proceed in parallel (no production deployment).
- **Real cutover for paid seats happens after Sprint 18 ships (week ~22-26 from today).**

Implication for the program plan:
- If Python path: paid-seat launch ~week 22-24.
- If n8n path: paid-seat launch ~week 22.
- Risk to paid-seat date is higher on Python path due to port risk; mitigated by Sprint 15 testbed validation.

## What would tilt the decision

Pick **n8n multi-instance** if:
- Team Python fluency is lower than expected.
- Visual debugging is mission-critical for the dev velocity model.
- Dev cost is a binding constraint and the 12 weeks of microservice work is unavailable.
- We don't expect to scale past 1000 daily users in the next 12 months.

Pick **Python microservice** if:
- Scaling past 1000 daily users is in the 12-month roadmap.
- Cost-at-scale matters (saving $1k+/month at 1000 users).
- Cross-chapter continuity (a new capability) is valuable.
- Vendor independence matters.
- Idempotency + restart resilience is non-negotiable for SLA reasons.

**Default recommendation: Python microservice.** The cost + scale + capability story dominates. The risk (port quality) is mitigatable via the testbed. We accept slower prompt iteration as a trade.

## Risks specific to the microservice path

| Risk | Mitigation |
|---|---|
| Port misses subtle n8n behavior (e.g. defensive JSON parse edge cases) | Sprint B1 quality bake-off in testbed must score ≥ 0.95 of baseline before Phase C |
| Anthropic streaming behavior differs in async Python vs n8n's sync calls | Validate streaming + non-streaming both during port |
| Background tasks (email, cover art) reliability | Use BullMQ for these (already exists); don't rely on FastAPI BackgroundTasks for production |
| Service crashes mid-chapter | chapter_run_id idempotency + Railway supervisor restart |
| LLM library version drift | Pin Anthropic SDK version in `requirements.txt` |
| Prompt drift between code releases | Prompts in `app_config_v2` JSONB; versioned alongside service |
| Loss of prompt-iteration velocity | Hot-reload prompts from DB; `/admin/reload-prompts` endpoint |
| Team Python fluency gap | Schedule code-review pairing during Phase A; formal Python style guide |

## Cross-system implications

| System | Change required |
|---|---|
| [[chapter-writer-architecture]] | Major rewrite — add "Python service" as the production architecture; n8n version becomes legacy |
| [[workflows/_index|Workflows]] | 5 workflows (Worker - Write Chapter, Tool - Rewrite, Tool - QA, Sub - Research Pipeline, Sub - Build Context) decommission post-Phase C |
| [[deployment-railway|Railway]] | New service `chapter-writer-service` (DEV + PROD); scaled separately from Workbench |
| [[security-model]] | New `CHAPTER_SERVICE_SECRET` shared secret; n8n hub HTTP Request nodes use it |
| [[express-routes]] | New endpoint `/api/chapter-service/proxy` (optional — could call directly from n8n) |
| [[base-tables]] | New `chapter_run_id` JSONB key in `published_content_v2.metadata` for idempotency |
| [[ci-pipeline]] | Add Python service test job; Docker build + push |
| [[testing/_index|Testing]] | New pytest suite for chapter-writer-service; integrated with [[sprint-15-testbed|testbed]] |
| [[runbooks]] | New runbooks: deploy chapter-writer-service, rollback to n8n, prompt hot-reload |
| [[planned-sprints]] | Reframe Sprints 16-18 as Phases A/B/C of microservice migration |

## Open questions

1. **Hosting choice for the Python service.** Railway (existing infra, easy)? Or Kubernetes (more scale headroom, more ops cost)?
2. **Background-task framework.** FastAPI BackgroundTasks (simple, in-process), Celery (battle-tested), or BullMQ via shared Redis (consistency with existing stack)? **Recommend BullMQ** — already exists.
3. **Prompt storage.** Code repo (versioned, requires deploy)? `app_config_v2` JSONB (hot-reloadable, less version control)? Hybrid (code as default, DB override)? **Recommend hybrid.**
4. **Service-to-service auth.** Shared secret (simple, works), JWT (more complex), or mTLS (most secure)? **Recommend shared secret** matching existing pattern in [[security-model]].
5. **Streaming responses to client?** n8n currently doesn't stream chapter text to the user; they get a notification when done. Python service could stream via SSE for partial-chapter previews — separate UX feature, not required for parity.

## Decision needed

This page is the architecture proposal. The decision is binary:

- [ ] **A) Stay on the n8n multi-instance path** — proceed with [[sprint-15-testbed]] as written, then Sprints 16-18 per [[planned-sprints]].
- [ ] **B) Switch to the Python microservice path** — adopt this proposal. Sprint 15 unchanged. Sprints 16-18 reframe as Phases A/B/C.

If undecided, **default decision criterion**: run [[sprint-15-testbed|Sprint 15 testbed]] with both paths represented. Add Python microservice as the 5th LLM variant. The empirical results from the testbed will surface the right answer with measured data instead of debate.

If a decision is needed before Sprint 15: **recommend B (Python microservice)** for the reasons in the decision matrix.

## Where this lives in the program

This page is a **decision document**, not a sprint plan. When the decision lands:
- If A: archive this page; proceed with existing plan.
- If B: this page becomes the architecture spec for Sprints 16-18 reframe; updates to [[chapter-writer-architecture]], [[planned-sprints]], [[design-feasibility]] follow.

Either way: [[sprint-15-testbed|Sprint 15]] proceeds first. Empirical data informs the decision.
