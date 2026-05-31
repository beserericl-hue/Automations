---
name: Newsletter AI microservices — design
description: Design for the own-Docker-image Python newsletter microservices that replace the n8n compose-newsletter workflow, UI-driven (no emails), consuming content_ingestion_v2; deepens service-decomposition Module 9 / roadmap Sprint 20
type: concept
tags: [design, newsletter, python, microservices, gate-3, sprint-20, rewrite]
last_reviewed: 2026-05-29
---

# Newsletter AI microservices — design

> **Status: DESIGN ONLY — awaiting approval.** No implementation. This page deepens [[service-decomposition]]
> Module 9 (`newsletter`) and [[python-migration-roadmap]] Phase D / Sprint 20 into a dedicated, n8n-faithful
> microservice design, per the user's direction that the newsletter become **its own Docker image** running a
> **set of Python microservices**, driven entirely by the **Writers Workbench UI** (no operator emails),
> consuming the ingested topics produced by the timed n8n ingestion workflow (which stays).

## Decisions (locked 2026-05-29)

1. **Subscriber delivery = BOTH.** The finished newsletter is delivered to subscribers via Postal email **and**
   published as a **web archive / permalink** (a hosted read-on-web version). `deliver-svc` does both; the permalink
   is stored on the send row and surfaced in the UI.
2. **Picker model = Gemini 2.5 Pro** (kept; configurable via `PICKER_MODEL`). Claude remains the writer for
   subject / segment / intro / other-stories.
3. **Image selection = in-UI review gate.** A **third** human approval gate: after segment images are proposed, the
   operator reviews/changes image choices in the UI before render.
4. **Granularity = true per-step microservices.** Each pipeline step is its **own independently deployable service +
   Docker image**, built on a shared **engine library**. This **revises** the [[master-plan]] "modular monolith /
   service-group" decision for this engine — see [[engine-framework]] for the program-level rationale + the ops
   mitigations that make many small services manageable, and §3 below for how it applies here.

## 1. Goals, scope, non-goals

**Goal.** Remove the n8n compose-newsletter workflow (`Content - Newsletter Agent V2`, id `bMvMKyK8obwYZmNb`) and
replace it with a standalone Python service — its own Docker image, internally organized as a set of newsletter
microservices/modules — deployed as its own Railway service (dev/prod tiers), driven by the existing React UI via
SSE progress + on-screen review/approval, and producing the same newsletter artifact the n8n workflow produces.

**In scope (this CR).**
- The full **compose** pipeline: gather → pick → (approve) → subject → (approve) → segments+images → intro +
  other-stories → render HTML → persist `newsletter_sends_v2` → deliver to subscribers.
- The **three** human-in-the-loop approval gates (stories, subject, **images**) and their **revision loops**.
- **Live progress** to the UI (replacing the `emit_stage_*` callbacks) and **in-UI review** (replacing the six
  `share_*_email` notifications).
- The **cadence** trigger (replacing `Newsletter Cadence Cron`).

