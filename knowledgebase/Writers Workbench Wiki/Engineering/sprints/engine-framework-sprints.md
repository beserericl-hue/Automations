---
name: Engine framework sprints (F0–F2) — task breakdown
description: Concrete task breakdown for the framework-first Writer Engine build — F0 foundation (start today), F1 write-workshop step services, F2 newsletter step services. Includes a start-today readiness/blocker audit. Operationalizes engine-framework + newsletter-microservices.
type: concept
tags: [sprints, python-backend, engine, microservices, task-breakdown, gate-3]
last_reviewed: 2026-05-29
---

# Engine framework sprints (F0–F2) — task breakdown

Operationalizes [[engine-framework]] (the per-step-microservices, salable-engine, framework-first direction) and
[[newsletter-microservices]] into runnable sprint tasks. Order: **F0 foundation → F1 write-workshop → F2 newsletter**
(F1 + F2 ride the same sprint train; the newsletter is the first full vertical because its design is done). Acceptance
criteria reference the suites in [[engine-api-system-tests]].

---

## START-TODAY READINESS / BLOCKER AUDIT (2026-05-29)

**Verdict: 🟢 No hard blockers to starting F0 today.** Three same-day pre-flight config items + two ordering
reconciliations, none of which block F0 foundation work. Details:

### Confirmed present (no action)
- **Core infra/keys already provisioned** on the DEV WritersWorkbench Railway service (copy to the new engine
  service): `ANTHROPIC_API_KEY`, `KIEAI_API_KEY` (cover art), `POSTAL_API_KEY`/`POSTAL_API_URL`, `REDIS_URL`,
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `INGESTION_SECRET`.
- **DEV Redis healthy** (verified this session — `/api/health` redis ok). **Supabase tables present** (newsletter_*,
  content_ingestion_v2, job-queue 008, approvals, templates, subscribers). **Postal** installed (one shared server).
- **Railway** can host new services in the `bubbly-solace` project (dev/prod envs). **Ingested topic data exists** in
  DEV `content_ingestion_v2` (534 rows) for newsletter parity testing.

### Pre-flight config (resolve Day 1 — needed by F1/F2 steps, NOT by F0 skeleton)
1. **Provision the picker key — Gemini 2.5 Pro.** Not in the Workbench Railway env; the key exists in the n8n
   credential `Google Gemini(PaLM) Api account` (id `QCbiHRahj2Q15wqr`). Add as `PICKER_API_KEY`/`GEMINI_API_KEY` on
   the engine service. *(Needed by `pick-svc`, F2.)*
2. **Provision the research key — Perplexity.** Exists in n8n credential `ggr9QCRobQVA6Lwb`; add `PERPLEXITY_API_KEY`.
   *(Needed by `research`, F1.)*
3. **Confirm/provision the scrape provider key — Firecrawl** (or whatever `scrape_segment_external_source_url`'s
   sub-workflow uses). Add `FIRECRAWL_API_KEY`. *(Needed by `scrape-svc`/`media.scrape-url`, F1/F2.)*

   None of these block F0 (foundation uses Anthropic + Supabase + Redis, all present). They are short config tasks;
   do them while F0-1/F0-2 land.

### Ordering reconciliations (decisions, not technical blockers)
4. **Sprint 15 testbed** ([[sprint-15-testbed]]) is the one documented prerequisite in [[work-ordering-2026-05]] —
   but it gates **cutover + LLM-strategy/quality validation** (F3), not the F0 skeleton. Its intent (LLM bake-off +
   collapse-point numbers + Q/A rubric) is **folded into F0-7 (scaling/parity harness)** + [[engine-api-system-tests]]
   L5/L6, so it runs *as part of* the framework rather than as a serial gate before it. → F0 starts today; bake-off
   results inform per-step model choices before each cutover.
5. **Gate 1 (newsletter PROD ship via n8n)** in [[work-ordering-2026-05]] is **superseded** by this framework: the
   newsletter now ships via the Python engine (F2), not by promoting n8n workflows to PROD. The 5 DEV n8n bug-fixes
   made this session keep the n8n path working as the **fallback/parity reference** until F2 cutover. The "no PR
   merges to `main` until newsletter complete" rule is unaffected — engine work lives in a new repo/dir on
   `feature/*` off `develop` and does not touch `main`.

