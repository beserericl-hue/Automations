---
name: Remaining work inventory (engine completion + scale to 50 users)
description: Evidence-backed inventory of everything left to finish in the Writers Workbench engine, categorised A–I by workstream with per-item status (not implemented / partial / implemented-but-wrong). Includes the two decisions taken 2026-10-15 — ingestion moves to the engine and n8n is turned off (E1), and the runtime container collapses 21 processes to 3 rather than splitting into per-step Railway services (B10). Supersedes the sprint-status framing in planned-sprints and python-migration-roadmap.
type: concept
tags: [sprints, engine, inventory, scaling, parity, remaining-work, gate-plan, 2026-10]
last_reviewed: 2026-10-15
---

# Remaining work inventory

Audited 2026-10-15 against the **live repo, live n8n, and both Railway tiers** — not against the planning
docs. The planning docs are stale in ways that matter (see §0), so every item below cites code, a live
API response, or an n8n query.

**Driving question:** the engine must be complete and optimised enough to onboard additional users. The
working assumption going in was that it may not yet handle *one* user correctly, let alone 50. Three
findings confirm that concern:

- The runtime container launches **19 step services + an arq worker as unsupervised `&` background shell
  jobs** — if one dies, nothing restarts it (**B1**).
- `/admin/health` returns `{"status":"ok"}` **unconditionally** and checks nothing, so Railway cannot
  detect B1 (**B2**).
- **The engine has no CI.** `engine-ci.yml` — which [[log|the F0 log entry]] claims was delivered — does
  not exist in the repo. The ~350 Python tests gate nothing (**H1**).

Status legend used throughout:

| | Meaning |
|---|---|
| ❌ | Not implemented — nothing exists |
| 🟡 | Partially implemented — works in some paths, gaps in others |
| ⚠️ | Implemented but wrong, unsafe, or actively misleading |

---

## 0. What the planning docs get wrong

Correct these before using any of them for sequencing.

| Stale claim | Reality (verified 2026-10-15) |
|---|---|
| [[python-migration-roadmap]] / [[planned-sprints]] present the Python rewrite as future work (Sprints 16–27) | **The engine is built, deployed, hub-routed and passing a 161-test parity suite on DEV.** What remains is *cutover and hardening*, not construction |
| Roadmap puts the hub port at Sprint 22 / phase F4 | **Already shipped** — CR-004 Path B: `writer_engine.hub` with Gemini router, `POST /internal/hub` + `/internal/hub/voice`, `HUB_BACKEND=engine` live on DEV, stress-tested 10-concurrent over 84 chapters |
| [[workflow-id-map]] PROD↔DEV table | **IDs map to the wrong names** — see **D3**. The promotion script reads this file |
| [[postal-mail-stack]] / [[email-pipeline]] / [[credentials-map]] / [[env-vars-by-tier]] describe two Postal mail servers with per-tier keys | One shared server, one shared key (corrected in [[log]] 2026-05-17; the pages were never fixed) |
| [[log]] is current | Ends **2026-07-07**. ~91 commits since are unrecorded |

---

## Decisions taken 2026-10-15

### E1 — Content ingestion moves to the engine; n8n is turned off

CR-010 A3 left this as an open fork: keep the n8n scraping cron as the ingester, or port it. **Decision:
port it.** The engine becomes the producer of `content_ingestion_v2`, and n8n is switched off for the
Workbench entirely.

Consequences:

- `scrape_step` already does per-URL Firecrawl; the port needs a **genre-loop scheduler + indexer** on the
  cron path, replacing `PROD - Data: AI Scraping Pipeline` (21 nodes), `Data: Content Ingestion`,
  `DEV - Data: Content Ingestion`, `AI News Data Ingestion V2` (87 nodes) and
  `DEV - Newsletter Ingestion (Multi-User Cron)` (13 nodes).
- **A3 (embeddings) stops being optional.** Once n8n is off, `PROD/DEV - Sub - Embed Project Data` goes
  with it, and nothing re-embeds project canon. A3 must land *before* n8n is disabled or chapter prose
  loses canon grounding silently.
