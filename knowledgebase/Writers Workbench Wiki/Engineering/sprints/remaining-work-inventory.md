---
name: Remaining work inventory (engine completion + scale to 50 users)
description: Evidence-backed inventory of everything left to finish in the Writers Workbench engine, categorised A–I by workstream with per-item status (not implemented / partial / implemented-but-wrong). Includes the two decisions taken 2026-10-15 — ingestion moves to the engine and n8n is turned off (E1), and the runtime container collapses 21 processes to 3 rather than splitting into per-step Railway services (B10). Supersedes the sprint-status framing in planned-sprints and python-migration-roadmap.
type: concept
tags: [sprints, engine, inventory, scaling, parity, remaining-work, gate-plan, 2026-10]
last_reviewed: 2026-10-18
---

# Remaining work inventory

Audited 2026-10-15 against the **live repo, live n8n, and both Railway tiers** — not against the planning
docs. The planning docs are stale in ways that matter (see §0), so every item below cites code, a live
API response, or an n8n query.

**Driving question:** the engine must be complete and optimised enough to onboard additional users. The
working assumption going in was that it may not yet handle *one* user correctly, let alone 50. Three
findings confirmed that concern — **all three are now fixed (Gate 0, 2026-10-16)**:

- The runtime container launched **19 step services + an arq worker as unsupervised `&` background shell
  jobs** — if one died, nothing restarted it (**B1** ✅).
- `/admin/health` returned `{"status":"ok"}` **unconditionally** and checked nothing — and neither
  `railway.*.toml` declared a `healthcheckPath`, so Railway was not probing the engine at all (**B2** ✅).
- **The engine had no CI.** `engine-ci.yml` — which [[log|the F0 log entry]] claims was delivered — did
  not exist in the repo, so ~350 Python tests gated nothing (**H1** ✅).