**Stays as-is (not this CR).**
- The timed **ingestion** workflow (`AI News Data Ingestion V2`, id `2T3TwGHhdGQlTpQ5`) remains the topic source;
  it keeps writing `content_ingestion_v2` rows + `newsletter-ingestion` storage blobs. (Its eventual port is
  [[service-decomposition]] Module 9's `ingestion` endpoints / roadmap S20-1 — can follow later.)
- All other n8n workflows (hub, chapter, etc.) — separate roadmap phases.

**Non-goals.** No operator notification emails (the UI is the sole channel). No B2B/multi-tenant surface here
(that's Phase F). No schema base-table changes (governance — see §8).

**Changes from draft (critique resolutions).** Durable **state-machine** orchestration chosen over an in-memory
"paused job" so multi-hour approval waits never pin a worker; **SSE bridged through the existing Node `/api/newsletter`
SSE endpoint via Redis pub/sub** so the React UI contract is untouched; explicit **in-UI review endpoints** added to
carry the content the six emails used to send; **edge cases** (empty ingestion, scrape failures, approval expiry,
revision loops, idempotent re-runs) specified; **n8n removal** added as the final cutover step.

## 2. Source of truth — the n8n workflow (structure + what it generates)

The n8n workflow IS the spec. Pipeline as built (102 nodes; trace + inventory):

| # | Stage (n8n nodes) | What it does | Becomes (microservice) |
|---|---|---|---|
| 0 | `webhook_trigger`/`form_trigger` → `respond_to_webhook` → `set_trigger_inputs` | Accept `{Date, "Previous Newsletter Content", "Edition Id"}`, ack synchronously with an execution id, normalize inputs | **orchestrator** (`POST /generate` → returns `execution_id`) |
| 1 | `emit_stage_gathering` → `search_markdown_objects` → `split_search_markdown` → `download_markdown_object` (`?include_html=0`) → `prepare/aggregate/combine_markdown_content`; `search_tweets` → `download_tweet_objects` → `…_tweet_content`; `check_any_results` | Pull the day's ingested stories (+ tweets) from `content_ingestion_v2` storage, assemble the candidate corpus; bail if empty | **gather-svc** |
| 2 | `emit_stage_picking` → `stories_prompt` → `pick_top_stories` (`chainLlm` + `top_stories_parser`/`…_auto_parser`) → `set_current_stories` | LLM selects top stories → `{top_selected_stories:[{title,summary,identifiers,external_source_links}], chain_of_thought}` | **pick-svc** |
| 3 | `emit_stage_awaiting_stories` → `create_approval_stories` → `wait_for_stories_approval` → `extract_stories_approval_feedback` → `check_stories_feedback` → `edit_top_stories` (loop) → `emit_stage_stories_approved` | HITL gate: create approval, **wait**, on "revise" re-run picker with feedback, on "approve" continue | **approval gate** (orchestrator state) |
| 4 | `set_subject_line_prompt` → `write_subject_line` (+`subject_line_parser`) → `set_current_subject_line` | LLM subject → `{subject_line, pre_header_text, additional_subject_lines[], …_reasoning}` | **subject-svc** |
| 5 | `emit_stage_awaiting_subject` → `create_approval_subject_line` → `wait_for_subject_line_approval` → `check_subject_line_feedback` → `edit_subject_line` (loop) → `emit_stage_subject_approved` | HITL gate #2 (same pattern) | **approval gate** |
| 6 | `split_stories` → `iterate_stories` (`splitInBatches`) → `set_story_segments` → `check_external_urls` → `scrape_segment_external_source_url` (`executeWorkflow`) → `aggregate/filter` → `emit_stage_writing_segment` → `write_segment_content` (+ parsers) → `extract_image_urls` (+ parser) → `set_current_segment` → `aggregate_story_sections` | Per selected story: optionally scrape external source URLs, write the segment body, choose image options. Loop over all stories | **segment-svc** (fan-out per story) + **scrape-svc** |
| 7 | `write_intro` (+`intro_parser`) → `write_other_top_stories` (+ parser) → `set_full_newsletter` → `emit_stage_segments_done` | Write the intro and the "other top stories" roundup; assemble `full_newsletter_content` (markdown) | **assemble-svc** |
| 8 | `render_html_template` → `create_newsletter_file` → persist `newsletter_sends_v2` → `emit_stage_saved` (`save_scheduled_newsletter` for the scheduled branch) | Render the branded HTML (masthead "Playfair Display" template from `newsletter_templates_v2`), build `markdown_body` + `html_body`, save the send row | **render-svc** + **persist-svc** |
| 9 | `fetch_subscribers` → `send_to_subscribers` → `final_notification` | Fan out the finished newsletter to active `newsletter_subscribers_v2` via Postal | **deliver-svc** |
| — | `share_selected_stories_email`, `share_stories_reasoning_email`, `share_subject_line_email`, `share_subject_line_reasoning_email`, `share_segment_msg_email`, `share_newsletter_msg_email` | Operator-notification emails of each review artifact | **DROPPED** → surfaced **in-UI** (§7) |

**What it generates (output contract the microservices must match).** A `newsletter_sends_v2` row per run with:
`edition_id`, `send_date`, `subject` (+ preheader), `status` (`draft`→`awaiting_*_approval`→`approved`→`saved`→
`sent`/`scheduled`), `markdown_body` (intro + per-story segments + other-top-stories roundup), `html_body` (the
branded masthead template merged — Playfair Display header, edition logo + signoff from
`newsletter_logos_subscribers_signoff` migration, per-story sections with chosen images, footer), and `metadata`
JSONB (`generated_by`, `execution_id`, selected-story identifiers, image choices, reasoning, revision count). The
artifact's structure (intro, N story segments each with body + image, "other top stories" list, subject/preheader)
is the parity target validated against the [[newsletter-test-plan]] in §10.

**Today's UI→backend→n8n flow.** React UI → Express `POST /api/newsletter/generate` (Supabase-JWT) → POSTs the n8n
webhook (`N8N_NEWSLETTER_WEBHOOK_URL`) → n8n streams progress back into Express via the `emit_stage_*` callbacks →
Express relays SSE to the browser; approvals via `/api/newsletter/approvals/*`; the send row read via
`/api/newsletter/sends`. The Express contract is what we preserve.

## 3. Target architecture

**Per-step microservices on a shared engine library (decision #4).** Each pipeline step is its **own independently
deployable service with its own Docker image** — `gather-svc`, `pick-svc`, `subject-svc`, `scrape-svc`, `segment-svc`,
`image-svc`, `assemble-svc`, `render-svc`, `persist-svc`, `deliver-svc` — coordinated by an **`orchestrator-svc`**.
All are built from a shared **engine library** (`writer_engine` / `newsletter_engine` package: LLM clients with
prompt caching, the prompt store, Pydantic step schemas, Supabase/Redis/Postal adapters, the state-machine +
step-contract primitives). **The engine library is the salable core** (see [[engine-framework]]); each service is a
thin FastAPI app that imports it and implements one step. Every step exposes a uniform contract —
`POST /run {execution_id}` (reads prior state, does its work, writes state, publishes progress) — so steps are
composable and individually replaceable **or sellable**. Async work runs via **arq** on the shared Redis;
`orchestrator-svc` is the saga coordinator that drives the §5 state machine and invokes step services.

This **deliberately revises** the [[master-plan]] "modular-monolith / 3 service-group" decision; the program-level
rationale + tradeoffs live in [[engine-framework]]. **Ops mitigations for many small services:** one **monorepo** →
one shared base image + per-service thin images via a build matrix; a single `docker compose` runs the whole set
locally; IaC-generated Railway service manifests; health/metrics/logging/auth come from the engine library
(uniform); the set ships as one versioned release.

Deployed as a **set of Railway services** (orchestrator + step services) in **both tiers**, mirroring
[[deployment-railway]] + [[tier-separation]] and the env-var conventions in `CLAUDE.md`:
- dev → DEV Supabase `gvbvwcnmjkdpclcisqrr`, shared DEV Redis, Postal; prod → PROD Supabase `faklxfakgzkpkbxfihzh`,
  PROD Redis, Postal.
- env (shared across the set): `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `ANTHROPIC_API_KEY`,
  `PICKER_MODEL` + its key (Gemini), `POSTAL_*`, `ARCHIVE_BASE_URL` (permalink host), `WORKBENCH_API_URL`,
  `SERVICE_SHARED_SECRET` (X-Service-Secret), `INGESTION_SECRET`, `ADMIN_TOKEN`. Each service's `Dockerfile` target
  builds its image; Railway healthcheck `/admin/health` per service.

**Scalability (first-class requirement).** Because each step is its own service, each **scales horizontally and
independently** to its own load profile — e.g. many `segment-svc` / `image-svc` replicas during per-story fan-out,
few `gather-svc`. Steps are **stateless** (durable state in Supabase + Redis), so replicas add linearly; work is
**queue-driven** (arq) with an Anthropic token-budget gatekeeper so we never exceed provider limits; idempotency
keys make retries safe. This is the throughput path to the customer-bandwidth goals — capacity math + targets in
[[engine-framework]] §scalability and [[scaling-architecture]].

**How the UI reaches it — RECOMMENDED: keep the Express `/api/newsletter/*` routes as the stable UI contract; the
Node server proxies to `newsletter-svc` over `/internal/*` (shared-secret).** This means **zero UI changes**:
Supabase-JWT auth + CORS + the existing SSE endpoint stay in Express; only the *upstream* swaps from the n8n webhook
to `newsletter-svc`. This reuses the existing `app_config`-style feature flag pattern for per-route cutover.
(Alternative, deferred: UI calls `newsletter-svc` directly with Python validating the Supabase JWT — more moving
parts in auth/CORS, no near-term benefit. Recommend Option A now, keep B open for the B2B phase.)

```
React UI ──HTTPS+JWT──> Express /api/newsletter/* ──X-Service-Secret──> orchestrator-svc (saga)
   ^  SSE (existing)         |  (proxy)                                      │  invokes step services (arq/HTTP):
   |                         └──── Redis pub/sub (progress) ────────────┐    │  gather→pick→subject→segment→image
   └──── Express SSE relays Redis "nl:exec:{id}" channel ───────────────┘    │  →assemble→render→persist→deliver
                                                                             ├─ Supabase (tables + storage)
   all services import the shared `newsletter_engine` library ───────────────┼─ Postal (email) + ARCHIVE_BASE_URL (web permalink)
                                                                             └─ Redis (arq queue + progress pub/sub)
```

## 4. Microservice (module) decomposition + AI layer

Each module = one n8n stage (table §2). All are pure functions over Supabase/LLM state; the **orchestrator** sequences
them and owns the state machine (§5).

- **gather** — query `content_ingestion_v2` for the edition's day (prefix `{Date}/`, `user_id`, `type != newsletter`),
  download `markdown` only (the `?include_html=0` lesson — md is ~5KB vs html up to 3MB), assemble the candidate
  corpus; also gather tweets; **empty-corpus guard** → terminal `status='skipped_no_content'` + UI message.
- **pick** — Claude (or the configured picker model) selects top stories → structured `top_selected_stories`
  + `chain_of_thought`. Revision-aware (accepts prior selection + operator feedback).
- **subject** — Claude → `subject_line`, `pre_header_text`, `additional_subject_lines`, reasoning. Revision-aware.
- **scrape** — for stories with `external_source_links`, fetch source content (Firecrawl/`media.scrape-url` per
  [[service-decomposition]] Module 4) with per-URL error filtering (mirrors `filter_segment_external_source_errors`).
- **segment** — per selected story (fan-out, bounded concurrency): write `newsletter_section_content`. Mirrors
  `write_segment_content`.
- **image** (`image-svc`, decision #3) — per story, propose image options from the story's ingested `image_urls` /
  scraped media (mirrors `extract_image_urls`); the chosen set is held for the **in-UI image-review gate** (§5/§7)
  before render.
- **assemble** — `write_intro` + `write_other_top_stories` + concatenate into `full_newsletter_content` (markdown).
- **render** — merge into the edition's branded template from `newsletter_templates_v2` using **Jinja2**
  (Handlebars-equivalent), preserving the masthead (Playfair Display), edition logo + signoff, per-story image
  blocks, footer → `html_body`.
- **persist** — idempotent UPSERT of the `newsletter_sends_v2` row keyed on `(edition_id, send_date, execution_id)`.
- **deliver** (decision #1 = BOTH) — (a) **email**: `fetch_active_subscribers(edition_id)` → Postal fan-out, record
  delivery, bounces via the existing `email_bounces_v2` webhook path; **and** (b) **web archive / permalink**:
  publish the rendered `html_body` to a hosted read-on-web URL (`ARCHIVE_BASE_URL/{edition}/{send_id}`), store the
  permalink on the send row (`metadata.permalink`), and surface it in the UI. Subscriber emails include the
  "read on web" permalink.

**AI provider layer.** `anthropic_client` (async, retry, **prompt caching** on the large static system/style blocks,
token accounting) — Claude is the writer for pick/subject/segment/intro/other-stories. The picker model is
configurable (`PICKER_MODEL`, default Claude; the n8n node used Gemini 2.5 Pro — keep Gemini as a configurable
fallback, since that snapshot proved fragile/retired). All prompts + structured-output schemas are **ported verbatim
from the n8n `chainLlm` nodes** (`pick_top_stories`, `write_subject_line`, `write_segment_content`,
`extract_image_urls`, `write_intro`, `write_other_top_stories`) and stored centrally (`app_config`-style prompt
store, hot-reloadable) so prompt parity is auditable.

## 5. Async orchestration + HITL (durable state machine)

The generation is long-running with **three human gates** (stories, subject, images). Rather than hold an in-memory worker "paused" for hours
(the n8n `wait` model), use a **durable state machine** persisted on the `newsletter_sends_v2` row + driven by arq
jobs. Each stage is an enqueued step; a gate **stops** the run (releasing the worker) and is **resumed** by the UI.

`status` lifecycle (stored on the send row): `gathering → picking → awaiting_stories_approval → stories_approved →
subject → awaiting_subject_approval → subject_approved → writing_segments → proposing_images →
awaiting_image_approval → images_approved → assembling → rendering → saved → sending → sent` (+ `scheduled`,
`skipped_no_content`, `error`). **Three** human gates: stories, subject, **images** (decision #3).

- `POST /generate` → create the send row (`status=gathering`, `execution_id`), enqueue `run_stage(gather)`, return
  `{execution_id}` synchronously (matches today's ack).
- Worker advances stage→stage, **publishing a progress event** to Redis channel `nl:exec:{execution_id}` after each
  (this replaces every `emit_stage_*` callback). The existing Express SSE endpoint **subscribes to that channel and
  relays** to the browser — UI contract unchanged.
- **Gate:** at `awaiting_*_approval`, the worker writes a `newsletter_approvals_v2` row (`token`, `stage`, `payload`
  = the review content, `expires_at`) and **stops**. No worker is held.
- **Resume:** the UI `POST /approvals/{token}/resolve {decision, feedback}` → marks the approval resolved → enqueues
  the next step: `approve` → continue; `revise` → re-enqueue `pick`/`subject` with feedback (the revision loop,
  bounded by a max-revisions guard) → new approval.
- **Idempotency:** every stage is keyed on `(execution_id, stage)` in Redis (24h) so retries/replays are safe.
- **Resilience:** a stage exception sets `status=error` + an `error_detail`, publishes an `error` SSE event, and is
  retryable from the UI; expired approvals return 404 on resolve (per [[api-contracts]]).

## 6. API surface (newsletter-svc)

Internal (`/internal/*`, `X-Service-Secret`) — called by the Express proxy; UI-facing shapes preserved by Express:

| Endpoint | Method | Purpose |
|---|---|---|
| `/internal/newsletter/generate` | POST | `{edition_id, send_date, previous_newsletter_content?}` → `{execution_id, status}` |
| `/internal/newsletter/executions/{id}` | GET | Current status + last stage (for UI polling fallback) |
| `/internal/newsletter/executions/{id}/review/{stage}` | GET | The review payload for a gate (selected stories + reasoning; or subject + alternatives + reasoning; or per-segment content + image options; or final preview) — **replaces the emails** |
| `/internal/newsletter/approvals/open` | GET | Open approvals for a user/execution (mirrors today's route) |
| `/internal/newsletter/approvals/{token}/resolve` | POST | `{decision: approve|revise, feedback?}` → resumes the state machine |
| `/internal/newsletter/cron/cadence` | POST (X-Cron-Secret) | Cadence: find due editions → enqueue `generate` |
| `/admin/health`, `/metrics` | GET | Health + Prometheus |

Progress is **SSE via the existing Express endpoint** (Express subscribes to `nl:exec:{id}`); event shapes match
today's `emit_stage_*` payloads so the UI's `ExecutionStatus` page is unchanged.

## 7. UI integration — UI is the sole comms channel (no emails)

The six `share_*_email` nodes carried: (a) selected stories + reasoning, (b) subject + alternatives + reasoning,
(c) each segment body + image options, (d) the final preview/permalink. All of this moves **into the UI**:

- **Live progress** — `ExecutionStatus` consumes the SSE stages (gathering→picking→awaiting…→writing_segment→saved)
  exactly as today.
- **Review at each gate** — when `status=awaiting_stories_approval` / `awaiting_subject_approval` /
  `awaiting_image_approval`, the Approvals/`ApprovalDetail` screen fetches `…/review/{stage}` and renders the
  selected stories + chain-of-thought (or subject + alternatives + reasoning, or the proposed per-story images) with
  **Approve / Request changes (feedback)** controls → `…/resolve`.
- **Image-review gate (decision #3)** — at `awaiting_image_approval` the UI shows each story's proposed image options
  (thumbnails) and lets the operator pick/replace per story before render; the chosen set is written back via
  `…/resolve` and used by `render-svc`.
- **Segment review** — segment bodies surface on the execution screen as they're written (per-segment SSE) and in
  the final preview (`NewsletterDetail`).
- **Final preview** — `NewsletterDetail` reads the `newsletter_sends_v2` row (`html_body`) for the finished preview
  in place of the "newsletter finished" email.

**UI gaps to close (small, additive — no breaking changes):** the `ApprovalDetail` page must render the
`review/{stage}` payload for both gates (today it was email-driven), and the execution screen should show per-segment
output as it streams. These are new endpoints + view additions, not contract breaks. (Confirmed against the current
client routes in §2; the generate→execution→approval→sends navigation and execution-id/approval-token flow are
preserved.)

## 8. Data model (reuse; governance-compliant)

Reuse existing tables (no base-table ALTERs — [[schema-governance]]): `newsletter_editions_v2`,
`newsletter_sends_v2` (`subject`, `markdown_body`, `html_body`, `status`, `metadata` JSONB, scheduled fields),
`newsletter_approvals_v2` (`token`, `stage`, `payload`, `expires_at`, `resolved_at`, `decision`, `feedback`),
`newsletter_templates_v2` (the masthead template), `newsletter_subscribers_v2`, `newsletter_feed_sources_v2`,
`newsletter_ingestion_runs_v2`, `content_ingestion_v2`, `email_bounces_v2`, and the BullMQ job-queue table.

New state needed (`status` enum values, per-stage progress, revision counts, image choices, reasoning) lives in
`newsletter_sends_v2.metadata` and `newsletter_approvals_v2.payload` (both JSONB) — **no new base columns required**.
If a dedicated `newsletter_runs_v2` step-audit table is wanted later, it is a **meta table with FKs** per governance.

## 9. Cadence + ingestion relationship

- **Cadence** (`Newsletter Cadence Cron`) → `POST /internal/newsletter/cron/cadence` on a schedule (Railway cron or
  cron-job.org hitting the cron endpoint with `X-Cron-Secret`): query editions whose cadence is due → enqueue a
  `generate` for each. Mirrors [[service-decomposition]] Module 9 / roadmap S20-3/4.
- **Ingestion** stays in n8n for this CR; `gather` simply reads `content_ingestion_v2`. (Porting ingestion to
  `/internal/newsletter/cron/ingestion` is a clean follow-up, S20-1.)

## 10. Cutover & migration (DEV-first, feature-flagged, then remove n8n)

Per [[workflow-governance]] + `CLAUDE.md` tiers:
1. **Build + deploy `newsletter-svc` to DEV** (its own Railway service, DEV Supabase/Redis/Postal).
2. **Flag the Express proxy**: `NEWSLETTER_BACKEND = n8n | python` (per-tier). DEV → `python`.
3. **Parity validation on DEV** against the [[newsletter-test-plan]] (114-test plan) — esp. Sections 7 (generate),
   8 (approval), 9 (send), 13 (edge cases): empty-ingestion skip, revision loops, approval expiry, idempotent re-run,
   masthead/Playfair render, subscriber fan-out, bounce flip. Output artifact compared field-by-field to an n8n run.
4. **PROD**: provision `newsletter-svc` (production env), shadow if desired, then flip `NEWSLETTER_BACKEND=python` in
   PROD. Redis must be healthy (see [[prod-redis-outage-risk]]).
5. **Decommission**: once PROD is clean for the agreed window, archive (don't delete) the n8n compose workflow
   (`[ARCHIVED-YYYY-MM-DD] Content - Newsletter Agent V2`), remove its webhook from the active path, update
   [[workflow-id-map]] / [[newsletter-cluster]] / [[work-ordering-2026-05]] and `CLAUDE.md` baseline notes.
6. **Rollback**: flip `NEWSLETTER_BACKEND=n8n` (workflow kept archived, not deleted, for the rollback window).

Sequenced inside **Sprint 20 (Phase D)**; supersedes the single-module sketch in [[service-decomposition]] for the
newsletter cluster.

## 11. Risks + genuine product decisions for the user

**Decisions (resolved 2026-05-29):**
1. **Subscriber delivery = BOTH** — Postal email **and** a hosted web archive/permalink (see `deliver-svc`, §4).
2. **Picker model = Gemini 2.5 Pro** (kept; configurable via `PICKER_MODEL`).
3. **Image selection = in-UI review gate** — third human gate `awaiting_image_approval` (§5, §7).
4. **Granularity = true per-step microservices** on a shared engine library (§3) — revises [[master-plan]]; see
   [[engine-framework]].

**Risks:** prompt/parity drift from n8n (mitigated by verbatim prompt port + field-by-field artifact diff);
long-pause HITL (mitigated by the durable state machine — no held workers); SSE bridging correctness (mitigated by
reusing the existing Express SSE endpoint + Redis pub/sub); external-source scrape flakiness (per-URL error filter,
mirror n8n); Redis dependency (gate on health before cutover).

See also: [[master-plan]] · [[service-decomposition]] · [[api-contracts]] · [[queueing-architecture]] ·
[[deployment-railway]] · [[python-migration-roadmap]] · [[newsletter-cluster]] · [[newsletter-test-plan]].