### Day-1 checklist (do these to "start")
- [ ] Create the engine monorepo (repo `author-agent-engine`, or `writers-workbench/engine/` subdir — recommend
  **separate repo** for clean B2B packaging) + a `feature/engine-foundation` branch.
- [ ] Stand up a DEV Railway service group for the engine (gateway + first step) in the `bubbly-solace` develop env;
  copy the present env vars; add the 3 keys above.
- [ ] Commit the still-uncommitted DEV server fix (`server/src/routes/ingestion.ts` `?include_html=0`) to `develop`
  so the engine's `gather` can rely on it (currently only on DEV via `railway up`). *(Carryover from this session.)*

---

## F0 — Engine foundation (start today)

**Goal:** the shared engine library + step-service template + orchestrator + gateway + build/deploy/CI + scaling
harness, proven by one trivial end-to-end vertical slice. Everything in F1/F2 is built on this.

| ID | Task | Pts | Acceptance | Deps |
|---|---|---|---|---|
| **F0-1** | Monorepo + `writer_engine` library skeleton (uv or poetry; ruff + mypy + pytest + pre-commit; CODEOWNERS; README) | 3 | `uv sync` + `pytest` run clean; pre-commit blocks lint/type errors | — |
| **F0-2** | Shared library core modules: `llm` (Anthropic + Gemini + Perplexity adapters, **prompt caching**, token/cost accounting, multi-LLM router), `prompt_store` (DB-backed + hot reload), `schemas` (Pydantic step-contract base), `supabase`, `redis`/`arq`, `storage`, `postal`, `telemetry` (structlog + Prometheus + OTel), `auth` (X-Service-Secret + API-key), `idempotency`, `rate_limit`, `state_machine` | 8 | Each module unit-tested (happy + failure), >80% cov; an Anthropic + a Gemini call succeed against live keys | F0-1 |
| **F0-3** | **Step-service template** (cookiecutter): uniform `POST /run {execution_id}`, `/admin/health`, `/metrics`; imports `writer_engine`; its own `Dockerfile` target | 3 | `cookiecutter` → a runnable echo step; L0 contract test (schemathesis on `/openapi.json`) green | F0-2 |
| **F0-4** | **Orchestrator framework** (saga base): durable state machine persisted on Supabase, step invocation (arq + HTTP), HITL gate primitives (create approval → stop → resume), SSE progress publish to Redis `…:{execution_id}` | 5 | Unit + integration: a 2-step demo pipeline advances, pauses at a gate, resumes on resolve (L3 harness) | F0-2 |
| **F0-5** | **API gateway**: `/internal/*` (service-secret) + `/v1/*` (api-key) routing skeleton; OpenAPI `/docs`; SSE relay (gateway subscribes Redis → SSE, mirroring the Express relay) | 5 | `/internal` 401 without secret; `/v1` 401 without key; SSE stream delivers orchestrator events (L4) | F0-4 |
| **F0-6** | **Build/deploy infra**: monorepo build matrix → shared base image + per-service thin images; `docker compose` for the full set; IaC Railway manifests (dev); CI job (lint/test/build/`compose up` + L0/L8 tests) | 5 | `docker compose up` runs gateway + echo step + orchestrator locally; CI green on PR; one engine service deploys to DEV Railway, `/admin/health` 200 | F0-3, F0-5 |
| **F0-7** | **Scaling + parity harness** (folds in Sprint 15 intent): k6/locust load harness + Prometheus assertions + per-service autoscale config + an L5 parity-diff harness + the gold rubric hook from [[sprint-15-testbed]] | 5 | L6 smoke load runs and reports runs/min + p95; L5 harness can diff an engine artifact vs an n8n artifact | F0-6 |
| **F0-8** | **Vertical-slice proof**: implement ONE real read step end-to-end (`library.retrieve` read, no LLM) gateway→orchestrator→step→Supabase + SSE | 3 | L0–L2 green for the slice through the deployed DEV engine; this validates the whole skeleton | F0-5, F0-6 |

