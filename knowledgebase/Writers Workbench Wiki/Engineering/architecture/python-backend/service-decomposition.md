---
name: Service decomposition
description: Every n8n workflow mapped to a Python module. ~10 logical modules grouped into 3 Docker service groups for deployment.
type: concept
tags: [architecture, python-backend, decomposition]
last_reviewed: 2026-05-09
---

# Service decomposition

Every n8n workflow that's migrating becomes a Python module. Modules group into Docker service groups (heavy / light / cron) for independent scaling.

## Module map

| # | Module | Replaces n8n workflow | Service group | LOC est. |
|---|---|---|---|---|
| 1 | `hub` | **PROD - The Author Agent** (hub itself) | api-svc | ~1500 |
| 2 | `chapter` | Worker - Write Chapter, Tool - Write Chapter, Tool - Write Blog Post, Tool - Write Newsletter, Tool - Write Short Story, Tool - Format Kindle Book, Tool - QA Chapter, Tool - Rewrite Chapter with Research, Tool - Scan Character Drift, Tool - Evaluate Genre Compliance, Sub - Build Chapter Context | worker-heavy | ~2500 |
| 3 | `brainstorm` | Tool - Brainstorm Story, Tool - Brainstorm Chapter, Tool - Edit Outline | worker-heavy | ~800 |
| 4 | `research` | Sub - Research Pipeline, Tool - Email Research Report | worker-heavy | ~600 |
| 5 | `media` | Tool - Generate Cover Art, Tool - Repurpose to Social Posts, Node - Scrape Url V2 | worker-heavy | ~700 |
| 6 | `library` | Sub - Manage Library, Sub - Retrieve Content, Tool - Manage Library | api-svc (sync) | ~600 |
| 7 | `story_bible` | Sub - Manage Story Bible, Sub - Manage Research Reports | api-svc (sync) | ~300 |
| 8 | `approval` | Sub - Approval Token Generator | api-svc (sync) | ~200 |
| 9 | `notify` | Sub - Eve Knowledge Callback, **Tool - Reset Eve Greeting** | api-svc (sync) + worker-light (delayed jobs) | ~400 |
| 10 | `newsletter` | Content - Newsletter Agent V2, Newsletter Ingestion Multi-User Cron, Newsletter Cadence Cron | worker-cron + worker-heavy | ~1200 |
| 11 | `scheduler` | Cron: Scheduled Publisher | worker-cron | ~150 |

**Stays in n8n**: V1 (Orig) workflows only. Frozen per CLAUDE.md baseline protection. Used by V1 customers on the baseline Eve agent. Not on the active path for any new customer.

**~8,950 LOC total Python** (excluding tests, infrastructure, type definitions). Add ~4,000 LOC tests = **~13,000 LOC**. Realistic 14-16 weeks for two engineers full-time.

For the hub module's full design, see [[hub-architecture]]. It includes: webhook receivers, `preprocess_message` regex pre-routing, agent loop (Claude Haiku 4.5 with tool-use), tool dispatcher, Eve-specific behaviors, response composition.

## Module 1: `chapter`

### Scope

Everything related to writing chapters + variants of long-form content (blog posts, newsletters, short stories share the underlying mechanics) + chapter-quality tooling.

### Endpoints

#### Public (`/v1/`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/chapters/write` | POST | Generate a chapter (or chapter-equivalent: blog post, short story, newsletter content). |
| `/v1/chapters/{id}/qa` | POST | Run 9-check Q/A on an existing chapter. Returns `qa_report`. |
| `/v1/chapters/{id}/scan-drift` | POST | Run deterministic drift scanner. Returns `_character_drift_scan` shape. |
| `/v1/chapters/{id}/rewrite-with-research` | POST | Citations-aware rewrite using research pipeline. |
| `/v1/chapters/{id}/evaluate-genre` | POST | Genre-compliance evaluator. Returns prose/outline/observations adaptations. |
| `/v1/chapters/{id}/extract-bible` | POST | Re-extract story bible entries (used for backfill). |
| `/v1/projects/{id}/cross-chapter-continuity` | POST | NEW capability: project-wide consistency check; optional auto-rewrite. |
| `/v1/chapters/{id}/format-kindle` | POST | Format chapter for KDP export. |
| `/v1/chapters/build-context` | POST | Build LOCKED CHARACTER ROSTER context document. (Internal mostly; exposed for power users.) |

#### Internal (`/internal/`)

Mirror of the above, with shared-secret auth + identity-by-payload.

### Inputs / outputs