> **What H1's absence had already cost, measured on 2026-10-16:** the engine had drifted to **61
> unformatted files, 3 ruff errors and 45 mypy errors**, including **three latent `None`-crash bugs**
> (an unguarded `str | None` into the gateway's write-URL builder; two double-`.get()` patterns whose
> `isinstance` guards never narrowed, one of them in the Postal error path that previously let the
> newsletter saga report SENT having mailed no one). Tests were green throughout — the defects were in
> paths tests did not cover. This is the concrete argument for Gate 0 preceding everything else.

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
| **A1** | ~~Fixture fallbacks fabricate deliverables~~ | ✅ **DONE** 2026-10-16 — gated on `ALLOW_FIXTURE_FALLBACK` (default false). Fixed centrally: 23 of the 29 sites funnel through one `raise` in `LLMRouter.complete`, which now raises the new `ProviderNotConfigured` — deliberately NOT a subclass of `ProviderNotRegistered`/`KeyError`, so no fixture handler catches it and no site can opt back into faking success. 6 non-router sites got explicit guards. | `research_step/main.py:70` returns `"(stub answer for: …)"`; `media_step/main.py:186,286`; `_fixture()` in `subject_step:18`, `segment_step:18`, `assemble_step:26`, `brainstorm_step:121`, `pick_step:21`; `library_step:57,202,542` return `{"fixture": True}` | The `ProviderNotRegistered` narrowing stopped *real* LLM errors being masked, but a *misconfigured key* still produces fake success. Only `media_step:264` was hardened against persisting a fixture. **Highest-priority correctness risk** |
| **A2** | ~~Newsletter steps run on placeholder prompts~~ | ✅ **DONE** 2026-10-16 — every prompt-using step now renders the real brief: pick 15,234 · segment 15,700 · other_top_stories 10,232 · intro 6,604 · subject 5,521 chars. Saga fields threaded (corpus + date to subject; subject_line/pre_header/date to segment and assemble; intro now gets full sections, not titles). `image` deliberately not wired — `image_step` uses no prompt. See §A2 | `prompt_store/n8n_seeds/__init__.py:5-7` — verbatim prompts load under `n8n_baseline.*` and "the step services keep using the placeholder seeds until the token-mapping work in Sprint 17 lands"; `prompt_store/seeds.py:3` "minimal … placeholders" | Severe, and measured 2026-10-16: the picker's live prompt is a **2-line stub** ("Pick the top {max_stories} stories") against a **15.7k-char editorial brief** sitting unused in `n8n_baseline.*` — which encodes catchiest-first, no AI-safety stories, no course ads, no duplicate company/subject, dedupe sources into one slot. Newsletter L5 parity is structural only, not prompt-fidelity. Chapter steps are unaffected (richer `follett_seeds.*`) |
| **A3** | ~~Embeddings / canon grounding off~~ | ✅ **DONE** 2026-10-16 — migration 027 **applied to DEV** and verified against the live 384 vectors; flag enabled; `chapter.write` retrieves canon into its CACHED system block; new `index_project_canon` producer (nothing wrote the table before) with a coverage guard. See §A3 | `config.py:95` `ENABLE_PYTHON_EMBEDDINGS=false`; `re_embed_project` exists but nothing triggers it; n8n `Sub - Embed Project Data` is the live embedder | CR-010 A2: "a quality-parity gap, not just a feature gap." **Blocks E1** |
| **A4** | ~~Token accounting is chapter-only~~ | ✅ **DONE** 2026-10-16 — moved into the step-service template, so all 19 steps and any future one are covered by one owner. `workflow` label is `<step>.<op>`; usage injected where `task_email` reads it, so token usage now appears in EVERY completion email; flushed on failure paths too (a step that burned tokens then failed still cost money). | `begin`/`flush` called only in `chapter_step`; brainstorm, research, media and the newsletter steps write no `token_usage_v2` | CostDashboard under-reports; credits were never calibrated (CR-007's "exact tokens-per-credit" is still unmeasured). **Blocks E1** |
| **A5** | ~~Prompt hot-reload cannot work~~ | ✅ **DONE** 2026-10-16 — B10 collapsed the 19 stores to one, plus a correct fan-out: the gateway cannot reach the steps process (localhost-bound in the runtime container), so it fans out to the orchestrator, which owns that hop. | `PromptStore` is a module global (`prompt_store/store.py:65`); each of the 21 processes holds its own. `/admin/reload-prompts` on the gateway reloads nothing that generates text. `reload_from_supabase` swallows every exception and returns 0 (`store.py:44-50`) | Prompt tuning — the main quality lever — has no working production path. **B10's collapse largely fixes this** |
| **A6** | ~~Story bible polluted~~ | ✅ **DONE** 2026-10-16 — decision: **engine vocabulary is canonical**. The bug was in the UI (a hardcoded list *filtered out* 72% of rows); it now groups by types actually present. 493 duplicate `research` rows retired (soft, reversible) after verifying their text exists verbatim in linked reports. Live rows now **97% canonical**, zero destructive deletes. See §A6 | ~1000 rows / 297 `character` dupes remain after the junk filter; `story_bible_step` has add/list but the catalog routes only `story_bible.list`; no edit/delete; `StoryBiblePanel` is read-only | Story Bible tab shows garbage and users cannot fix it |
| **A7** | ~~Drift detector over-flags~~ | ✅ | **DONE 2026-10-19.** Re-measured against the 96 stored reports rather than the inventory's figure: 85 findings over 29 chapters (45 story / 40 character), of which **16** were 'the outline beat does not include X' where X was consistent with the beat — one chapter flagged for naming the thread a quilter uses, which is the period detail the research seeds ask for. Cause: the ADDITIVE carve-out existed for `character_drift` only, so anything the outline had not enumerated read as story drift. Prompt now states a beat is a plan, not a shot list. Deliberately NOT a new regex: `is consistent with` was the obvious pattern and one finding carrying it is a genuine 1738-vs-1740s period contradiction | Each false positive sets `aligned=False`, which triggers a full streamed rewrite of the chapter |
| **A8** | **Eve callback is a gated dry run** | ❌ | `writer_engine/eve.py:114` returns `{"dry_run": True}` when `ELEVENLABS_API_KEY`/`AGENT_ID` are unset — they are unset by design. PROD Eve still calls the n8n PROD hub | Voice is the headline feature and is not on the engine. Pointing PROD Eve at the engine is baseline-protected and needs explicit authorisation |
| **A9** | ~~Dead ops still routable~~ | ✅ **DONE** 2026-10-16 — `brainstorm.chapter` (returned `{"beats": []}` unconditionally) removed; unknown ops now `UNKNOWN_OP`. `library_retrieve_step` deprecation-marked rather than removed: not in the hub catalog so unreachable by users, and still the only L2 test of the orchestration primitive. | CR-010 A4: `brainstorm_step.chapter` returns empty beats (superseded by `chapter.plan`) but remains in OPS → misroutes. `library_retrieve_step` (the F0 demo, superseded by `library_step`) still runs on `:8002` and returns `fixture-1`/`fixture-2` | Silent wrong answers |
| **A10** | ~~Two newsletter orchestrators coexist~~ | ✅ **DONE** 2026-10-16 — `/pipelines/newsletter/run` drives the sync orchestrator, which **auto-resolves all three HITL gates** (it would send with no human review) and was reachable by any holder of the service secret. Now 410s unless a test installed the hook; production already used `run-durable`, and a test guards that wiring. | `newsletter_orch.py:316` — "placeholder — the gate is held until the resume endpoint fires (real impl in F3)" — alongside the durable `newsletter_saga.py` | Ambiguity about which path actually runs |
| **A11** | ~~Newsletter cadence ignores time-of-day / day-of-week~~ | ✅ | **DONE.** Time-of-day was already honoured (`is_due` receives `cadence_send_time` + timezone). The weekday was worse than recorded: the edition editor's own placeholder reads **'09:00 fri'**, that string matched no accepted format, and the parser returned MIDNIGHT — so following the UI's hint moved the send to 00:05. `parse_schedule` now reads a weekday beside the time in either order and `next_due_at` carries the due date forward to it, forward only | The scheduling UI was not ignoring the field, it was inverting it |
| **A12** | **`/v1/*` B2B surface is a stub** | ❌ | `auth/api_key.py:17` `tenant_id="tenant-stub"`; `gateway/routes/v1.py` "F0 stub" | Acceptable for now — just do not count it as built |

---

## B. Scale — blockers to 50 users

| ID | Item | St | Evidence | Impact |
|---|---|---|---|---|
| **B1** | ~~19 step services + arq worker run as unsupervised `&` background jobs~~ | ✅ **DONE** 2026-10-16 | Replaced by `writer_engine.supervisor` (`python -m writer_engine.supervisor`); process table in `writer_engine/runtime_processes.py`; `entrypoint.sh` is now a 1-line `exec`. Fail-fast: any child exiting stops the rest and exits non-zero, so Railway (`restartPolicyType=ALWAYS`) restarts clean. Written in Python because `wait -n`/`declare -A` need bash ≥4.3, which macOS does not ship — the shell version could not be tested outside the container | 9 unit tests on real subprocesses + a live smoke run that killed `chapter_step` and confirmed teardown + exit 1 |
| **B2** | ~~`/admin/health` checks nothing~~ | ✅ **DONE** 2026-10-16 | orchestrator `/admin/health` now probes all 19 steps (503 if any is unreachable — a restart is the right remedy for an in-container process); new `/admin/ready` adds Redis (required) + arq heartbeat + Supabase (optional → `degraded`). Gateway keeps flat-OK liveness (stateless proxy) with its orchestrator dependency in `/admin/ready`, so an orchestrator restart does not bounce it in sympathy. New `writer_engine/health.py`. **Also found: neither `railway.*.toml` declared `healthcheckPath`, so Railway never probed the engine at all** — now set on both services | Verified live on DEV: runtime reports 19/19 steps + redis/arq/supabase ok; arq heartbeat visible (`health_check_interval` cut 3600s→30s, since the default let a dead worker look alive for an hour) |
| **B3** | ~~`MAX_CONCURRENT_LLM` is per-*process*, not per-instance~~ | ✅ | **DONE 2026-10-18** — resolved by B10's collapse and now pinned by a test. Verified by inspection: only step modules call `get_router`, and every step runs in the one `steps_app` process, so there is exactly one `LLMRouter` and one semaphore per container. The arq workers reach steps over HTTP and never call a provider. `tests/test_llm_concurrency_cap_b3.py` fails if either changes | The documented cap of 12 was really up to 12 × N processes, and **CR-003's "~10 users per instance" sizing had no basis**. A worker that starts calling an LLM, or a step peeled back into its own service, would silently restore that behind a configured 12 |
| **B4** | ~~One arq queue for everything~~ | ✅ **DONE 2026-10-16** — two queues (`engine-heavy` 8 slots / `engine-interactive` 24 slots), one arq worker each, routed by `(tool, op)` | `orchestrator/worker.py:87` `queue_name="newsletter"`, `max_jobs=16` — newsletter sagas, chapter writes, Q/A, plan, cover-art and lifecycle share 16 slots | A 96-chapter batch starves every interactive op (CR-010 C3) |
| **B5** | ~~90-min timeout × 2 tries, uniform across ops~~ | ✅ **DONE 2026-10-16** — per-queue `job_timeout` (5400s / 600s) + a capped Redis DLQ at `GET /admin/dlq`, recording crashes AND returned step errors | `worker.py:97,99` `job_timeout=5400`, `max_tries=2` | 16 stuck jobs = a 3-hour total stall. A Q/A needs seconds, not 90 minutes. No dead-letter path |
| **B6** | ~~Retry idempotency unproven outside `chapter.write`~~ | ✅ **DONE 2026-10-17** — run ledger (`engine_job_runs`, migration 028 **applied**); a duplicate `run_id` replays instead of re-running. Verified live | `run_write_tool_job` is retried by arq; only `chapter.write` is keyed on `chapter_run_id`. brainstorm/research/media persist and lifecycle are unverified | A retry after partial success duplicates rows |
| **B7** | **Multi-instance has never been run** | 🟡 | **Graceful drain DONE 2026-10-18** (`writer_engine/drain.py`): the supervisor raises a container-local flag on SIGTERM, holds it `DRAIN_READINESS_DELAY_S` so a readiness probe fails and the LB stops routing, then terminates. `/admin/ready` reports `draining` — distinct from `unhealthy`, because the remedies are opposite and the watchdog pages CRITICAL on the latter — and the watchdog skips its ticks while draining. arq workers now carry `job_completion_wait` (`drain_wait_s`: heavy 30s, interactive 20s), so SIGTERM stops them picking up work and lets in-flight jobs finish. **And the platform had to be told to allow it:** Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0** — SIGTERM then immediate SIGKILL — so every line of the drain would have been dead code. Set to 60 on both DEV engine services 2026-10-18; **a PROD cutover must set it too**. **Still open:** a second replica has never actually run, and cross-instance arq single-delivery is still unverified — that needs a Railway replica change | A deploy mid-chapter used to lose a 90-minute job (CR-010 C1). A heavy job that cannot finish inside the platform's grace period is re-queued, which is only safe because of B6's run ledger |
| **B8** | ~~Per-provider shared budgets missing~~ | ✅ **DONE 2026-10-16** — Redis-shared RPM/TPM budgets for gemini / perplexity / openai / firecrawl / kieai / stealthgpt, plus 429 retries where there were none | Only Anthropic has a Redis-shared budget (`rate_limit/anthropic_budget.py`). OpenAI, Perplexity, Gemini, Firecrawl and KIE.AI have none; CR-003 still lists the Perplexity limiter as outstanding | Fan-out at 50 users will 429 those providers |
| **B9** | **Account-wide Anthropic TPM is a hard ceiling** | 🟡 | **The lever now exists (2026-10-18).** It did not before: `hybrid-draft-polish` was in the public schema and named here as B9's fix, and the resolver was a two-entry dict for haiku/sonnet — so every hybrid request fell through to Sonnet-for-everything and the lever did nothing. `model_plan()` now returns a **(draft, polish)** pair: the sub-chapter fan-out (almost all the output tokens) drafts on Haiku while the plan, drift correction and craft revision stay on Sonnet. Output TPM is **per model family**, so this is the only way to add throughput without changing accounts — the Burial Mound run sat at Sonnet's 90k with Haiku's whole budget idle. `CHAPTER_LLM_STRATEGY` sets what `tier-default` means, so the lever is an env flip, not a deploy. **Still open:** the default remains `sonnet` (what B11 load-tested) because the quality comparison has not been run | Tier-4 Sonnet = 90k output TPM ≈ **5 chapters/min** ([[f1a-decisions]]). 50 concurrent heavy users queue rather than fail — but they queue. Remaining levers: a higher tier, or BYOK (deferred) |
| **B10** | **Per-step independent scaling defeated by deployment** | 🟡 | All 21 steps in one image (locked in F1 as "no new Docker images", deferred to F3) | **RESOLVED — see Decisions above.** Collapse to 3 processes; defer the split until Gate 2 data |
| **B11** | ~~No load test has ever been run~~ | ✅ **DONE 2026-10-16/17** — `scripts/load_test.py`; 10 users 20/20, 20 users 40/40, 20+6 heavy 46/46 after two fixes it found. Re-run on HA Redis | [[sprint-15-testbed]] never executed; CR-003's "load test (L6) at 10 + 20 concurrent users" still open; `engine/load/k6_smoke.js` is scaffold | **Every capacity number in the docs is a guess.** Nothing has validated 10 users |
| **B12** | ~~No autoscaling policy and no queue-depth metrics to drive one~~ | ✅ | **DONE 2026-10-18** — `writer_engine/queue_metrics.py` samples each queue in **three Redis round trips** (`ZCARD`; the arq worker's own heartbeat for `j_ongoing`; `ZRANGE … WITHSCORES` for the oldest item's eligible-at score), publishes five Prometheus gauges from the orchestrator's 30s timer, and serves `GET /admin/queues`. **The policy is the substance:** depth on the heavy queue reads as `tpm_bound` (per B9 a replica shares the same account budget and writes no faster) while interactive saturation **with a waiting queue** reads as `scale_out`. Saturation alone is not a signal — 24/24 slots clearing in seconds is a queue doing its job | CR-010 C4. "Add an instance" was guesswork, and the obvious rule (scale on depth) would have been a bill rather than a fix. Also fixed `/admin/dashboard`, which asked Redis for the status of every queued job — one round trip per job, so it got more expensive the worse the backlog it exists to diagnose |
| **B13** | ~~Redis is an un-alerted SPOF~~ | ✅ **DONE 2026-10-17** — DEV Redis is now HA (HAProxy + 5 nodes, AOF). Watchdog + log-only alerting; HITL gates readable from Postgres so a Redis loss no longer orphans an approval | Queue, Anthropic budget, HITL gates, SSE pub/sub, sessions and the idempotency cache all live on it. Not HA. It died silently for 9 days in May (auto-memory `project_prod_redis_outage_risk`; [[log]] 2026-05-28) | A single failure takes the engine down invisibly |

---

### §A2 — the newsletter prompt migration, scoped

Audited 2026-10-16. **8 prompts** in `n8n_baseline.*` (not 16), 1.8k–16.5k chars each, 2–7 n8n
expression tokens apiece. Every token resolves to a value the Python steps already hold, so this is a
mechanical rewiring rather than a redesign:

| n8n expression | Python source |
|---|---|
| `new Date(…Date).format("yyyy-MM-dd","America/Chicago")` | the run's newsletter date |
| `$('set_trigger_inputs').item.json["Previous Newsletter Content"]` | previous newsletter content |
| `$('combine_markdown_content').item.json.content_result` | the gathered markdown corpus |
| `$('combine_tweet_content')…` | **N/A** — no tweet ingestion in the engine; substitute `"N/A"` |
| `$node["set_current_stories"]…top_selected_stories` | picked stories JSON |
| `$('subject_examples').item.json.subject_line_examples` | subject-line examples |
| `$node["set_selected_stories"].json.subject_line` / `.pre_header_text` | subject / pre-header |
| `$node["set_current_segment"].json.current_story.title` / `.summary` | the current story |
| `$node["aggregate_segment_text_content"]…join("\n\n")` | segment source text |
| `$('aggregate_segment_external_source_content')…` | scraped external sources |
| `$('set_combined_sections_content').item.json.story_sections` | assembled sections |
| `$node["share_*_approval_feedback"].data.data.text` | HITL revision feedback |
| `$('stories_prompt')…` / `$('set_subject_line_prompt')…` | the original prompt (edit variants) |
| `JSON.stringify($node["pick_top_stories"].json.output)` | the prior output being revised |

**Mechanism note:** do NOT render these with `str.format()`. Three prompts contain literal `{`/`}`
(JSON examples), which `.format()` would misparse and which forces error-prone brace doubling.
Translate `{{ expr }}` → `${field}` and render with `string.Template`, which ignores stray braces.

**Sequencing:** A2 and A3 are the two items whose effect is only visible through the **L5 parity
harness (H3, never run)** — which is also Gate 1's stated exit criterion. Run the harness first, then
migrate against it, or the result is unmeasurable. Two of the eight prompts (`edit_top_stories`,
`edit_subject_line`) drive the HITL revision loops, which F2 (auto-memory `project_f2_newsletter_saga_complete`)
records as never exercised (S-12), so they need a live revision run too.

### §A3 — embeddings was never a flag flip (re-diagnosed 2026-10-16)

Recorded as "code exists, flag off". Probed against DEV Supabase:

- **`writing_documents` does not exist** in either project. `embed.py` read AND wrote it. The real
  table is `writing_embeddings_v2` — 384 rows, populated by n8n `Sub - Embed Project Data`.
- `re_embed_project` filtered on `project_title`; the real scoping column is `project_id`.
- **No vector-match function exists**, under `match_writing_documents` or any related name, even
  probed with the exact parameter names the code sends (PGRST202 every time). n8n searched through
  the Supabase Vector Store node's own SQL, so a stored function was never created.

Enabling the flag today would have 404'd on every call. Retrieval has to be **built**.

Done: `embed.py` corrected (real table via `EMBEDDINGS_TABLE`, scoped by `project_id`, search renamed
`match_project_canon`), `EMBEDDING_MATCH_RPC` default aligned, search degrades to `[]` on RPC failure
so a chapter write still produces a chapter. **Migration 027** creates the missing function —
additive, governance-clean, **not applied** (DEV needs the pooler DSN; the engine `.env` has REST
credentials only. PROD is Tier 3).

Remaining: apply 027, then trigger re-embed after outline saves and wire retrieval into
`chapter.write`. Neither is testable until the function exists.

### §A6 — story bible is a 3-way vocabulary mismatch (re-diagnosed 2026-10-16)

Recorded as "~1000 polluted rows, 297 character dupes". Measured on DEV: 3245 rows (3226 live), **21**
true duplicate groups → 21 redundant rows, but **2341 rows (72%)** carry an `entry_type` outside the
table's CHECK. Three layers disagree, and only `character` and `event` are common to all three:

| layer | vocabulary |
|---|---|
| table CHECK | character · event · item · location · organization · plot_thread |
| engine `BibleEntry` Literal | character · event · **object** · **place** · **concept** (+ **research**, written ad hoc by `chapter_step:1463`) |
| client `types/database.ts` | character · event · location · **timeline** · plot_thread · **world_rule** |

That is why the Story Bible tab hides most of what exists, and why `ProjectDetail.tsx` already
carries an `isJunkBibleName` client-side workaround. **The root cause is the contract, not the data.**

`scripts/story_bible_normalize.py` diagnoses and (with `--apply`) normalises by `UPDATE`, never
`DELETE`. Two mappings are unambiguous and are its defaults: `place → location` (423),
`object → item` (706). **Two need a decision and are deliberately not guessed:**

- **`concept` (719)** — no table equivalent. `plot_thread` is closest but not the same thing;
  `world_rule` (client-only) is arguably closer; adding `concept` to the CHECK is also defensible.
- **`research` (493)** — arguably not a bible entry at all; these look like research-topic records
  that may belong in `research_reports_v2`, or be dropped. 493 destructive deletes are not defaulted.

Once the canonical vocabulary is settled, fix it at the source (the engine Literal, the extract
prompt, and the client type) before normalising the data, or it re-pollutes.

### §A13 — chapters had no scene breaks (found by H3, FIXED 2026-10-16)

The parity harness's first run: `word_count` agreed 6/6 and `content_text` 6/6, but
`sub_chapter_count` failed 6/6 — engine 1, n8n 2–14. Across **all 96** engine chapters the count was
identical, which is deterministic, not generation variance. Sub-chapters were joined with a bare
blank line, so every chapter read as one undivided block while the n8n baseline's carried 1–13
breaks. It matters because `follett_seeds.scene.bme_check` / `scene.turn_density` exist to enforce
scene construction and a story turn every 4–6 pages, and the short-story op already instructed
"use --- between scenes" — chapters were simply never told.

Fixed structurally (`SCENE_BREAK.join`), so N sub-chapters deterministically yield N−1 breaks rather
than relying on an advisory instruction. **Residual:** when the drift-correct pass fires a streamed
revision it rewrites the whole chapter and may not preserve the separators; that path only triggers
on real drift, so most chapters keep them — confirm on the next live run.

## J. Found 2026-10-17 (HA Redis cutover, story-memory audit, humanizer)

| ID | Item | St | Detail |
|---|---|---|---|
| J1 | **Canon index covers 4 of 26 projects** | 🟡 | `index_project_canon` fired only on a brainstorm outline save, so every project created before A3 had none. **Partly resolved 2026-10-18:** that is no longer the only trigger — `reindex_if_stale()` runs once per project per process on the chapter-write path, comparing the newest canon row against the newest canon INPUT (K4). The Burial Mound's own index was additionally blocked by K3. **Still open:** a backfill loop for the other 22 projects |
| J2 | **A13 scene breaks unverified on a live write** | 🟡 | The em-dash backstop was deleting the separators and leaving `", -"` in the prose; fixed 2026-10-17, but **no chapter has been written since**, so N sub-chapters → N−1 breaks is still unproven end to end. One chapter settles it |
| J3 | ~~Prose never enters the canon index~~ | ✅ **DONE** — `index_chapter_prose` runs on the write path (`chapter_step/main.py:1769`) and The Burial Mound carries 1,879 `chapter_prose` chunks. K2 is why they survive a canon reindex | `build_canon_chunks` indexes the outline and bible only, so retrieval returns the PLAN, never what was written. Chapter N knows what N−1 was supposed to contain, not what it said. `bridge_from_prior` carries the connection today, which held across 96 chapters of a detailed outline but would not on a thin one. This is the real content of **I3** (cross-chapter continuity) |
| J4 | **Humanizer rejection economics** | 🟡 | ~50% of chunks are rejected on a real blog post and **a rejection still bills**, so a pass costs ~2x the input words for partial application. Candidate fix: retry a `structure_collapsed` chunk once at `Medium` before falling back |
| J5 | **No notification of total engine death** | — | **DECIDED 2026-10-17: accepted for DEV.** Railway's healthcheck (`healthcheckPath = /admin/health`) already restarts the container; nothing reports that it happened. The watchdog cannot — it lives inside the engine. **Required before any PROD cutover**; a scheduled GitHub Action against `/admin/health` is the no-vendor option |
| J6 | ~~DEV ingestion workflow failing every 4 hours~~ | ✅ | **RESOLVED 2026-10-17 with E1.** Root cause confirmed from execution 67920: `get_identity` built the key with `$json.isoDate.substring(0, 10)`, so one feed entry with no `isoDate` emptied it and `/api/ingestion/search` answered 400 `prefix: key is required` — taking every other feed's items down with it. 23 days, zero rows. The port keeps the key shape byte-for-byte and changes only the failure behaviour: a missing date falls back to today, an unslugifiable title skips that one item. The workflow is now deactivated |

## K. Found 2026-10-18 (memory between chapters, scaling levers)

All five found while implementing the two memory items, and every one of them was a feature that
existed on paper and did nothing in practice.

| ID | Item | St | Detail |
|---|---|---|---|
| K1 | ~~Per-chapter research was stored and unreachable~~ | ✅ **DONE 2026-10-18** | A chapter-by-chapter study attached **149 cited facts** to The Ossuary's outline and `build_canon_chunks` never read the `research` field — it built `chapter_brief` from beat/arc_notes/bridge only. The study was in the product and invisible to the writer, whose research came from a live Perplexity pass instead. Now its own `chapter_research` doc type (separately refreshable, separately retrievable, sources inline, `flags` carried through as `CAUTION:` lines). **And** `chapter.write` now reads the chapter's own study **by chapter number** rather than hoping a similarity search returns it — on The Ossuary the query "palisade post molds" returned the studies for chapters 26, 31, 47 and 61. Perplexity is the fallback for chapters with no study. Verified live: 96 `chapter_research` rows, and the facts come back at 0.52–0.65 similarity against the 0.35 retrieval threshold |
| K2 | ~~A canon reindex deleted the prose index~~ | ✅ **DONE 2026-10-18** | `index_project_canon`'s delete was scoped to `(user_id, project_id)` with **no doc_type filter**, so it took `chapter_prose` — written by a different indexer with a different lifecycle — with it. The Burial Mound carried **1,879 prose chunks** that any canon reindex would have wiped, to return one chapter at a time as each was next written. Both the delete and the coverage count now narrow away prose |
| K3 | ~~The coverage guard locked reindexing out of the biggest project~~ | ✅ **DONE 2026-10-18** | Because prose counted toward `existing`, The Burial Mound's ratio was 1,117 canon / 2,996 total = **0.373**, below `MIN_REINDEX_COVERAGE` (0.6) — so the guard raised `RuntimeError` and **refused to reindex at all**. J1's backfill had locked reindexing out of the project it was built for. Counted over canon doc types only now |
| K4 | ~~The freshness probe read a column nothing writes~~ | ✅ **DONE 2026-10-18** | `writing_projects_v2.updated_at` has no trigger and none of the writers set it: on The Ossuary it still equalled `created_at` after **eight** outline versions, the newest 16 hours later. A staleness probe built on it reported "fresh" forever. `canon_staleness` now takes the newest of `project.updated_at`, `outline_versions_v2.created_at` (every outline write snapshots the prior one, so this is the signal that moves) and `story_bible_v2` — which changes with no outline write at all, and was why the live index held **1 of 77** bible entries. The four engine outline writes also set `updated_at` now, with a test that walks the tree |
| K5 | ~~Row counts were page lengths~~ | ✅ **DONE 2026-10-18** | The coverage guard and the probe both did `len(rows)` on an unlimited select. PostgREST caps a response at 1,000, so the number plateaus — The Burial Mound's 1,117 canon rows read as exactly 1,000 — making the guard too lenient on precisely the large projects it protects. Both now ask the server to count. (Third time this cap has bitten in two days) |
| K6 | **The stored study is thinner than it looks: 1.55 facts per chapter** | 🟡 | Audited after the K1 fix: of The Ossuary's 96 chapters, **52 carry exactly one fact** and only 44 carry two or more (149 facts / 96 chapters). The first version of the write-path rule discarded a one-fact study and made a Perplexity call instead, which would have thrown away the only cited, reviewed material those chapters have. Now a thin study is **topped up, not replaced** — the stored block and the live block go in labelled separately so the model can tell attributed material from a live search. **Still open:** re-running the study for the 52 thin chapters would make them stand alone |

## C. Observability & reliability

| ID | Item | St | Evidence |
|---|---|---|---|
| C1 | ~~No dashboard~~ | ✅ **DONE 2026-10-17** — `GET /admin/dashboard`: readiness per dependency, per-queue depth/running/waiting, recent dead letters |
| C2 | ~~No alerting of any kind~~ | ✅ | **DONE** — uptime/dependency + DLQ alerting shipped 2026-10-17 (watchdog + Postal, delivery verified). Queue depth and the capacity verdict added 2026-10-19: the two actionable verdicts send a debounced alert naming WHICH lever (a replica vs the Anthropic tier), WARNING not CRITICAL because nothing is broken, and a healthy tick clears the key so the next episode is not swallowed |
| C3 | ~~Provider error strings logged raw; no secret-redaction pass~~ | ✅ | **DONE 2026-10-19** — a structlog processor (`telemetry/redaction.py`) installed immediately before `JSONRenderer`, so it also covers formatted exception text; a test pins that order. Matches the key shapes this engine uses plus the configured secrets, since `SERVICE_SHARED_SECRET` looks like nothing in particular. Values under 12 chars are left alone (they match inside ordinary words). Also closes **G4** |
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
| D9 | ~~`CRON_SECRET` unset on both tiers~~ | 🟡 | **DEV DONE 2026-10-19.** Worse than 'unset': the three lifecycle routes answered 500 MISCONFIGURED *and* nothing called them, so on DEV trials never expired, credits never reset and no warning emails went out. Shared secret set on both DEV services and the engine's scheduler now drives all three hourly, expiry before warnings. PROD still unset |

---

## E. Unintegrated subsystems

| ID | Item | St | Detail |
|---|---|---|---|
| **E1** | ~~n8n is the only producer of `content_ingestion_v2`~~ | ✅ | **DONE 2026-10-17 — the engine writes the table and the 36 DEV Workbench workflows are deactivated.** New `writer_engine.ingestion` (keys/sources/feeds/enrich/store/pipeline) + an `ingestion` step + migration **029** (`newsletter_feed_sources_v2.item_type`, applied to DEV). Both n8n producers were already broken: `2T3TwGHhdGQlTpQ5` erroring every 4h since 2026-09-24 on an empty key (**J6**), and `JAQ8rmCaDoddqt2k` "succeeding" every 30 min uploading nothing (its per-feed loop was never wired back) while still stamping all 32 feed rows. First engine tick: 32 feeds, 72 items, 7 rows. Also required the engine's own clock (`writer_engine.scheduler`) and the scheduled publisher — see §E10 |
| E2 | n8n embeddings workflows are the real embedder | ❌ | See **A3** |
| E3 | n8n `Sub - Token Usage Tracker` still active | 🟡 | See **A4** |
| **E4** | **Parallel content system — 17 active workflows** | 🟡 | **Separation plan written 2026-10-17: [[parallel-content-system-separation]]**, with the measured coupling of all 17. The blocker is not automation: **12 of 17 read or write n8n data tables** (the Roundup slate, the scheduled-post queue, the digest both RSS feeds are built from), so winding the instance down deletes application state. Recommended destination: its own Supabase project. Corrections to the earlier note — there is no `scheduled_blogs` table, and nothing in this system calls a WW API (the two RSS feeds use the WW URL only as a `<link>` base). Shares the Anthropic credential, so **G2**'s rotation breaks six of them. Still tracked, not blocking |
| **E10** | **The engine had no clock, and nothing published scheduled content** | ✅ | **DONE 2026-10-17 — found by enumerating what each DEV workflow does, not from this inventory.** (a) `/cron/newsletter-cadence` and the new `/cron/ingestion` were both driven by n8n schedule triggers, so "n8n off" would have stopped the newsletter being generated AND the corpus being refilled, silently — an endpoint nobody calls looks exactly like one with nothing to do. New `writer_engine.scheduler`, three jobs inside the orchestrator, `/admin/scheduler` to prove it ticks. (b) `17 Cron: Scheduled Publisher` was the ONLY thing that ever flipped `status='scheduled'` to published; new `writer_engine.publisher` finds due rows and hands each to the existing `library.lifecycle` action=publish. Keeps `metadata.schedule_date` where n8n deleted it, and carries no hardcoded Supabase key where the n8n code node did. Verified live end to end |
| E5 | Unrelated tenants on the same n8n | 🟡 | CSHSE ×4, Upwork proposal generator ×4, Mermaid generator, KIE.AI demo. Blast radius + noise. Out of scope for "turn off n8n" |
| E6 | StealthGPT humanizer | ✅ | **DONE in the engine 2026-10-17, NON-FICTION ONLY.** Key live on `writer-engine-runtime`; `writer_engine.humanize` wired into blog / newsletter / social at `Low`+`standard`+`markdown`. **Fiction deliberately excluded** — measured on a real scene, both modes destroyed the researched period vocabulary (`maize`→`corn`, `packed earth`→`flat stone`). Guards: `terms_lost`, `structure_collapsed`, per-platform char caps, spend ceiling. The n8n sub (`pDg5IB8eXlmG3K3z`) is now redundant and dies with n8n |
| E7 | ~~Draft Review Kit~~ | ✅ | **DONE 2026-10-17 — `chapter.review` built.** All 13 lenses vendored into `writer_engine/review/skills/` so they ship in the image (the repo copy is outside `packages/writer_engine/src`); MIT LICENSE carried with them. Adaptations: `## Invocation` sections stripped (they tell the model to ask the user what to review), `panel`/`debate` are orchestrators over member lenses plus a synthesis over their findings, `guardrails` forced to fiction mode with the Follett catalogue inlined. Persists to `metadata.review_report`, **not** `qa_report`, so a critique lens cannot drive `rewrite-to-fix-qa`. Queued heavy. Verified live on Burial Mound ch.1: 7 findings quoting the chapter |
| E8 | Blotato LinkedIn silent failure | ⚠️ | **Reclassified 2026-10-17: this is a defect inside E4's system, not the Workbench.** Searched and confirmed — Blotato appears nowhere in the engine or `server/src`, there is no `scheduled_blogs` table, and no "Posted" string in `server/src` or `client/src`, so no Workbench user sees it. The engine's `media.social-posts` drafts into `social_posts_v2` and never publishes. Fix is (a) reconnect LinkedIn in the Blotato dashboard and (b) check the per-channel response `code`, not the batch HTTP status — and (b) edits a live workflow publishing to the user's own LinkedIn, so it is **flagged, not done**. See [[parallel-content-system-separation]] |
| E9 | Substack / RSS feeds | 🟡 | **Reclassified 2026-10-17: not a Workbench dependency.** `/webhook/ai-dev-roundup.xml` and `…-digest.xml` build their XML from n8n **data tables**; they reference the WW URL only as a `<link>` base, not as an API. They are **public URLs feed readers may be subscribed to** and will 404 — not degrade — the moment the instance stops, so they are gated on E4's data-table migration. The existing `Build RSS` / `Build Digest RSS` code nodes are the spec (~40 lines). See [[parallel-content-system-separation]] |

---

## F. Data & schema debt

| ID | Item | St | Detail |
|---|---|---|---|
| F1 | `app_config_v2` is per-user with an FK on `user_id`; **two conflicting `recipient_email` rows**; no global scope for shared settings | 🟡 | The engine now correctly queries `app_config_v2` (G2 repaired, `library_helpers/email_recipients.py:39`), but the global-scope problem remains |
| F2 | `story_bible_v2` ~1000 polluted rows | 🟡 | See **A6** |
| F3 | `outline` JSONB has no schema validation | 🟡 | Field-aliasing bugs already bit (segment blank-body, brief↔beat). **Measured 2026-10-17: two incompatible shapes exist in live data** — 16 projects key chapters on `chapter_number`+`beat`, 10 on `number`+`brief`, and each reader understood only one half. Mitigated by `writer_engine.outline_keys` (both readers now accept either), but the data is still unvalidated and a third shape would repeat it. See [[base-tables]] |
| F4 | 17+ meta tables and growing, because base tables are immutable | — | By design per [[base-tables]]; noted as accumulating cost |

---

## G. Security hygiene

| ID | Item | St | Detail |
|---|---|---|---|
| **G1** | **Plaintext user passwords committed in the vault** | 🟡 | **DEV closed, PROD still exposed (2026-10-19).** Removing the login form did not help: Supabase's `grant_type=password` stays open at the API, and the published value was POSTed to DEV's token endpoint and came back **200 with a session**. DEV auth passwords rotated to random values (same probe now 400); the values scrubbed from every file in the tree. **PROD was not touched and is out of scope — JR's PROD password and Eric's (same value as DEV's) were both published here and should be treated as compromised** |
| G2 | Unrotated since May: PROD Postgres password + 4 API keys that transited a chat stream | ⚠️ | `scripts/NEXT_SESSION_PROMPT.md` carry-forward |
| **G3** | ~~Insecure defaults in code~~ | ✅ **DONE** 2026-10-16 — both secrets default to empty and fail CLOSED with 503 ("not configured"), distinguished from the 401 for a wrong secret. Verified both are really set on DEV before shipping, by probing `/internal` and `/admin` with the old placeholders (both 401). | `config.py:25-26` — `service_shared_secret="dev-service-secret-change-me"`, `admin_token="dev-admin-token-change-me"`. An environment that forgets to set these is open |
| G4 | ~~No log redaction~~ | ✅ | **DONE 2026-10-19** with **C3** |
| G5 | n8n API key duplicated across `.env`, `.mcp.json` and 2 Railway services | 🟡 | See [[credentials-map]] |

---

## H. Test & CI debt

| ID | Item | St | Detail |
|---|---|---|---|
| **H1** | ~~No engine CI exists~~ | ✅ **DONE** 2026-10-16 | `.github/workflows/engine-ci.yml` — uv (pinned 0.5.13 to match `services/runtime/Dockerfile`) → `ruff check` → `ruff format --check` → `mypy` → `pytest`. Green on its first run. **Deliberately no `paths:` filter** so the check always reports and can safely be required (avoids the H6 trap). Suite stays credential-free |
| **H2** | Required checks now cover the engine on `main` | ✅ **DONE** 2026-10-16 | `main` requires `TypeScript & Lint`, `Unit Tests`, `Production Build`, `Schema Governance Check`, **`Engine CI`** |
| **H7** | ~~`develop` has no required status checks~~ | ✅ **DONE** 2026-10-16 — `Engine CI` required on `develop` (`strict: false`). `enforce_admins` was already false and was preserved, so admin direct pushes still work while PRs are gated. The vault's "1 approving review on develop" claim was also stale — there was no review requirement either. | `GET /branches/develop/protection/required_status_checks` → 404 "not enabled". Only a review is required, so engine work can merge to `develop` — the branch DEV deploys from — with CI red. Enabling a new gate class there is a policy call, left for the user |
| **H8** | ~~mypy covers only 4 of 21 workspace members~~ | ✅ **DONE 2026-10-16** — 141 files checked across all members | `pyproject.toml [tool.mypy] files` = `packages/writer_engine/src`, `gateway`, `orchestrator`, `library_retrieve_step`. The other **17 step services are not type-checked at all** — including `chapter_step` and `media_step`. Given that 3 latent `None`-crashes turned up in the *checked* quarter, this is a real gap; expanding coverage will surface a backlog, so it wants its own pass |
| **H3** | ~~L5 parity was never measured~~ | ✅ **DONE** 2026-10-16 — harness built (`run_corpus`/`render_report` + `scripts/parity_run.py`, 3 modes) and RUN. First run found a real craft regression (see **A13**). A failing tool fails the whole run, since the gate is per-tool at cutover. `live`/shadow mode still needed for the true same-input A4 number. | The ≥0.95 parity score is the stated precondition for every cutover ([[engine-framework-sprints]] F1-7.5 / [[engine-api-system-tests]]) |
| H4 | L6 load/scalability suite never run | ❌ | See **B11** |
| H5 | The 157-test engine E2E is a manual script, not CI | 🟡 | `scripts/e2e_full_verify.py` |
| H6 | `ci.yml` has a `paths` filter, so some PRs cannot satisfy required checks | 🟡 | See [[ci-pipeline]]. `engine-ci.yml` deliberately avoids this |

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

### Gate 0 — Stop lying to ourselves (days, not weeks) — **MOSTLY DONE 2026-10-16**

| Item | Status |
|---|---|
| **B1** process supervisor | ✅ done — `writer_engine.supervisor`, fail-fast, 9 tests + live smoke |
| **B2** real health + readiness checks | ✅ done — both services, plus the missing Railway `healthcheckPath` |
| **H1** engine CI promoted to a required check | ✅ done — `Engine CI` green and required on `main` |
| **A1** fail loud instead of returning a fixture | ✅ done — `ALLOW_FIXTURE_FALLBACK`, fixed centrally at the router |
| **G3** remove the insecure secret defaults | ✅ done — empty defaults, fail closed with 503 |

**Gate 0 is COMPLETE** (2026-10-16), all five items verified live on DEV.

Prerequisite work that fell out of H1: 61 files reformatted, 3 ruff errors and 45 mypy errors cleared
(including the three latent `None`-crashes noted at the top). A red pipeline gates nothing, so making it
green was part of the item rather than a separate task.

Two new findings to fold in: **H7** (`develop` has no required checks at all) and **H8** (mypy covers
only 4 of 21 workspace members).

### Gate 1 — Make one user provably correct

| Item | Status |
|---|---|
| **B10** collapse 21 → 3 processes (also fixes **B3** and **A5**) | ✅ done 2026-10-16 — `services/steps_app` mounts all 19 steps in one uvicorn; verified live on DEV |
| **H8** extend mypy to the other 17 step services | ✅ done — 89 → **131** files checked, which surfaced 5 more latent `None` crashes |
| **A9** / **A10** remove dead paths | ✅ done |
| **A4** full token accounting | ✅ done — moved into the step template, so all 19 steps are covered |
| **A2** real newsletter prompts | ✅ done — all 5 prompt-using steps render the real briefs |
| **A3** embeddings on | ✅ done — 027 applied to DEV, retrieval + producer wired |
| **A6** bible cleanup | ✅ done — engine vocabulary canonical; 97% of live rows canonical |
| **H3** L5 parity harness | ✅ done — built, run, found the A13 scene-break regression |

**GATE 1 IS COMPLETE** (2026-10-16). The sequencing call held up: building H3 first is what surfaced
A13, and both A3 and A6 turned out to be mis-sized — in each case the recorded fix could not have
worked, which is the argument for verifying before executing.

Exit criterion met in the sense that the harness now exists and produces a number. The number itself
(0.667 on `recorded` mode) is **not** the A4 gate — that needs `live`/shadow mode on same inputs, and
A13 is the one regression it found so far. Re-run `recorded` once a fresh capture exists post-A13.

### Gate 2 — Make the scaling story real — **COMPLETE 2026-10-16**

**B4** split heavy/interactive queues · **B5** per-op timeouts + DLQ · **B6** prove idempotency ·
**B8** per-provider budgets · **B13** Redis decision + alerting (**C1**, **C2**) · exit via **B11**.

#### What shipped

| Item | Done | Note |
|---|---|---|
| **B4** | ✅ | Two queues (`engine-heavy` 8 slots / `engine-interactive` 24 slots), one arq worker each. Routed by `(tool, op)` — the spread *within* a tool is the problem: `chapter.write` is the longest job and `chapter.qa` one of the shortest. Process table 3 → 4. |
| **B5** | ✅ | Per-queue `job_timeout` (5400s / 600s) + a capped Redis DLQ at `GET /admin/dlq`. |
| **B6** | ✅ | Run ledger (`engine_job_runs`, migration **028**) claims a `run_id` before work and short-circuits a completed run. **028 APPLIED to DEV 2026-10-17** and verified live: the same `run_id` submitted twice produced one ledger row (`attempts 1`, `status complete`) and an `idempotency.replay` — the step did not run again. |
| **B8** | ✅ | Per-provider RPM/TPM budgets for gemini / perplexity / openai / firecrawl / kieai, plus 429 retries where there were none. |
| **B13** | ✅ | Decision: keep Railway Redis, make failure loud. Watchdog + email alerting + HITL gates readable from Postgres. |
| **C1** | ✅ | `GET /admin/dashboard` — readiness, per-queue depth/running/waiting, recent dead letters. |
| **C2** | ✅ | `ALERT_EMAIL` via Postal, debounced in Redis. Delivery verified end to end. |
| **B11** | ✅ | `scripts/load_test.py`. Numbers below. |

#### B11 measurements (DEV, every op a real LLM call)

| Load | Result | Wall | Queue wait p95 | Total p95 |
|---|---|---|---|---|
| 10 users × 2 interactive | 20/20 ok | 44s | 2.5s | 38s |
| 20 users × 2 interactive | 40/40 ok | 75s | 26.7s | 67s |
| 20 users + 6 heavy (first run) | **37/46 — container restart** | 67s | 31s | 65s |
| 20 users + 6 heavy (after fixes) | **46/46 ok** | 94s | 30.8s | 86s |

Peak interactive `running` hit exactly 24 — the configured `max_jobs` — with the overflow waiting
for a slot. **B4 holds:** heavy work ran on its own worker with a 2.4s queue wait while 40
interactive jobs were in flight, which is precisely the starvation the split was meant to remove.

#### The two faults the load test found

1. **A one-second Redis connect timeout cost the whole container.** arq ships `conn_timeout=1`, and
   its `conn_retries` only cover pool *creation*. At 20 users a connect attempt timed out, the heavy
   worker exited rc=1, and B1's fail-fast then stopped every other process: 94 jobs had completed, 8
   were in flight, all 8 died. Redis was busy, not down. Now 10s with `retry_on_timeout` and an idle
   health check.
2. **The supervisor amplified it.** Exiting as soon as *any* child dies is right for a child whose
   death makes the container useless and wrong for an arq worker, whose jobs live in Redis. It now
   restarts a dead child in place (5 per 5 minutes, then the old exit-1).

The 9 lost jobs left **no dead letters**, and that is correct rather than a B5 gap: the processes
were killed, so nothing ran an `except` block. The DLQ covers a job that fails, not a job whose
process is killed — the restart policy is what shrinks that window.

#### What the data says about B7 / B12 / B10

* **One instance holds 20 users** for this mix. The binding constraint is the interactive worker's
  24 slots, not CPU, not memory, and not the step process — which contradicts the pre-measurement
  assumption that B10's one-container design would be the ceiling. **No step gets peeled out of the
  B10 container on this evidence.**
* **Redis is the real single point of failure**, confirmed by being the only thing that actually
  broke. The chosen mitigation is alerting, not HA.
* **50 users** on this mix needs roughly 2.5× the interactive slots. That is either `max_jobs` (one
  process, more concurrency) or a second instance (**B7**) — a decision to make with a 50-user run,
  not from a 20-user extrapolation. **B12** (autoscaling) remains unjustified: nothing queued for
  longer than 31s and nothing was lost.

#### Still open from Gate 2

* ~~Migration 028~~ — **applied 2026-10-17.** The DSN was already on the Workbench service as
  `DATABASE_URL`; I had been asking for something I could read myself. Verified live: a duplicate
  `run_id` replays instead of re-running.
* **An external uptime check** on `/admin/health`. The watchdog lives inside the engine and
  therefore cannot report the engine being entirely dead.
* **A second replica has still never run** (**B7**). The drain that a replica needs shipped
  2026-10-18 — readiness flip, in-flight completion, then terminate — but running two instances is a
  Railway change, and cross-instance arq single-delivery remains unverified. The 50-user decision
  (more `max_jobs` in one process vs a second instance) still wants a 50-user run.
* **The TPM lever is built but not pulled** (**B9**). `hybrid-draft-polish` now genuinely splits the
  Haiku and Sonnet output-token pools, and `CHAPTER_LLM_STRATEGY` turns it on account-wide without a
  deploy. The default stays `sonnet` until a quality comparison runs on the same chapter, because a
  cheaper draft is only a lever if the prose survives it.

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