- Same for **A4** — `PROD/DEV - Sub - Token Usage Tracker` is n8n-side.
- The V1 (`Orig`) tree stays untouched per [[tier-separation]] baseline protection. "Turn off n8n" means
  the PROD/DEV Workbench tiers, **not** V1 and **not** the unrelated tenants in **E5**.
- The parallel content system (**E4**, ~15 workflows) shares this n8n instance and the Anthropic
  credential. It needs a separation plan before the instance is wound down — tracked, not blocking.

### B10 — One image, 21 processes → 3; defer the per-step split

**Decision: do not split into ~20 Railway services yet.** Collapse the runtime container's process model
and keep the split as a configuration change.

Rationale:

1. **The topology is already a config decision.** The orchestrator dials every step through `*_STEP_URL`
   env vars (`engine/packages/writer_engine/src/writer_engine/config.py:108-129`). Mounting the step apps
   in one process means `CHAPTER_STEP_URL=http://localhost:8001/steps/chapter`; splitting later means
   `http://chapter-step.railway.internal:8020`. **Nothing else changes.** The StepInput/StepOutput
   contracts and per-step app boundaries survive untouched either way.
2. **Splitting buys no throughput today.** **B9** is the binding constraint — the Burial Mound run
   established that throughput is bounded by **account-wide Anthropic TPM**, and that adding instances
   does not help simultaneous heavy writes. Per-step scaling cannot relieve a provider rate limit.
3. **Collapsing fixes B3; splitting worsens it.** `MAX_CONCURRENT_LLM` lives in the `LLMRouter` module
   singleton, so today there are ~21 independent semaphores. One steps process = one router = one
   semaphore that means what the docs say it means.
4. **Memory.** 21 Python interpreters each importing anthropic/httpx/pydantic. Collapsing removes that
   baseline; splitting multiplies it across containers.
5. **Ops cost.** 20 Railway services × health checks × env sets × deploy pipelines × secret rotation, at
   exactly the moment the priority is shipping.
6. **No load data exists** (**B11**). Splitting now optimises an unmeasured bottleneck.

Target shape — **3 supervised processes** in the existing `writer-engine-runtime` image:

| Process | Contents |
|---|---|
| 1 | orchestrator FastAPI (externally bound on `$PORT`) |
| 2 | arq worker |
| 3 | all step apps mounted as sub-applications in one uvicorn under `/steps/<name>` path prefixes |

Replace the bash `&` entrypoint (`engine/services/runtime/entrypoint.sh`) with a real supervisor so a
dead process restarts. Horizontal scale = replicas of this container coordinated by the shared Redis
budget — which is exactly the CR-003 model and is sound.

**Two verification tasks before co-locating steps on one event loop** (do not assume these away):

- Confirm **no step performs blocking I/O or CPU-heavy work**. `render_step` (Jinja) and `image_step` are
  the suspects; if either is CPU-bound it gets its own process (3 → 4).
- Confirm the Gemini client's thread-pool wrapping actually keeps the loop free (the F0 notes say it is
  "async-wrapped"; verify rather than trust).

**Revisit trigger:** after Gate 2 measurement, peel out only the step the load data indicts — almost
certainly `chapter_step`.

---

## A. Correctness for a single user