```python
# /v1/chapters/write request
class WriteChapterRequest(BaseModel):
    project_id: UUID
    chapter_number: int           # 0=Prologue, 999=Epilogue, otherwise normal
    chapter_run_id: UUID          # idempotency key
    llm_strategy: Literal['sonnet','haiku','hybrid-draft-polish','hybrid-smart','tier-default'] = 'tier-default'
    research_topic: str | None = None
    style_directives: list[str] = []
    sub_chapter_count_override: int | None = None
    use_qa_report_as_input: bool = False
    citation_mode: Literal['auto','invisible','inline'] = 'auto'

class WriteChapterResponse(BaseModel):
    chapter_id: UUID
    chapter_run_id: UUID
    content_text: str
    word_count: int
    sub_chapter_count: int
    bible_entries_added: int
    metadata: dict
    timing: ChapterTiming         # wall_time_ms, queue_wait_ms, llm_time_ms
    cost: ChapterCost             # input_tokens, output_tokens, $ at current pricing
```

### Internal sub-routines (not HTTP endpoints; module-internal)

- `build_chapter_context(project_id, chapter_number) → ChapterContext` — replaces `Sub - Build Chapter Context`. LOCKED CHARACTER ROSTER builder.
- `build_sub_chapter_prompts(ctx, strategy) → list[SubChapterPrompt]` — splits chapter into sub-chapters per outline.
- `write_sub_chapter(prompt, llm) → str` — single Anthropic call with retry.
- `merge_continuity(sub_chapters, ctx) → str` — chainLlm equivalent.
- `extract_bible(chapter_text, existing_bible) → list[BibleEntry]` — defensive JSON parse.
- `persist_chapter(req, content, bible_entries) → ChapterRecord` — idempotent UPSERT keyed on `chapter_run_id`.

### Token cost per call (estimated)

| Operation | Sonnet tokens | Haiku tokens (when applicable) | Cost @ Tier 3 |
|---|---|---|---|
| write (5 sub-chapters, all Sonnet) | 27k output | 0 | $0.40 |
| write (Haiku sub-chapters, Sonnet merge+extract) | 7k output | 20k output | $0.13 |
| qa | 4k output | 0 | $0.06 |
| scan-drift | 0 (deterministic) | 0 | $0.00 |
| rewrite-with-research | 30k output | 0 | $0.45 |
| evaluate-genre | 6k output | 0 | $0.09 |
| cross-chapter-continuity | 50k input + 5k output | 0 | $0.15 |
| extract-bible | 2k output | 0 | $0.03 |

## Module 2: `brainstorm`

### Scope

Outline generation + lightweight outline edits.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/brainstorm/story` | POST | Generate full story outline (chapters, characters, themes, premise). Saves to `writing_projects_v2.outline`. |
| `/v1/brainstorm/chapter` | POST | Generate sub-chapter outline for an existing chapter. Saves to `outline.chapters[N].chapter_outline`. |
| `/v1/brainstorm/edit-outline` | POST | Targeted edits (ages, names, descriptions). No full re-brainstorm. |

### Internal sub-routines

- `derive_story_arc_prompt(arc_name) → str` — load arc by name from `story_arcs_v2`.
- `do_research(topic, genre) → ResearchSummary` — calls research module (cross-module dep).
- `compose_outline(research, requirements, arc) → Outline` — Claude call with structured output.
- `revise_outline(existing, edits) → Outline` — preserves locked characters per CLAUDE.md rules.

## Module 3: `research`

### Scope

Perplexity + Claude pipeline for research reports.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/research/run` | POST | Full research pipeline. Derives 3-5 questions, runs Perplexity, synthesizes report. Inserts `research_reports_v2` row. |
| `/v1/research/{id}` | GET | Fetch report. |
| `/v1/research/{id}/email` | POST | Email a saved report to `recipient_email`. |

### Internal

- `derive_questions(topic, context) → list[str]` — chainLlm replacement: Claude generates focused questions.
- `query_perplexity(question) → PerplexityResult` — native API call.
- `synthesize_report(questions, results) → str` — Claude composes narrative report.
- `persist_report(req, report) → ResearchRecord`.

## Module 4: `media`

### Scope

