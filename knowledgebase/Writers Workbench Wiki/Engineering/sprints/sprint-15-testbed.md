---
name: Sprint 15 — Testbed buildout + benchmarking
description: 60 pts / 4 phases / ~4 weeks. Build standalone testbed (3 n8n instances + Q/A engine + 4 LLM variants) to empirically answer LLM strategy + collapse-point questions before committing to Sprint 16-18 architecture. Replaces the abstract "Load test + monitoring" Sprint 15 in planned-sprints.
type: concept
tags: [sprints, sprint-15, testbed, benchmarking, sprint-16-18-prereq]
last_reviewed: 2026-05-09
---

# Sprint 15 — Testbed buildout + benchmarking

Replaces the prior abstract Sprint 15 ("Load test + monitoring") in [[planned-sprints]]. Builds on the [[design-feasibility]] analysis. Prerequisite for Sprints 16-18.

## Goal

Empirically answer four questions before committing to [[planned-sprints|Sprints 16-18]] architecture:

1. **Which LLM strategy meets quality bar at scale?** (Sonnet / Haiku / Hybrid-DraftPolish / Hybrid-Smart)
2. **Where does the platform break with N concurrent users?** (50? 100? 200?)
3. **How does the system fail under load?** (graceful degradation vs cascade)
4. **When do we actually need Anthropic Tier 4?** Specific user-count threshold.

## Scope

**In:**
- Testbed Supabase project (third project alongside DEV/PROD).
- 3 n8n test instances behind a sticky load balancer.
- TEST-tier workflows (cloned from DEV with LLM substitutions).
- 4 chapter-writer LLM variants.
- Q/A engine (rule-based + Sonnet-as-judge).
- Gold-standard rubric (50 DEV chapters frozen as comparison baseline).
- k6 load scripts for collapse testing.
- Synthesis report informing Sprints 16-18.

**Out:**
- Production rollout. Testbed never serves real users.
- Sprint 16-18 implementation work.
- Frontend changes (testbed has no UI — orchestrator-driven).
- Drift scanner / annotations testing — already in [[regression-tests]].
- Newsletter testing — has its own [[newsletter-test-plan]].

## Total: 60 pts across 4 phases. ~4 calendar weeks.

---

## Phase 1 — Foundation (Week 1, 16 pts)

Infrastructure first. No workflows yet.

### S15-1 — Provision Testbed Supabase project (3 pts)

**What:** New Supabase project `Writers Assistant Testbed` (third alongside [[prod-database|PROD]] and [[dev-database|DEV]]).

**Acceptance:**
- Project provisioned, URL recorded.
- Service-role + anon keys captured (vault).
- `clone-supabase-schema.sh` applied to install all `_v2` base tables + meta tables matching DEV.
- Connection pooler URI documented in [[credentials-map]].

**Dependencies:** none.

### S15-2 — Nightly DEV → Testbed data clone job (5 pts)

**What:** Cron job snapshots DEV tables nightly into Testbed, frozen for the duration of test runs. Writes anonymized.

**Acceptance:**
- Cron runs `pg_dump --data-only` on `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `outline_versions_v2`, `genre_config_v2`, `story_arcs_v2` from DEV.
- `pg_restore` into Testbed.
- Email + recipient_email anonymized to `testbed-<user_id>@example.invalid`.
- Idempotent: re-running same day is no-op.
- Documented in [[runbooks]] as new entry.

**Dependencies:** S15-1.

### S15-3 — Testbed schema additions (3 pts)

**What:** 3 new tables for run management + Q/A.

```sql
-- Testbed Supabase only — not DEV/PROD
CREATE TABLE testbed_runs (
  id              uuid PK DEFAULT gen_random_uuid(),
  scenario_id     text NOT NULL,
  llm_strategy    text NOT NULL,    -- 'sonnet' | 'haiku' | 'hybrid-draft-polish' | 'hybrid-smart'
  instance_count  int NOT NULL,
  load_pattern    text NOT NULL,    -- 'single' | 'burst-50' | 'burst-200' | 'sustained-100'
  started_at      timestamptz DEFAULT now(),
  finished_at     timestamptz,
  status          text DEFAULT 'running' CHECK (status IN ('running','completed','failed','aborted')),
  config          jsonb,
  metrics         jsonb             -- aggregate: total_chapters, p50/p95/p99 latency, error_rate, total_tokens
);