**F0 exit:** the framework is real and deployed to DEV; a vertical slice passes L0–L4 + an L6 smoke; the team can add
a new step service in <1 day from the template. **≈37 pts.**

---

## F1 — Write-workshop step services

> **Deployment constraint (locked 2026-05-30):** F1-A and F1-B add **no new Docker images.** Every new step
> service lands as another background uvicorn process inside the existing `writer-engine-runtime` container
> (`services/runtime/Dockerfile` + `entrypoint.sh`). The orchestrator continues to reach each step via
> `localhost:<port>` over the `*_STEP_URL` env vars. Splitting to per-service Railway services is deferred to
> F3+ once traffic data justifies the cost. The per-step *architecture* (each step is a separate FastAPI app
> with its own port and StepInput/StepOutput contract) is preserved unchanged — only the deployment is unified.
>
> Adding a new step service in F1-A is mechanical:
> 1. Source under `engine/services/<step>_step/src/<step>_step/main.py` (already in the uv workspace).
> 2. Two `COPY` lines into `engine/services/runtime/Dockerfile` (pyproject + src).
> 3. One `start <module>:app <port> <name>` line + one `export <STEP>_STEP_URL="http://localhost:<port>"` line
>    in `engine/services/runtime/entrypoint.sh`.
> 4. One `railway up --service writer-engine-runtime` redeploy.
>
> **At F1-B exit the entire writing-engine API runs through `writer-engine-gateway` — Sprints 16-20 finish with
> the whole writing engine in the Python engine.** Only V1 baseline workflows remain in n8n.

**Goal:** the writing engine's step services on the framework, hub-routed via the `app_config` flag,
shadow-tested, parity-validated, cut over per step. Acceptance = [[engine-api-system-tests]] suite B + L5 parity.

### Prerequisite landing ahead of F1-A (~½ day, must precede)

Narrow the step-service `except KeyError: fixture` fallback to an explicit "provider not registered" check so
real LLM failures surface as `StepOutput.error` instead of fake-success fixtures. This is the bug that hid the
prompt-format-string issue during the F1+F2 sanity check; if we ship F1-A on top of it, every step regression
silently passes.

### F1-A — Port the step logic (~36 pts)

Replace the F0-landed stubs in each write-workshop step with real LLM/data logic and full L5 parity.

| ID | Task | Pts | Acceptance |
|---|---|---|---|
| **F1-1** | `chapter` steps: `context`, `subchapter-write` (parallel fan-out), `continuity-merge`, `extract-bible`, `persist` (idempotent on `chapter_run_id`) + `chapter-orch` | 8 | S-CH E2E; L5 parity ≥0.95 vs `Worker - Write Chapter`; replay idempotent |
| **F1-2** | `chapter` Q/A steps: `qa`, `drift-scan` (deterministic, byte-equal), `genre-eval`, `format-kindle` | 5 | drift byte-equal to n8n; qa/genre within 0.05 of baseline |
| **F1-3** | `research` (derive-questions → Perplexity → synth → persist) | 5 | S-RE parity vs `Sub - Research Pipeline`; Perplexity key present in engine env |
| **F1-4** | `brainstorm` (story/chapter) + `edit-outline` (locked-character preservation) | 5 | S-BR; R-test locked-character regressions pass; edit-outline ≠ full re-brainstorm |
| **F1-5** | `media`: `cover-art` (KIE.AI + DALL-E fallback), `social-posts`, `scrape-url` (Firecrawl) | 5 | S-MED; KIE.AI + Firecrawl keys present |
| **F1-6** | `library`, `story-bible`, `approval`, `notify` step services (CRUD + lifecycle + token issue/validate) | 8 | S-LIB/S-SB/S-APP/S-NOT; approval expiry → 404 (S-15) |

**F1-A exit:** every write-workshop module's L5 parity ≥0.95 vs its n8n baseline; all running inside the
existing `writer-engine-runtime` container; the parametrized smoke tests + L2 module-orch tests for each module
green in CI. **~36 pts.**

### F1-B — Hub routing + DEV→PROD cutover (~8 pts)