Cover art generation, social-post repurposing, URL scraping (newsletter feeder).

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/media/cover-art` | POST | Generate cover image via KIE.AI (default) or DALL-E 3 (fallback). Upload to `cover-images` bucket. INSERT `generated_images_v2`. |
| `/v1/media/social-posts` | POST | Multi-platform posts (Twitter/LinkedIn/Instagram/Facebook). INSERT `social_posts_v2`. |
| `/v1/media/scrape-url` | POST | Firecrawl wrapper. Returns `{markdown, html, metadata}`. |

### Internal

- `generate_image_kieai(prompt) → bytes` — KIE.AI client with retries.
- `generate_image_dalle(prompt) → bytes` — fallback.
- `upload_to_storage(bucket, path, bytes) → url` — Supabase Storage REST.
- `compose_social_posts(content, platforms) → list[SocialPost]` — Claude per platform.
- `firecrawl_scrape(url) → ScrapeResult`.

## Module 5: `library`

### Scope

Content lifecycle CRUD + retrieve operations. The most-called module by hub volume.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/library/insert-draft` | POST | INSERT `published_content_v2` with content. |
| `/v1/library/{action}` | POST | Bulk actions: `approve`, `publish`, `reject`, `schedule`, `unschedule`. `action` in path. |
| `/v1/library/versions/{content_id}` | GET | List `content_versions_v2`. |
| `/v1/library/versions/{content_id}/{version_number}` | GET | Get specific version. |
| `/v1/library/{content_id}/save-version` | POST | Create snapshot. |
| `/v1/library/{content_id}/revert/{version_number}` | POST | Restore prior version. |
| `/v1/library/retrieve` | GET | List/search/filter. Replaces `Sub - Retrieve Content`. Supports `content_type`, `search_term`, `project_id`, `status` filters. |
| `/v1/library/projects/{project_id}/chapters` | GET | All chapters for a project. |
| `/v1/library/outlines` | GET | All projects with non-empty outlines. (Replaces `list_outlines` operation.) |
| `/v1/library/outline-versions/{project_id}` | GET | List `outline_versions_v2` for a project. |
| `/v1/library/outline-versions/{project_id}/revert/{version_number}` | POST | Restore outline. |

### Internal

- `apply_status_transition(content_id, action) → bool` — validates state machine + emits email.
- `list_with_filters(user_id, filters) → list[Content]` — translates query params to Supabase select.
- Stop-words list for `retrieve` — same as n8n version (avoid keyword pollution on bare `outline`/`outlines`).

## Module 6: `story_bible`

### Scope

Story bible + research report CRUD. Called from chapter module (extract_bible UPSERTs) and from hub directly (user-driven add/edit).

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/story-bible/{action}` | POST | `action` in `add | edit | delete | list`. |
| `/v1/story-bible/projects/{project_id}` | GET | All entries for a project. |
| `/v1/research-reports/{action}` | POST | `add | list | delete`. |

### Internal

- `upsert_bible_entry(project_id, entry) → BibleEntry` — dedupe on `(entry_type, lower(name))`.

## Module 7: `approval`

### Scope

Token issuance + validation for newsletter approvals (and future approval flows).

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/approvals/issue` | POST | Generate token + INSERT `newsletter_approvals_v2`. |
| `/v1/approvals/{token}` | GET | Validate token + return associated payload. |
| `/v1/approvals/{token}/{action}` | POST | `action` in `approve | reject | extend`. Updates underlying entity. |

### Internal

- `generate_token() → str` — cryptographically random.
- `validate_token(token) → ApprovalRecord | None`.

## Module 8: `notify`

### Scope

Eve callback routing (web SSE vs phone) + ElevenLabs admin (KB upload, agent first_message reset).

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/notify/eve-callback` | POST | Routes web SSE or phone. Replaces `Sub - Eve Knowledge Callback`. |
| `/v1/notify/eve-reset-greeting` | POST | Reset agent first_message. (May be auto-scheduled internally.) |
| `/v1/notify/email` | POST | Email send. (Currently lives in Workbench `lib/email.ts`; may move here for consolidation.) |

### Internal

- `is_web_session_active(user_id) → bool` — calls Workbench `/api/session/active`.
- `upload_to_eve_kb(agent_id, content) → str` — ElevenLabs API.
- `trigger_outbound_call(agent_id, to, first_message) → CallId` — Twilio via ElevenLabs.

## Module 9: `newsletter`

### Scope

Newsletter ingestion + composition + cadence cron + subscriber fan-out.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/newsletter/ingest` | POST | Single-URL ingestion. Replaces `Node - Scrape Url V2` + upload chain. |
| `/v1/newsletter/cron/ingestion` | POST (X-Cron-Secret) | Multi-user ingestion run. |
| `/v1/newsletter/cron/cadence` | POST (X-Cron-Secret) | Cadence cron. Polls editions due, triggers compose. |
| `/v1/newsletter/compose` | POST | Compose newsletter for an edition. Drafts via Claude, renders via Handlebars-equivalent (Jinja2), saves `newsletter_sends_v2`. |
| `/v1/newsletter/{send_id}/send-to-subscribers` | POST | Fan out to `newsletter_subscribers_v2`. |

### Internal

- `gather_ingestion_items(edition_id, since) → list[Article]` — pulls from `content_ingestion_v2`.
- `render_newsletter(template_id, edition, articles) → str` — Jinja2 merge.
- `fetch_active_subscribers(edition_id) → list[Subscriber]`.