| ID | Item | St | Evidence | Impact |
|---|---|---|---|---|
| **A1** | **Fixture fallbacks fabricate deliverables.** A missing or invalid provider key yields a plausible artifact that is then persisted and emailed | ⚠️ | `research_step/main.py:70` returns `"(stub answer for: …)"`; `media_step/main.py:186,286`; `_fixture()` in `subject_step:18`, `segment_step:18`, `assemble_step:26`, `brainstorm_step:121`, `pick_step:21`; `library_step:57,202,542` return `{"fixture": True}` | The `ProviderNotRegistered` narrowing stopped *real* LLM errors being masked, but a *misconfigured key* still produces fake success. Only `media_step:264` was hardened against persisting a fixture. **Highest-priority correctness risk** |
| **A2** | **Newsletter steps run on placeholder prompts, not the ported n8n prompts** | 🟡 | `prompt_store/n8n_seeds/__init__.py:5-7` — verbatim prompts load under `n8n_baseline.*` and "the step services keep using the placeholder seeds until the token-mapping work in Sprint 17 lands"; `prompt_store/seeds.py:3` "minimal … placeholders" | Newsletter L5 parity is structural only, not prompt-fidelity. Chapter steps are unaffected — they use the richer `follett_seeds.*` layer |
| **A3** | **Embeddings / canon grounding off.** `chapter.write` never retrieves project canon | ❌ | `config.py:95` `ENABLE_PYTHON_EMBEDDINGS=false`; `re_embed_project` exists but nothing triggers it; n8n `Sub - Embed Project Data` is the live embedder | CR-010 A2: "a quality-parity gap, not just a feature gap." **Blocks E1** |
| **A4** | **Token accounting is chapter-only** | 🟡 | `begin`/`flush` called only in `chapter_step`; brainstorm, research, media and the newsletter steps write no `token_usage_v2` | CostDashboard under-reports; credits were never calibrated (CR-007's "exact tokens-per-credit" is still unmeasured). **Blocks E1** |
| **A5** | **Prompt hot-reload cannot work** | ⚠️ | `PromptStore` is a module global (`prompt_store/store.py:65`); each of the 21 processes holds its own. `/admin/reload-prompts` on the gateway reloads nothing that generates text. `reload_from_supabase` swallows every exception and returns 0 (`store.py:44-50`) | Prompt tuning — the main quality lever — has no working production path. **B10's collapse largely fixes this** |
| **A6** | **Story bible: polluted data, no hub write path** | 🟡 | ~1000 rows / 297 `character` dupes remain after the junk filter; `story_bible_step` has add/list but the catalog routes only `story_bible.list`; no edit/delete; `StoryBiblePanel` is read-only | Story Bible tab shows garbage and users cannot fix it |
| **A7** | **Drift detector over-flags** | 🟡 | 16 residual drifted chapters in the Burial Mound run; flags characterisation that *adds to* rather than *contradicts* a sparse roster bio | False positives train users to ignore the signal |
| **A8** | **Eve callback is a gated dry run** | ❌ | `writer_engine/eve.py:114` returns `{"dry_run": True}` when `ELEVENLABS_API_KEY`/`AGENT_ID` are unset — they are unset by design. PROD Eve still calls the n8n PROD hub | Voice is the headline feature and is not on the engine. Pointing PROD Eve at the engine is baseline-protected and needs explicit authorisation |
| **A9** | **Dead ops still routable** | 🟡 | CR-010 A4: `brainstorm_step.chapter` returns empty beats (superseded by `chapter.plan`) but remains in OPS → misroutes. `library_retrieve_step` (the F0 demo, superseded by `library_step`) still runs on `:8002` and returns `fixture-1`/`fixture-2` | Silent wrong answers |
| **A10** | **Two newsletter orchestrators coexist** | 🟡 | `newsletter_orch.py:316` — "placeholder — the gate is held until the resume endpoint fires (real impl in F3)" — alongside the durable `newsletter_saga.py` | Ambiguity about which path actually runs |
| **A11** | **Newsletter cadence ignores time-of-day / day-of-week** | 🟡 | Cron checks day-interval only; `cadence` + `cadence_send_time` on `newsletter_editions_v2` are decorative | The scheduling UI lies to the user |
| **A12** | **`/v1/*` B2B surface is a stub** | ❌ | `auth/api_key.py:17` `tenant_id="tenant-stub"`; `gateway/routes/v1.py` "F0 stub" | Acceptable for now — just do not count it as built |

---

## B. Scale — blockers to 50 users

| ID | Item | St | Evidence | Impact |
|---|---|---|---|---|
| **B1** | **19 step services + arq worker run as unsupervised `&` background jobs in one container** | ⚠️ | `engine/services/runtime/entrypoint.sh` — only the orchestrator is `exec`'d; no supervisor, no restart | One dead step = every job through it fails while the container reports healthy. **Fix first** |
| **B2** | **`/admin/health` checks nothing** | ⚠️ | `orchestrator/main.py:88-90` returns `{"status":"ok"}` flat — no check of the 19 steps, Redis, Supabase or the worker. No readiness/liveness split | Railway cannot detect B1; no graceful drain on deploy |
| **B3** | **`MAX_CONCURRENT_LLM` is per-*process*, not per-instance** | ⚠️ | Semaphore lives in the `LLMRouter` module singleton (`llm/factory.py:9`, `llm/router.py:62`); each of ~21 processes builds its own | The documented cap of 12 is really up to 12 × N processes. **CR-003's "~10 users per instance" sizing has no basis.** Fixed by B10 |
| **B4** | **One arq queue for everything** | ❌ | `orchestrator/worker.py:87` `queue_name="newsletter"`, `max_jobs=16` — newsletter sagas, chapter writes, Q/A, plan, cover-art and lifecycle share 16 slots | A 96-chapter batch starves every interactive op (CR-010 C3) |
| **B5** | **90-min timeout × 2 tries, uniform across ops** | ⚠️ | `worker.py:97,99` `job_timeout=5400`, `max_tries=2` | 16 stuck jobs = a 3-hour total stall. A Q/A needs seconds, not 90 minutes. No dead-letter path |
| **B6** | **Retry idempotency unproven outside `chapter.write`** | 🟡 | `run_write_tool_job` is retried by arq; only `chapter.write` is keyed on `chapter_run_id`. brainstorm/research/media persist and lifecycle are unverified | A retry after partial success duplicates rows |
| **B7** | **Multi-instance has never been run** | ❌ | One gateway replica, one runtime, no LB. arq single-delivery assumed but unverified cross-instance. No graceful drain (readiness flip → finish in-flight → SIGTERM) | A deploy mid-chapter loses a 90-minute job (CR-010 C1) |
| **B8** | **Per-provider shared budgets missing** | ❌ | Only Anthropic has a Redis-shared budget (`rate_limit/anthropic_budget.py`). OpenAI, Perplexity, Gemini, Firecrawl and KIE.AI have none; CR-003 still lists the Perplexity limiter as outstanding | Fan-out at 50 users will 429 those providers |
| **B9** | **Account-wide Anthropic TPM is a hard ceiling** | ⚠️ | Burial Mound finding: throughput is bounded by account-wide TPM; adding instances does not help. Tier-4 Sonnet = 90k output TPM ≈ **5 chapters/min** ([[f1a-decisions]]) | 50 concurrent heavy users queue rather than fail — but they queue. Levers: higher tier, `hybrid-draft-polish` as default (splits Haiku/Sonnet pools), or BYOK (deferred) |
| **B10** | **Per-step independent scaling defeated by deployment** | 🟡 | All 21 steps in one image (locked in F1 as "no new Docker images", deferred to F3) | **RESOLVED — see Decisions above.** Collapse to 3 processes; defer the split until Gate 2 data |
| **B11** | **No load test has ever been run** | ❌ | [[sprint-15-testbed]] never executed; CR-003's "load test (L6) at 10 + 20 concurrent users" still open; `engine/load/k6_smoke.js` is scaffold | **Every capacity number in the docs is a guess.** Nothing has validated 10 users |
| **B12** | **No autoscaling policy and no queue-depth metrics to drive one** | ❌ | CR-010 C4 | "Add an instance" is guesswork |
| **B13** | **Redis is an un-alerted SPOF** | ⚠️ | Queue, Anthropic budget, HITL gates, SSE pub/sub, sessions and the idempotency cache all live on it. Not HA. It died silently for 9 days in May (auto-memory `project_prod_redis_outage_risk`; [[log]] 2026-05-28) | A single failure takes the engine down invisibly |

---

## C. Observability & reliability

| ID | Item | St | Evidence |
|---|---|---|---|
| C1 | Prometheus metrics exist per-process; no dashboard, no fleet view | ❌ | CR-010 C4 |
| C2 | No alerting of any kind — uptime, queue depth, 429 rate, budget utilisation | ❌ | |
| C3 | Provider error strings logged raw; no secret-redaction pass | ⚠️ | `llm/anthropic_client.py:71-72` `error=str(exc)[:200]` |
| C4 | Bare `except Exception` swallows failures in several paths | 🟡 | `prompt_store/store.py:44-50`; step fixture fallbacks |

---

## D. Release & tier debt

| ID | Item | St | Evidence |
|---|---|---|---|
| **D1** | **PROD is 3.5 months behind DEV** | ⚠️ | PROD `/api/health` → `deployed_at: 2026-07-01`, `version: "unknown"`; DEV → `2026-10-10`. ~91 commits DEV-only |
| **D2** | **PROD is still 100% n8n** | ❌ | `HUB_BACKEND=engine` is DEV-only (`server/src/lib/engine-hub.ts:16`). The F1-7.5 acceptance gate (A1–A5) has never run; no shadow period |
| **D3** | **`workflow-id-map.json` is factually wrong vs live n8n** | ⚠️ | Live: `TVNfTVwOrCAnWBo7` = `PROD - Sub - Manage Research Reports` (map says *Tool - QA Chapter*); `Ugc2BonNNMCoeXP0` = `PROD - Data: AI Scraping Pipeline` (map says *Tool - Format Kindle Book*); `dk75OYTASeu6NkTr` = `PROD - Sub - Token Usage Tracker` (map says *Tool - Write Short Story*). **`scripts/promote-dev-to-prod.py` reads this to rewrite `executeWorkflow` refs — treat the promotion path as unsafe until regenerated** |
| D4 | F2 newsletter PROD cutover gated | 🟡 | Needs migration 024 + the `newsletter-archive` bucket + PROD env verification |
| D5 | Migrations 013/014/016/017 PROD status contradictory | 🟡 | [[migrations]] table says NO; [[log]] 2026-05-28 says applied. Needs a `pg_dump --schema-only` check |
| D6 | Migrations 024/025/026 applied to DEV only | 🟡 | |
| **D7** | **E2E is not a required check** | ⚠️ | Issue #3, open since 2026-04-18. The 173-test UI suite and 157-test engine suite gate nothing |
| D8 | PR #113 open since 2026-06-02 | 🟡 | |
| D9 | `CRON_SECRET` unset on both tiers | 🟡 | |

---

## E. Unintegrated subsystems

| ID | Item | St | Detail |
|---|---|---|---|
| **E1** | **n8n is the only producer of `content_ingestion_v2`** | ❌ | **DECIDED 2026-10-15 — port to the engine, then turn n8n off.** See Decisions above. A3 + A4 are prerequisites |
| E2 | n8n embeddings workflows are the real embedder | ❌ | See **A3** |
| E3 | n8n `Sub - Token Usage Tracker` still active | 🟡 | See **A4** |
| **E4** | **AI Dev Roundup / TechAhir — ~15 active workflows** | 🟡 | `Dev Radar`, `Social Studio`, `Weekly Digest`, `Trend Radar`, `AI & MVP Content Studio`, Blotato publishers, scheduled-blog crons, `Sub - Manage Scheduled Posts`, 2 RSS webhooks. Shares this n8n instance, the Anthropic credential and the `scheduled_blogs` queue; calls WW `/api/newsletter/render-html` but is otherwise separate. **Needs a separation plan before the instance is wound down** |
| E5 | Unrelated tenants on the same n8n | 🟡 | CSHSE ×4, Upwork proposal generator ×4, Mermaid generator, KIE.AI demo. Blast radius + noise. Out of scope for "turn off n8n" |
| E6 | StealthGPT humanizer | ❌ | `Sub - Humanize (StealthGPT)` (`pDg5IB8eXlmG3K3z`) built; **credential never attached, never tested**; engine integration designed only |
| E7 | Draft Review Kit | ❌ | 13 lenses + Follett fiction guardrails vendored ([[draft-review-kit]]); the `chapter.review` op is designed, not built |
| E8 | Blotato LinkedIn silent failure | ⚠️ | 422 code 5002 "connection expired" surfaces to the user as "Posted" |
| E9 | Substack / RSS feeds | 🟡 | Two active webhook feeds; no WW or engine route |

---

## F. Data & schema debt

| ID | Item | St | Detail |
|---|---|---|---|
| F1 | `app_config_v2` is per-user with an FK on `user_id`; **two conflicting `recipient_email` rows**; no global scope for shared settings | 🟡 | The engine now correctly queries `app_config_v2` (G2 repaired, `library_helpers/email_recipients.py:39`), but the global-scope problem remains |
| F2 | `story_bible_v2` ~1000 polluted rows | 🟡 | See **A6** |
| F3 | `outline` JSONB has no schema validation | 🟡 | Field-aliasing bugs already bit (segment blank-body, brief↔beat). See [[base-tables]] |
| F4 | 17+ meta tables and growing, because base tables are immutable | — | By design per [[base-tables]]; noted as accumulating cost |

---

## G. Security hygiene

| ID | Item | St | Detail |
|---|---|---|---|
| **G1** | **Plaintext user passwords committed in the vault** | ⚠️ | [[credentials-map]] carries live passwords, and the vault sits inside the git repo |
| G2 | Unrotated since May: PROD Postgres password + 4 API keys that transited a chat stream | ⚠️ | `scripts/NEXT_SESSION_PROMPT.md` carry-forward |
| **G3** | **Insecure defaults in code** | ⚠️ | `config.py:25-26` — `service_shared_secret="dev-service-secret-change-me"`, `admin_token="dev-admin-token-change-me"`. An environment that forgets to set these is open |
| G4 | No log redaction | ❌ | See **C3** |
| G5 | n8n API key duplicated across `.env`, `.mcp.json` and 2 Railway services | 🟡 | See [[credentials-map]] |

---

## H. Test & CI debt

| ID | Item | St | Detail |
|---|---|---|---|
| **H1** | **No engine CI exists** | ❌ | `.github/workflows/` contains only `ci.yml` + `release.yml`. No Python lint/mypy/pytest job anywhere. The `engine-ci.yml` recorded in [[log]] 2026-05-30 is not in the repo |
| H2 | Required checks on `main` give the engine zero coverage | ⚠️ | `TypeScript & Lint`, `Unit Tests`, `Production Build`, `Schema Governance Check` |
| **H3** | **L5 parity was never measured** | ❌ | The ≥0.95 parity score is the stated precondition for every cutover ([[engine-framework-sprints]] F1-7.5 / [[engine-api-system-tests]]) |
| H4 | L6 load/scalability suite never run | ❌ | See **B11** |
| H5 | The 157-test engine E2E is a manual script, not CI | 🟡 | `scripts/e2e_full_verify.py` |
| H6 | `ci.yml` has a `paths` filter, so some PRs cannot satisfy required checks | 🟡 | See [[ci-pipeline]] |

---

## I. Never started (feature-level)

| ID | Item |
|---|---|
| I1 | Stripe ([[planned-sprints|Sprint 9]]) — `POST /api/credits/purchase` grants credits with **no payment** |
| I2 | B2B platform: tenants / API keys / usage metering / SDKs / docs ([[productization]], Sprints 23–27) |
| I3 | Cross-chapter continuity (Sprint 21) — the advertised "new capability" |
| I4 | [[chapter-optimization-sprint|F2.5]] chapter-algorithm optimisation (~25 pts) |
| I5 | Sprint 14 storage decision |
| I6 | [[sprint-15-testbed]] + the LLM bake-off — so **model choices are unvalidated** |
| I7 | CR-010 B3 buttons: run research, repurpose to social, generate image, story-bible CRUD |
| I8 | Auto-trial on signup skip — users who skip tier selection get `credits=0` and every chat 402s |
| I9 | Supabase Auth Site URL / redirect URLs still factory `localhost:3000` → **password reset is broken on both tiers** |
| I10 | Google OAuth; cron health dashboard; `_scanner_exclusions` UI; Eve KB cleanup cron |

---

## Gate plan

Four gates, ordered so each makes the next measurable. This **supersedes** the five-gate ordering in
[[work-ordering-2026-05]], which assumed construction work that is already done and omitted the
foundations that are not.

### Gate 0 — Stop lying to ourselves (days, not weeks)

**B1** process supervisor · **B2** real health + readiness checks · **H1** engine CI (pytest + ruff +
mypy) promoted to a required check · **A1** fail loud instead of returning a fixture · **G3** remove the
insecure secret defaults.

Nothing below is trustworthy until these land, because today a broken engine reports healthy and no gate
catches it.

### Gate 1 — Make one user provably correct

**B10** collapse 21 → 3 processes (also fixes **B3** and **A5**) · **A2** real newsletter prompts ·
**A3** embeddings on · **A4** full token accounting · **A9**/**A10** remove dead paths · **A6** bible
cleanup.

Exit: run **H3** and get an actual L5 parity number.

### Gate 2 — Make the scaling story real

**B4** split heavy/interactive queues · **B5** per-op timeouts + DLQ · **B6** prove idempotency ·
**B8** per-provider budgets · **B13** HA Redis + alerting (**C1**, **C2**).

Exit: run **B11** — actually load-test 10 and 20 concurrent users. That measurement decides
**B7**/**B12**, settles whether any step gets peeled out of the B10 container, and tells us what 50
users costs.

### Gate 3 — Ship it

**D3** regenerate the workflow ID map *first* (it is currently dangerous) · **D5** verify PROD migrations
· **D2** run the F1-7.5 acceptance gate + shadow period · cut PROD over and close the 3.5-month gap
(**D1**) · **D4** F2 newsletter PROD cutover.

### Gate 4 — Turn n8n off

**E1** port ingestion + the genre-loop scheduler to the engine · verify **A3**/**A4** carry the
embedding and token-tracking duties n8n was doing · **E4** separation plan for the parallel content
system · archive (do not delete) the replaced PROD workflows with a 90-day rollback window per
[[workflow-tiers]].

**A8** (pointing PROD Eve at the engine) is baseline-protected and needs explicit authorisation — it is
sequenced with Gate 4 but gated separately.

---

## Deferred

**BYOK** (per-user Anthropic/Perplexity/Gemini keys + monthly feature-based subscription) was scoped in
this session's predecessor and **deferred** — too many loose pieces to build on. The structural findings
stand for whenever it returns: the `LLMRouter` is a process-level singleton keyed to env vars
(`llm/factory.py:12`), `AnthropicBudget` is keyed `(model, kind)` with no per-key dimension, the Sprint-8
credit model meters *our* cost rather than plan entitlement, and **BYOK cannot be expressed in n8n
credentials at all** — so it depends on Gate 4 completing first.

---

## See also

[[engine-framework]] · [[engine-framework-sprints]] · [[engine-e2e-parity-sprints]] ·
[[engine-chat-e2e-suite]] · [[engine-api-system-tests]] · [[f1a-decisions]] · [[scaling-architecture]] ·
[[queueing-architecture]] · [[work-ordering-2026-05]] · [[python-migration-roadmap]] ·
[[planned-sprints]] · [[completed-sprints]]

Change requests this page consolidates: CR-003 (scaling), CR-007 (token accounting), CR-010 (parity
completion + UI wiring + multi-engine scale) in
[`writers-workbench/docs/change-requests/`](../../../../writers-workbench/docs/change-requests/).