| ID | Task | Pts | Acceptance |
|---|---|---|---|
| **F1-6b** | **Engine machinery (DONE)**: the 8 write-workshop steps deployed in `writer-engine-runtime` + uniform `gateway /internal/write/{tool}` → `orchestrator /pipelines/write/{tool}/run`. | — | verified end-to-end on DEV (a full craft-composed outline returned through the gateway). PRs #105–#109. |
| **F1-7** | **Hub routing + shadow**: n8n hub `ai_tool`s switch `executeWorkflow` → HTTP to engine per `app_config.python_backend_routing`; DEV shadow (both run, compare) | 5 | DEV end-to-end through engine for all F1 tools; shadow diff dashboard ≥95% agreement |
| **F1-7.5** | **ACCEPTANCE TEST (DEV) — the gate before PROD.** Run the full F1 acceptance suite on the **develop** system: A1 unit (CI green) · A2 system S-suite on the deployed DEV engine · A3 R-CHAPTER-DB regression (craft-QA ≥0.8) · A4 L5 parity ≥0.95 over the ≥7-day shadow · A5 UAT through the DEV Workbench UI. | 3 | A1–A5 all pass on DEV **and** user signs off. See [[f1-test-plan]] §4 / `engine/docs/f1b-hub-routing.md` §4. |
| **F1-8** | **DEV→PROD cutover per tool** behind the flag — **starts only after F1-7.5 passes + user go.** Set PROD engine env, flip `python_backend_routing.{tool}=engine`, smoke, archive replaced n8n workflows after 7 clean days. | 3 | PROD on engine for F1 ops; n8n F1 tool workflows archived (not deleted) |

**F1-B sequence:** machinery (done) → hub rewiring + shadow (DEV) → **acceptance test on DEV (gate)** →
PROD flip. The PROD flip (Tier-2/3) never precedes the DEV acceptance sign-off.

**F1-B exit:** the writing-engine API is fully Python on PROD; n8n hub keeps routing but every tool dispatches
to `writer-engine-gateway`. **~11 pts.**

---

## F2 — Newsletter step services (design in [[newsletter-microservices]])

**Goal:** the newsletter per-step services + `newsletter-orch` with the **3 HITL gates** (stories, subject, images),
**no emails** (UI/SSE comms), **BOTH** delivery (Postal + web permalink), **Gemini** picker; behind the Express
`NEWSLETTER_BACKEND` flag; parity-validated against the n8n compose path; then archive the n8n compose workflow.