## Module 10: `scheduler`

### Scope

The Cron: Scheduled Publisher workflow + tier admin crons (trial check, credit reset, trial warnings) — already partially in Workbench `routes/cron.ts`; could centralize here.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/scheduler/run-publisher` | POST (X-Cron-Secret) | Publish all `published_content_v2` rows where `metadata.schedule_date <= now()`. |
| `/v1/scheduler/trial-check` | POST (X-Cron-Secret) | Flip expired trials. |
| `/v1/scheduler/credit-reset` | POST (X-Cron-Secret) | Monthly credit reset. |
| `/v1/scheduler/trial-warnings` | POST (X-Cron-Secret) | Send 7d/3d/1d expiry emails. |

These run as scheduled jobs on the cron-group container (single replica).

## Cross-cutting concerns

### Configuration

`/etc/author-agent/config.yaml` (or env vars) carries:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `KIE_AI_API_KEY`, `OPENAI_API_KEY` (for DALL-E fallback), `ELEVENLABS_API_KEY`, `FIRECRAWL_API_KEY`
- `REDIS_URL`
- `WORKBENCH_API_URL` (for back-calls to /api/email/send when needed)
- `SERVICE_SHARED_SECRET` (X-Service-Secret value)
- `ADMIN_TOKEN` (for /admin/* endpoints)

### Logging

Structured JSON via `structlog`. Per-request fields: `request_id`, `tenant_id` (or `user_id` internal), `module`, `endpoint`, `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd`. Shipped to stdout → Railway log stream → optional Datadog/Honeycomb sink.

### Metrics

Prometheus-format `/metrics` endpoint. Counters: requests, errors, tokens. Histograms: latency, queue wait. Gauges: in-flight jobs, queue depth.

### Tracing

OpenTelemetry instrumentation. Spans per HTTP request + per LLM call + per DB query. Optional export to Honeycomb / Tempo.

### Background tasks

BullMQ via shared Redis (consistency with [[job-queue|Workbench job queue]]). Heavy operations enqueue and respond `{job_id}`; client polls `/v1/jobs/{job_id}` for completion. Or webhook callback if customer registered one.

### Rate limiting

Per-API-key sliding window (Redis INCR + 60s expire). Tier-based quotas. See [[productization]].

### Idempotency

Every chapter-write / brainstorm / research call carries an idempotency key (`chapter_run_id`, `brainstorm_run_id`, etc.). Hashed key + result cached in Redis 24h. Repeat call within window returns cached result.

## Module dependency graph

```
                  ┌────────┐
                  │ chapter │
                  └────┬────┘
        ┌──────────────┼──────────────┬─────────────┐
        ▼              ▼              ▼             ▼
   ┌────────┐    ┌────────────┐ ┌──────────┐ ┌──────────┐
   │research│    │story_bible │ │ media    │ │ library  │
   └────────┘    └────────────┘ └──────────┘ └──────────┘
        ▲                              ▲
        │                              │
   ┌────┴───────┐              ┌──────┴─────┐
   │ brainstorm │              │ newsletter │
   └────────────┘              └────────────┘
                                      │
                                      ▼
                                 ┌──────────┐
                                 │ approval │
                                 └──────────┘

cron-group:
  scheduler (no deps; calls library + notify)
  newsletter cron entry points (call newsletter module)
```

## Compatibility shim — gradual rollout

During migration, hub can selectively call Python service OR n8n workflow per tool, controlled by `app_config_v2.python_backend_routing`:

```json
{
  "python_backend_routing": {
    "write_chapter": "python",        // migrated
    "qa_chapter": "python",            // migrated
    "brainstorm_story": "n8n",         // not yet
    "cover_art": "n8n",                // not yet
    ...
  }
}
```

Hub reads at startup; routes accordingly. Allows per-tool cutover.

## Per-module migration order (sprint-aligned)

| Module | Migration sprint | Why this order |
|---|---|---|
| chapter (excl. cross-chapter) | 16 | Highest scaling impact |
| brainstorm | 17 | Depends on research; medium effort |
| research | 17 | Required by brainstorm + chapter (rewrite) |
| qa + drift + genre-eval | 17 | Bundled with chapter ports |
| media | 18 | Cover art + social; isolated |
| library | 19 | Most-called; biggest port surface |
| story_bible | 19 | Co-located with library |
| approval | 19 | Light dependency |
| notify | 19 | Light dependency |
| newsletter | 20 | Whole cluster moves at once |
| scheduler | 20 | Fast |
| cross-chapter continuity | 21 | NEW capability — after main migration stable |
| productization layer | 22-24 | After internal migration validated |

See [[python-migration-roadmap]] for the full sprint plan.