CREATE TABLE testbed_chapter_outputs (
  id                  uuid PK DEFAULT gen_random_uuid(),
  run_id              uuid FK,
  baseline_chapter_id uuid,         -- gold-standard from DEV
  candidate_text      text NOT NULL,
  candidate_metadata  jsonb,
  llm_used            text NOT NULL,
  wall_time_ms        int,
  input_tokens        int,
  output_tokens       int,
  errors              jsonb DEFAULT '[]',
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE testbed_qa_compare (
  id                  uuid PK DEFAULT gen_random_uuid(),
  run_id              uuid FK,
  baseline_chapter_id uuid,
  candidate_id        uuid FK testbed_chapter_outputs(id),
  dimension           text NOT NULL,    -- character_preservation | plot_consistency | prose_quality | voice_consistency | dialogue_authenticity | pacing | show_dont_tell
  score               numeric NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence            jsonb,
  judge               text NOT NULL,    -- 'sonnet-as-judge' | 'rule-based' | 'human' | 'gpt-4-cross-judge'
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX idx_testbed_qa_run ON testbed_qa_compare (run_id, dimension);
```

**Acceptance:**
- Migration `testbed-001_qa_tables.sql` applied to Testbed Supabase (only — not DEV/PROD).
- Schema documented inline in this page.
- Indexes verified.

**Dependencies:** S15-1.

### S15-4 — Test orchestrator service skeleton (5 pts)

**What:** New Express service on Railway. Endpoints scaffold, no logic yet.

**Acceptance:**
- New Railway service `WW-Testbed-Orchestrator` deployed.
- Endpoints respond 200 (stub):
  - `POST /testbed/scenarios`
  - `POST /testbed/run/:scenario_id`
  - `GET /testbed/runs/:run_id`
  - `GET /testbed/results/:run_id`
  - `GET /testbed/dashboard/:run_id`
- Connects to Testbed Supabase via service-role.
- `/api/health` returns `{checks:{supabase:ok}}`.

**Dependencies:** S15-1, S15-3.

---

## Phase 2 — Workflows + n8n (Week 1-2, 18 pts)

Copy DEV workflows, build variants, establish single test n8n instance.

### S15-5 — Provision n8n-test-1 (3 pts)

**What:** Single n8n instance for testbed, separate from production n8n.

**Acceptance:**
- Container deployed (Railway or Docker host).
- Hostname `n8n-test-1.agileadautomation.com`.
- Own Postgres for n8n metadata (separate from production n8n's DB).
- API key generated; recorded in [[credentials-map]].
- Anthropic + Perplexity + Firecrawl credentials installed (shared with DEV/PROD — same accounts).

**Dependencies:** none (parallel with Phase 1).

### S15-6 — Copy 5 core DEV workflows → TEST tier (5 pts)

**What:** Clone DEV workflows to TEST tier, substituted for testbed targets.

| DEV workflow | DEV ID | New TEST workflow |
|---|---|---|
| `DEV - The Author Agent` (hub) | `FLA6xIDEvejihQLP` | `TEST - The Author Agent` (webhook `/webhook/author_request_test`) |
| `DEV - Worker - Write Chapter` | `fsKRGkzphWT62rja` | `TEST - Worker - Write Chapter (Sonnet)` (control — same as DEV) |
| `DEV - Sub - Build Chapter Context` | `jJe84zB3U1HA9xVv` | `TEST - Sub - Build Chapter Context` |
| `DEV - Sub - Research Pipeline` | `ACgIg1WPkIipiy5o` | `TEST - Sub - Research Pipeline` |
| `DEV - Tool - Generate Cover Art` | `0sQWPO5fsxnXyiWR` | `TEST - Tool - Generate Cover Art` (optional — tests skipping cover) |

**Acceptance:**
- Extend `scripts/clone-prod-to-dev.py` (or new `scripts/clone-dev-to-test.py`) for DEV→TEST tier:
  - Substitute Supabase URL/key DEV → Testbed.
  - Rewrite webhook paths `_dev` → `_test`.
  - Rewire `executeWorkflow` refs to TEST sibling IDs.
  - Regenerate `webhookId` to avoid collisions per [[workflow-tiers]].
- All 5 workflows deployed on n8n-test-1 + active.
- Hub system prompt includes only the relevant tools (write_chapter + retrieve_content for now — no need for full 23-tool tree during testbed).
- Smoke test: `POST /webhook/author_request_test {user_message_request:'write chapter 1', user_id:'+15555550001'}` produces a chapter writing to Testbed Supabase (NOT DEV).
- New section in [[workflow-id-map]] for TEST tier.

**Dependencies:** S15-5.

### S15-7 — Build 4 chapter-writer LLM variants (8 pts)

**What:** Four parallel `Worker - Write Chapter` workflows, each with a different LLM strategy.

| Workflow | LLM strategy |
|---|---|
| `TEST - Worker - Write Chapter (Sonnet)` (S15-6) | Control. Same as PROD/DEV. All Sonnet. |
| `TEST - Worker - Write Chapter (Haiku)` | Sub-chapters use Haiku 4.5; continuity merge + extract_bible stay Sonnet. |
| `TEST - Worker - Write Chapter (Hybrid-DraftPolish)` | Haiku writes sub-chapter draft → Sonnet rewrites for voice (~+30% Sonnet tokens). |
| `TEST - Worker - Write Chapter (Hybrid-Smart)` | Sub-chapter classifier in Build Chapter Context tags each sub-chapter (`description` / `transition` / `dialogue` / `climax`). Haiku for first two; Sonnet for last two. |

**Acceptance:**
- Each workflow active on n8n-test-1.
- IDs recorded in [[workflow-id-map]] under TEST.
- Each writes to `published_content_v2` on Testbed Supabase with `metadata.test_strategy = '<sonnet|haiku|hybrid-dp|hybrid-smart>'`.
- Smoke test: 1 chapter via each strategy, all four produce non-empty `content_text` ≥ 1000 words.
- Token usage logged to `testbed_chapter_outputs.input_tokens` + `output_tokens`.

**Dependencies:** S15-6.

### S15-8 — Test orchestrator: run dispatch (2 pts)

**What:** Wire orchestrator's `POST /run/:scenario_id` to actually enqueue work.

**Acceptance:**
- INSERT `testbed_runs` row, status=running.
- For each baseline chapter in scenario config: call test hub webhook with `{user_message_request, user_id, chapter_run_id, target_workflow_id}`.
- BullMQ tracks each as a job; mirrors to `testbed_chapter_outputs` on completion.
- On all done: UPDATE `testbed_runs.status='completed'` + write aggregate metrics.

**Dependencies:** S15-4, S15-7.

---

## Phase 3 — Q/A engine + gold standard (Week 2, 11 pts)

Measurement infrastructure. Without this, results aren't comparable.

### S15-9 — Rule-based Q/A engine (3 pts)

**What:** Server-side deterministic checks. Fast + free.

Checks:
- Character mention coverage: every character in `outline.characters[]` mentioned in candidate. Counts vs baseline.
- Word count tolerance: candidate within 80%-120% of baseline.
- LOCKED CHARACTER ROSTER: candidate uses only canonical names + variants. Reuses [[chapter-writer-architecture|drift scanner]] logic (Phase 0-3, see [[annotations-panel]]).
- Forbidden patterns: no `[Sigh]`, `[whisper]` style stage directions; no markdown artifacts.
- Story-bible consistency: candidate's named entities match `story_bible_v2` for the project (no fictional characters not in bible).

**Acceptance:**
- Each check returns `{score: 0-1, evidence: [...]}`.
- Scores written to `testbed_qa_compare` with `judge='rule-based'`.
- Runs in < 5 seconds per chapter.
- Unit tests cover each check with positive + negative case.

**Dependencies:** S15-3.

### S15-10 — TEST - Sub - QA Compare Chapter workflow (Sonnet-as-judge) (5 pts)

**What:** n8n workflow that takes `(baseline, candidate)` pair + scoring rubric, asks Sonnet to rate dimensionally.

Dimensions: `character_preservation`, `plot_consistency`, `prose_quality`, `voice_consistency`, `dialogue_authenticity`, `pacing`, `show_dont_tell`.

**Acceptance:**
- Workflow on n8n-test-1.
- Input: `{run_id, baseline_chapter_id, candidate_id}`.
- Loads both chapter texts + project metadata + character roster.
- Calls Sonnet with structured prompt (rubric + instructions to output JSON `{dimension: {score, evidence_quotes}}`).
- Defensive JSON parse (same pattern as drift scanner / extract_bible per [[chapter-writer-architecture]]).
- Inserts 7 rows into `testbed_qa_compare` (one per dimension), `judge='sonnet-as-judge'`.
- Cost recorded: ~$0.05 per comparison.
- Idempotent: re-running on same `(run_id, candidate_id)` updates instead of duplicates.

**Dependencies:** S15-3, S15-6.

### S15-11 — Score 50 DEV chapters as gold-standard rubric (3 pts)

**What:** Pick 50 representative DEV chapters covering breadth (genres, project types, character densities, dialogue ratios). Run Q/A engine self-comparison (chapter as both baseline + candidate) to establish "what perfect looks like" — should score near 1.0 on every dimension. Then human-review 5 of the 50 and adjust rubric prompt if needed.

**Acceptance:**
- 50 chapters selected, IDs recorded in `testbed_runs.config.gold_standard_chapter_ids`.
- 50 self-compares run; mean dimensional score recorded.
- Self-compare floor identified: scores below ~0.92 mean rubric is too strict; adjust until self-compare averages ~0.95.
- Frozen rubric committed as `writers-workbench/testbed/qa-rubric-v1.md`.

**Dependencies:** S15-9, S15-10.

---

## Phase 4 — Multi-instance + collapse testing + synthesis (Week 3-4, 15 pts)

Where the platform breaks under load.

### S15-12 — Provision n8n-test-2 + n8n-test-3 (3 pts)

**What:** Bring total test instances to 3.

**Acceptance:**
- Containers deployed on hostnames `n8n-test-2.agileadautomation.com`, `n8n-test-3.agileadautomation.com`.
- Each has separate Postgres for n8n metadata.
- All TEST workflows from S15-6 + S15-7 deployed identically on each (script — `scripts/deploy-test-workflows.py`).
- All instances active + reachable.

**Dependencies:** S15-7 (workflows must exist before deployment).

### S15-13 — Sticky load balancer (3 pts)

**What:** Cloudflare Load Balancer (or simple HAProxy) in front of n8n-test-1/2/3.

**Acceptance:**
- Hostname `n8n-test-lb.agileadautomation.com` routes to all 3 backends.
- Sticky session: `chapter_run_id` cookie or path-prefix routing pins a chapter to its assigned instance.
- Per-instance health checks (n8n's `/healthz`).
- Round-robin among healthy instances.
- Test orchestrator updated to use the LB hostname.

**Dependencies:** S15-12.

### S15-14 — k6 load scripts (3 pts)

**What:** Three load patterns.

| Script | Pattern | Purpose |
|---|---|---|
| `burst-50.js` | 50 concurrent chapter writes, all start within 5 seconds | Simulates simultaneous-user hit |
| `burst-200.js` | 200 concurrent chapter writes (deliberately exceeds capacity) | Find the collapse point |
| `sustained-100.js` | 100 chapter writes spread over 1 hour (~1.6/min — peak demand at 100 daily users) | Steady-state behavior |

**Acceptance:**
- Scripts in `writers-workbench/testbed/load/`.
- Each records: per-chapter wall time, queue depth over time, Anthropic 429 rate, Workbench 5xx rate, BullMQ failed-job count, per-instance utilization (CPU/memory/in-flight count via `/admin/queues` proxy).
- Result CSV uploaded as `testbed_runs.metrics.load_results`.

**Dependencies:** S15-13.

### S15-15 — Run quality bake-off + collapse scenarios (3 pts)

**What:** Execute the test runs that produce the answers.

**Quality bake-off** (single-chapter, no load):
- 50 chapters × 4 strategies = 200 candidates.
- Each candidate gets rule-based + Sonnet-as-judge Q/A.
- Output: dimensional scores per strategy, latency distributions, token cost.

**Collapse scenarios** (load):
- `burst-50` × all-Sonnet → expected: comfortable.
- `burst-200` × all-Sonnet → expected: 429s, queue grows. Find the breaking point.
- `sustained-100` × all-Sonnet → expected: stable.
- Repeat all three for the winning hybrid strategy.
- Chaos: kill instance during `burst-50` → does another instance pick up?
- Chaos: simulate Anthropic 429 (rate-limit a credential temporarily) → does budget gatekeeper hold?

**Acceptance:**
- All scenarios executed; results in `testbed_runs` + `testbed_qa_compare` + `testbed_chapter_outputs`.
- Failures documented per scenario.

**Dependencies:** S15-12, S15-13, S15-14, S15-11.

### S15-16 — Synthesis report (3 pts)

**What:** Document what we now know. Single markdown file.

**Acceptance:**
- `writers-workbench/docs/sprint-15-testbed-synthesis.md` with:
  - Recommended LLM strategy per subscription tier (with dimensional score evidence).
  - Empirical chapters/hour ceiling at Tier 3 (current Anthropic limit).
  - Empirical breaking-point under burst load (at how many concurrent does p95 exceed 15 min?).
  - When Anthropic Tier 4 becomes essential (specific user count threshold based on data).
  - Failure-mode behavior table (kill-instance, Anthropic 429, Postgres drop, Cloudflare 524, Postal down).
  - Concrete recommendations for Sprint 16-18 refinement (which stories to keep, drop, add).
- Updates to [[design-feasibility]] page with empirical numbers replacing the math estimates.
- Updates to [[chapter-writer-architecture]] with the chosen LLM strategy.
- Updates to [[planned-sprints]] Sprints 16-18 with refined story counts.

**Dependencies:** S15-15.

---

## Dependency graph

```
Phase 1 (parallel):
   S15-1 (Supabase)
   S15-3 (schema) ← S15-1
   S15-2 (clone job) ← S15-1
   S15-4 (orchestrator) ← S15-1, S15-3

Phase 2:
   S15-5 (n8n-test-1)
   S15-6 (copy 5 workflows) ← S15-5
   S15-7 (4 LLM variants) ← S15-6
   S15-8 (orchestrator dispatch) ← S15-4, S15-7

Phase 3 (after Phase 2):
   S15-9 (rule-based Q/A) ← S15-3
   S15-10 (Sonnet-as-judge) ← S15-3, S15-6
   S15-11 (gold standard) ← S15-9, S15-10

Phase 4 (after Phase 2; runs parallel to Phase 3 mostly):
   S15-12 (n8n-test-2, 3) ← S15-7
   S15-13 (sticky LB) ← S15-12
   S15-14 (k6 scripts) ← S15-13
   S15-15 (run scenarios) ← S15-14, S15-11
   S15-16 (synthesis) ← S15-15
```

Critical path: S15-1 → S15-5 → S15-6 → S15-7 → S15-12 → S15-13 → S15-14 → S15-15 → S15-16. ~17 work-days serial.

With parallelization (Phase 3 Q/A engine concurrent with Phase 4 first half): ~14 work-days serial.

## Sprint success criteria

**Functional:**
- [ ] All 4 LLM variants produce chapters in the testbed.
- [ ] Q/A engine (rule-based + Sonnet judge) scores 200+ candidate chapters.
- [ ] k6 successfully runs all 3 load patterns to completion or documented failure.
- [ ] Multi-instance LB distributes load across 3 instances.

**Measurement:**
- [ ] Empirical answer: "Haiku is/is-not acceptable for Standard tier." Backed by dimensional scores.
- [ ] Empirical answer: "Platform breaks at N concurrent chapters on Tier 3." With reproducible repro.
- [ ] Empirical answer: "Anthropic Tier 4 required at user count X." With math derived from measured tokens/chapter.
- [ ] Failure-mode table: 7 scenarios × pass/fail/degraded.

**Documentation:**
- [ ] Synthesis report committed.
- [ ] Wiki updates: [[design-feasibility]], [[chapter-writer-architecture]], [[planned-sprints]].
- [ ] [[runbooks]] entry for "running a testbed scenario."
- [ ] [[testing/_index]] entry for testbed.

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| n8n test instance differs subtly from DEV in unobvious ways → results don't generalize | Medium | Use same n8n version + plugin set. Validate by re-running existing DEV chapters and confirming bit-equality of output. |
| Sonnet-as-judge has its own biases (overrating Sonnet output, underrating Haiku) | Medium | Use **GPT-4 as cross-judge** for spot validation on 10% of comparisons. If divergence > 20%, recalibrate. |
| Anthropic spend balloons during bake-off | Low (one-time) | Hard cap: $1000 budget for Sprint 15. Pause and review at $500. |
| Test instances get used as "shadow PROD" by mistake | Low | Hostname clearly contains `-test-`. Webhook is `/webhook/author_request_test`. Hub system prompt says "TESTBED — DO NOT USE FOR PRODUCTION." |
| Quality gold-standard rubric is wrong | Medium | Self-compare validation in S15-11. If self-scores < 0.92, rubric is too strict; adjust before bake-off. |
| Collapse scenarios damage the test instances (memory leaks, stuck DBs) | Medium | Each scenario followed by orchestrator-triggered restart of all test instances. Instance state ephemeral. |

## Cost estimate

**One-time LLM spend during sprint:**

| Activity | Cost |
|---|---|
| Quality bake-off: 200 candidates × ~$1.50 average | $300 |
| Sonnet-as-judge: 200 candidates × 7 dimensions × $0.05 | $70 |
| Gold-standard self-compare: 50 × 7 × $0.05 | $18 |
| Load tests: 350 chapters × ~$1 average | $350 |
| Cross-judge (GPT-4) validation: 30 candidates × 7 × $0.05 | $11 |
| **Total LLM** | **~$750** |

**Infrastructure (recurring):**

| Item | Monthly cost |
|---|---|
| Testbed Supabase Pro | $25 |
| 3 n8n test instance Railway services | $45 |
| Postgres for each n8n | $15 |
| **Total** | **~$85/month** |

Tear down testbed after Sprint 18 ships, OR keep as regression harness (recommended — small cost for ongoing protection against architectural regressions).

## What this answers vs Sprints 16-18

After Sprint 15 ships, the downstream sprints simplify dramatically.

| Sprint 16 question | Answered by Sprint 15? |
|---|---|
| What's the per-chapter token cost distribution? | Yes (S15-15 + S15-16 metrics) |
| Should we upgrade Anthropic tier? | Yes (S15-16 user-count threshold) |
| What's our quality benchmark? | Yes (S15-11 frozen rubric) |
| What's the current single-instance baseline? | Yes (control LLM strategy is "all Sonnet" which IS the current architecture) |

Sprint 16 essentially becomes "S16-X — apply Sprint 15 findings to the production worker," ~10 pts instead of 26-34 pts.

| Sprint 17 question | Answered by Sprint 15? |
|---|---|
| Sonnet vs Opus vs Haiku bake-off? | Sonnet vs Haiku covered. Opus skipped (cost-prohibitive at scale; not on the Standard-tier roadmap). |
| Anthropic Token Budget gatekeeper design? | Validated by collapse scenarios; budget exhaustion behavior measured. |
| Multi-instance dispatcher? | Validated by S15-12/13/15. |

Sprint 17 essentially becomes "S17-X — productionize the testbed dispatcher," ~15 pts instead of 29-37 pts.

| Sprint 18 question | Answered by Sprint 15? |
|---|---|
| Chaos test matrix? | Partially. S15-15 covers main scenarios; productionizing tests is still work. |
| Shadow mode? | Not directly — testbed runs in isolation. Production shadow mode is its own work. |
| 10/50/100% rollout? | Not addressed — production rollout. |

Sprint 18 stays roughly its size (~34 pts), but with much higher confidence + measured baselines.

**Net effect: Sprint 15 (60 pts) replaces ~50 pts of speculative work in 16-18 with empirical work, AND de-risks the remaining ~50 pts.**

## Sequencing in the program

Current [[planned-sprints]] order: 9 → 13 → 14 → 15 → 16 → 17 → 18.

**Recommended revision: 9 → 14 → 15 → 16 → 17 → 18.** Sprint 13 (n8n queue mode) was already deprecated. Sprint 14 (storage decision) stays; quick (3 pts firm). Then Sprint 15 (this testbed) before any chapter-writer architecture work.

If user count growth pressures the timeline: **Sprint 15 can run parallel to Sprint 9 (Stripe).** Different code paths, different engineers (if available). Both are 4-6 weeks; parallel saves 4-6 weeks elapsed.

## Cross-system implications

| System | Change required |
|---|---|
| [[workflows/_index|Workflows]] | New TEST tier; naming + governance update |
| [[base-tables|Schema]] | 3 new testbed tables (testbed Supabase only — governance N/A) |
| [[deployment-railway|Railway]] | New `WW-Testbed` env. n8n-test-1..3 + WW-Testbed-Orchestrator services. |
| [[promotion-dev-to-prod|Promotion script]] | Extended for TEST tier (`scripts/clone-dev-to-test.py`) |
| [[ci-pipeline|CI]] | Optionally: nightly testbed run as informational job |
| [[regression-tests|Regression]] | New B-tests fed by testbed-discovered failure modes |
| [[credentials-map|Credentials]] | Testbed Supabase keys; n8n-test API keys |

## Why this exists

Per [[design-feasibility]] section "Recommendations before writing more spec":

> 1. Get pricing + lead-time from Anthropic for Tier 4. Single biggest unlock.
> 2. Run S16-5 (token cost profiler) BEFORE committing to N. Real numbers shift instance count from 5 to 10 (or vice versa) decisively.
> 3. Validate lock-to-instance assumption with one prototype.

This sprint operationalizes those three points + adds:
4. Validates Haiku quality empirically (under Tier 3 constraint where token efficiency matters most).
5. Discovers actual collapse points before deploying multi-instance to production.

Without this sprint, Sprints 16-18 are guess-driven. With it, they're measurement-driven.