| ID | Task | Pts | Acceptance |
|---|---|---|---|
| **F2-1** | `gather-svc` (reads `content_ingestion_v2`, md-only via `?include_html=0`) + empty-corpus skip | 3 | S-17; S-14 empty→`skipped_no_content` |
| **F2-2** | `pick-svc` (Gemini 2.5 Pro) + revision-aware; `subject-svc` + revision-aware | 5 | picks structured stories; subject+alts+reasoning; needs Gemini key (pre-flight #1) |
| **F2-3** | `scrape-svc` (per-URL error filter) + `segment-svc` (per-story fan-out) + `image-svc` (propose options) | 8 | S-segment; scrape failures dropped (S-FAIL-3); fan-out scales (S-LOAD-2) |
| **F2-4** | `assemble-svc` (intro + other-stories + concat) + `render-svc` (Jinja2 masthead template, Playfair) + `persist-svc` (idempotent `newsletter_sends_v2`) | 5 | S-08 row has masthead html_body + metadata; S-16 idempotent |
| **F2-5** | `deliver-svc` = **BOTH**: Postal fan-out **and** web archive/permalink (`ARCHIVE_BASE_URL`, store `metadata.permalink`) + bounce path | 5 | S-13 email + permalink; S-19 bounce flips subscriber |
| **F2-6** | `newsletter-orch` state machine: gather→pick→**gate**→subject→**gate**→segments→images→**gate**→assemble→render→persist→deliver; revision loops; SSE stages | 8 | S-07/S-09/S-10/S-11/S-12 (3 gates + revision); SSE stage order |
| **F2-7** | **UI review endpoints + screens**: `…/executions/{id}/review/{stage}` for the 3 gates; ApprovalDetail renders stories/subject/images; per-segment SSE; final preview (`NewsletterDetail`) — **no emails** | 5 | review content surfaces in UI for all 3 gates; UI needs no breaking change |
| **F2-8** | **Express proxy + flag**: `/api/newsletter/*` proxies to engine `/internal/*` behind `NEWSLETTER_BACKEND=n8n|python`; SSE bridged via existing endpoint | 3 | DEV `NEWSLETTER_BACKEND=python` runs the full flow; flip back = instant rollback |
| **F2-9** | `cadence-cron` (X-Cron-Secret, due-edition poll → enqueue) | 2 | S-18 cadence enqueues only due editions |
| **F2-10** | **Parity + cutover**: full S-07…S-19 + L6 load green on DEV vs n8n; PROD flip; then archive n8n `Content - Newsletter Agent V2` (keep 90-day rollback) | 5 | newsletter PROD on engine; n8n compose archived |

**F2 exit:** newsletter generated + delivered by the engine in DEV (then PROD), n8n compose path archived.
**≈49 pts.**

---

## F2.5 — Chapter algorithm optimization

Full plan: **[[chapter-optimization-sprint]]**.

Migration-as-port (Sprints 16-17 inside F1-A) reclaims ~3s/chapter of n8n engine overhead, parallelizes
sub-chapter writes, and adds prompt caching + multi-LLM strategy — a **stated 15-25% p95 latency
improvement vs. the n8n baseline**, with no algorithm change. **F2.5 is the separate cycle that goes after the
algorithm itself** — merging passes, streaming + early-start continuity merge, tier-down models per role,
two-pass fast-draft / deep-edit — to push wall-clock down another step function while protecting quality
against the Sprint-15 testbed rubric. Gated on (a) F2 PROD-shadow numbers for "what wall-clock the optimization
must actually hit," (b) Sprint-15 testbed quality baseline, (c) F1-A complete so we have a clean Python
implementation to optimize against (not n8n). **~25 pts, ~2-3 weeks.**

---

## Sequencing & dependencies

```
F0 (foundation, DONE) ──> F2 (newsletter, in flight) ──> F2.5 (chapter algo optimization)
                                  │                                  │
                                  └──> F1-A (write-workshop ports) ──┘ (parallel after F0-3/F0-4)
                                            │
                                            └──> F1-B (hub routing + cutover) ──> F3 (n8n removal) ──> (B2B / Stripe later)
   pre-flight keys (Gemini/Perplexity/Firecrawl) landed during F0
   Sprint-15 bake-off intent folded into F0-7; results gate F1/F2 PROD cutovers AND F2.5 quality verdict
   F1-A + F2.5 deploy into the existing writer-engine-runtime container (no new Docker images per F1 constraint)
```

- **F0 is the only hard prerequisite** (done); F1-A and F2 can proceed in parallel.
- **F2.5 lands between F2 and F1-B**: needs the F2 numbers + F1-A's clean Python chapter as the optimization
  target. Running F2.5 before F1-A would optimize n8n behavior the engine is about to discard.
- **Cutover gates** (F1-B / F3): the PROD flip is gated behind a **formal acceptance test of the DEV system**
  (F1-7.5 / [[f1-test-plan]] §4) — A1 unit + A2 system + A3 regression + A4 L5 parity ≥0.95 over a 7-day DEV
  shadow + A5 UAT — which must pass and be signed off **before** any PROD flip. Acceptance on `develop` first;
  PROD flip after.
- **DoD per task** = its [[engine-api-system-tests]] suite(s) green in CI + the DEV deployment.

## Carryover from the 2026-05-29 session
- Uncommitted DEV server fix `server/src/routes/ingestion.ts` (`?include_html=0`) — commit to `develop` (Day-1
  checklist) so `gather-svc` relies on it.
- The 5 DEV n8n compose bug-fixes keep the n8n path working as the **parity reference** for F2 until cutover.

See also: [[engine-framework]] · [[newsletter-microservices]] · [[engine-api-system-tests]] · [[service-decomposition]]
· [[python-migration-roadmap]] · [[work-ordering-2026-05]] · [[sprint-15-testbed]].
