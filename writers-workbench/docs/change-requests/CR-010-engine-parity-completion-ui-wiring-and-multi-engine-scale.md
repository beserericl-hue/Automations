# CR-010 — Engine parity completion, full UI wiring, and multi-engine load balancing

| | |
|---|---|
| **Status** | Proposed |
| **Opened** | 2026-06-09 |
| **Tier** | DEV first; PROD at engine go-live |
| **Goal** | Close every remaining gap between the n8n V2 workflows, the Python engine, and the Workbench UI so the engine can fully replace n8n, **and** finish the multi-engine load-balancing work started in [CR-003](CR-003-scaling-rate-limits-load-balancing.md). |
| **Supersedes/rolls up** | the open parity items in [CR-009 Part 2](CR-009-engine-task-emails-and-remaining-parity.md); the remaining scale items in [CR-003](CR-003-scaling-rate-limits-load-balancing.md) |

## Method

Audited all three layers independently and cross-referenced:
- **n8n** — the 24 V2 workflows in `workflows/01..24_*.json` (the canonical user-facing function set + the hub `preprocess_message` router + 19 ai_tools).
- **Engine** — `engine/packages/writer_engine/src/writer_engine/hub/catalog.py` (21 routable `tool.op`) + each `engine/services/*/src/*/main.py` OPS dict.
- **UI** — every action in `client/src/components/**` traced to its server route (`server/src/routes/*`) and backend (n8n | engine | direct-Supabase | BullMQ).

Legend: ✅ complete · 🟡 partial · ❌ missing/stub.

---

## Part A — Engine parity gaps (n8n function → engine status)

Most of the writing surface is already at parity. These are the **remaining** gaps, in priority order.

### A1 — Stubs that return fake/placeholder data (highest priority — silently "succeed")

| n8n function | Engine | Evidence | Required work |
|---|---|---|---|
| **Format Kindle book** (`19_tool_format_kindle_book_v2`) | ✅ RESOLVED — removed from engine | The Workbench **Export tab** already builds a KDP `.docx` entirely server-side (`POST /api/export/docx`, the `docx` lib, reads `published_content_v2`) and never called the engine. The engine `chapter.format-kindle` op was a stub returning a fake path, reachable only via a chat "format kindle" command. **Removed** (catalog entry, `_op_format_kindle`, OPS entry, router heuristic + regexes); a "format for kindle" chat message now degrades to conversation. Export tab is the canonical Kindle path. (Done 2026-06-10.) |
| **Eve knowledge callback** (`16_sub_eve_knowledge_callback_v2`) | ❌ placeholder | `notify_step/main.py:29-39` `_op_eve_callback` only echoes `{"routed_via": "sse"\|"phone"}`; `_op_eve_reset_greeting` returns `{"reset": True}` — no ElevenLabs KB injection, no outbound call | Implement the n8n flow against ElevenLabs Conversational AI: remove stale "Eve Session:" KB docs, upload `content_text` as a KB doc, attach it to the agent, set the `review`/`brainstorm` `first_message`, trigger the outbound call, then reset greeting. Gate behind the Eve-agent cutover (baseline-protected — needs explicit go-ahead). |

### A2 — Partial implementations (work, but miss n8n behavior)

| n8n function | Engine | Evidence | Required work |
|---|---|---|---|
| **Embeddings / semantic retrieval** (`21_sub_embed_project_data_v2` + `search_project_knowledge` in `11b`) | 🟡 code exists, **off** | `ENABLE_PYTHON_EMBEDDINGS=false` (`config.py:95`); `embeddings/embed.py` `re_embed_project` exists but **no step service triggers it**, and `chapter.write` does not retrieve from `writing_embeddings_v2`. n8n rebuilds embeddings after every outline/chapter-outline save and the chapter worker grounds each sub-chapter via vector search. | Enable the flag; trigger `re_embed_project` after `brainstorm.story` / `revise-outline` / `edit-outline` / `chapter.plan` (mirror n8n WF-21 fan-out); wire vector retrieval into `chapter.write` (and `repair`) so prose is grounded in project canon. **This is a quality-parity gap, not just a feature gap** — without it engine chapters lose the canon-grounding n8n had. |
| **Token + cost accounting** (`22_sub_token_tracker_v2`, CR-007) | 🟡 chapter-only | `token_accounting` `begin`/`flush` is called **only** in `chapter_step` (grep confirms). `brainstorm`, `research`, `media`, newsletter steps don't record `token_usage_v2`. | Wrap every LLM-bearing op handler (`brainstorm.*`, `research.run`, `media.*`, newsletter saga steps) in `begin`/`flush` so `token_usage_v2` is complete. Centralize in `run_write_tool_job` where possible. |
| **Manage library — versions** (`13_sub_manage_library_v2`: `list_versions`/`get_version`/`save_version`; `15`: `outline_versions`/`revert_outline`/`chapter_versions`/`revert_chapter`) | ❌ not hub-routable | `library_step` OPS = `insert-draft`/`lifecycle`/`retrieve`/`list-outlines` only; docstring promises "versions" but no op. `content_versions_v2`/`outline_versions_v2` are written but cannot be listed/reverted via the hub or Eve. | Add `library.versions` (list/get/save) and `library.revert` (outline + chapter) ops + catalog entries, reading/writing `content_versions_v2` and `outline_versions_v2`. (UI already does versions via direct Supabase — see B; this gap is about **Eve/hub** parity.) |
| **Manage story bible — update** (`09_sub_manage_story_bible_v2`: `get`/`update`) | 🟡 not fully routable | `story_bible_step` has `add`/`list` but catalog routes only `story_bible.list`. No `edit`/`delete`; `add` reachable only internally. | Add `story_bible.add`/`update` catalog entries so "add/update a bible entry" works from the hub/Eve. |
| **Email me the {outline/research/chapter}** (`13` `email_content`, hub `email_report` tool) | ❌ missing | CR-009 added task-completion emails on generation, but there is no on-demand "email me X" op. | Add a `library.email-content` op (resolve item → markdown→HTML → Postal) so "email me the outline for X" works. |

### A3 — Pipelines not in the engine at all

| n8n function | Engine | Required work |
|---|---|---|
| **Content ingestion** (`05_data_content_ingestion_v2`) + **AI scraping pipeline** (`06`, daily cron over all genres → `content_index`/`content_ingestion_v2`) | ❌ none | The engine *consumes* `content_ingestion_v2` (gather_step, blog/newsletter "recent content") but has **no producer**. Decide: keep the n8n scraping cron as the ingester (simplest — it's a data pipeline, not user-facing), **or** port it to an engine cron (`scrape_step` already does per-URL Firecrawl; add a genre-loop scheduler + indexer). Until decided, blog/newsletter grounding silently degrades if n8n is turned off. |
| **Gateway B2B `/v1/*`** | ❌ stub | `GET /v1/whoami` only ("real keys Sprint 23"). Out of scope for n8n parity; track separately. |

### A4 — Dead code to remove (not gaps, but cleanup)

- `brainstorm_step` `chapter` op — returns empty beats; superseded by `chapter.plan`. Remove from OPS to avoid misroutes.
- `library_retrieve_step` — F0 vertical-slice demo, superseded by `library_step`. Remove or mark deprecated.

---

## Part B — UI connection gaps (everything wired from the Workbench)

The chat drawer + the buttons we just queued (Outline/Re-outline, Write/Rewrite, Q/A, Fix Drift, Generate Cover Art) all route through `/api/chat/proxy` → engine when `HUB_BACKEND=engine`. Remaining gaps:

### B1 — Buttons that still bypass the engine (route to n8n even when `HUB_BACKEND=engine`)

| UI action | Server route | Today | Required work |
|---|---|---|---|
| **Rewrite with research** (ContentDetail + Chapters tab modal) | `POST /api/content/:id/rewrite-with-research` | ✅ DONE (`bfe2c6b`) — engine `chapter.repair` when `HUB_BACKEND=engine`, n8n fallback | Branches on `hubBackend()`; threads `research_focus`/`style_directives`/`citation_mode` through `_op_repair` → returns an engine job_id the `useEngineJobQueue` poller reads. |
| **Submit Brainstorm** (Brainstorm page) | `POST /api/brainstorm/submit` | ✅ DONE (`bfe2c6b`) — engine `create-project`+`brainstorm.story` when `HUB_BACKEND=engine`, n8n fallback | Branches on `hubBackend()`: creates the project (sync) then queues `brainstorm.story` with `persist`. |
| **Analyze Content** (Brainstorm parse) | `POST /api/brainstorm/parse` | direct Anthropic SDK server-side | Acceptable (fast, non-hub). Leave, or move behind the engine for one code path. Low priority. |

### B2 — Blocking / inconsistent UX

| UI action | Issue | Required work |
|---|---|---|
| **Fix Drift in the ContentDetail "Engine QA" panel** | ✅ DONE (`bfe2c6b`) — non-blocking + Cancel via new shared `useChapterRepair` hook (Chapters-table button refactored onto it too) | (was an in-function `while`+`setTimeout` loop) |
| **Approve / Publish via ContentDetail** | ✅ DONE (`bfe2c6b`) — routes through new `POST /api/content/:id/lifecycle` → engine `library.lifecycle` (snapshot+email), with a server-side snapshot+status fallback | engine `library.lifecycle` now does the auto-version snapshot + approve/publish/reject/schedule email. |
| **`sendWebhookCommand`** in `client/src/lib/webhook.ts` | ✅ DONE (`bfe2c6b`) — deleted | — |

### B3 — Functions with no UI entry point (chat-only / orphaned)

These work only by typing in the chat drawer; add first-class buttons:

| Function | Where a button belongs |
|---|---|
| **Run research report** | a "Research this" button on the project/research views (today chat-only) |
| **Repurpose to social** | a "Generate posts" button in `SocialMediaPanel` (today view-only + chat-only) |
| **Generate image / cover** from the gallery | a "Generate" button in `ImageGallery` (today only via Outline-tab button / chat) |
| **Story bible add/edit** | `StoryBiblePanel` is read-only; add entry CRUD once A2 (`story_bible.add/update`) lands |
| **Format Kindle / Export** | Export tab exists (`/api/export/docx`); surface it as the canonical "Kindle" path once A1(b) routes the hub op there |

### B4 — Known non-engine items (track, not blockers)

- **Buy More Credits** (`POST /api/credits/purchase`) grants credits with **no payment** — Stripe is Sprint 9.
- **Talk to Eve** widget is browser-direct to ElevenLabs; the engine voice webhook (`/internal/hub/voice`) exists but the **agent is not pointed at it** (baseline-protected; needs go-ahead). Ties to A1 Eve callback.

---

## Part C — Multi-engine load balancing (extends CR-003)

CR-003 already **wired the core**: stateless gateway, arq-on-Redis queue, a **Redis-shared Anthropic budget** so N instances draw from one rate pool, `MAX_CONCURRENT_LLM` per-instance semaphore, and 429 backoff. The model is "+10 users = +1 engine instance." Remaining work to actually run multi-instance safely:

### C1 — Run more than one of each (the actual horizontal scale)

- **Gateway replicas behind a load balancer** — gateway is stateless; set Railway replica count > 1 and confirm the LB health-checks `/admin/health`. (Today: single instance.)
- **Multiple runtime/worker instances** — each connects to the same Redis; verify arq workers across instances don't double-run a job (arq is single-delivery, but confirm `job_id` dedupe on re-enqueue).
- **Graceful drain on deploy** — readiness probe flips unready, worker finishes in-flight jobs before SIGTERM (avoid killing a 90-min chapter mid-flight). `allow_abort_jobs=True` (shipped `dae99d7`) means an explicit cross-instance Cancel already works via Redis.

### C2 — Per-provider shared budgets (not just Anthropic)

The shared budget today covers Anthropic only. Multi-instance fan-out will 429 the **other** providers:
- **OpenAI** (embeddings once A2 lands; DALL-E fallback), **Perplexity** (research/blog/newsletter), **Gemini** (hub router + newsletter pick). Add Redis-shared budgets per provider mirroring `AnthropicBudget`.

### C3 — Queue separation so big jobs don't starve quick ones

- Today everything is on the single `"newsletter"` arq queue. A 96-chapter "write all" batch will starve interactive `qa`/`plan`/`cover-art`. Split into **heavy** (chapter write/rewrite/repair, brainstorm) and **light/interactive** (qa, plan, media, lifecycle) queues with separate worker concurrency; optionally priority within a queue.

### C4 — Resilience + observability (the gap the PROD Redis outage exposed)

- **Redis is the single stateful hinge and a SPOF.** A silent Redis death broke BullMQ+SSE for 9 days (see `project_prod_redis_outage_risk`). Move to managed/HA Redis and add **uptime + queue-depth alerting** (none today).
- **Autoscaling policy** — scale worker instances on queue depth / oldest-job-age, not guesswork.
- **Per-instance + fleet metrics** — jobs in flight, queue depth, budget utilization per provider, LLM 429 counts; a dashboard so "add an instance" is data-driven (CR-003's capacity math made actionable).

---

## Consolidated work breakdown (suggested order)

1. **A1 stubs** — Eve callback (gated on go-ahead) + Format-Kindle route-to-export. *Stop functions that silently fake success.*
2. **A2 embeddings + token accounting** — restore canon-grounding parity and complete cost tracking.
3. **B1 + B2** — engine path for rewrite-with-research & brainstorm submit; non-blocking Fix-Drift panel; lifecycle snapshot+email; delete `sendWebhookCommand`.
4. **A2 versions/bible + A3 email-content** — full hub/Eve parity for library/bible/email.
5. **B3** — first-class buttons for research / social / image / bible.
6. **C1–C4** — turn on multi-instance: replicas + LB, per-provider budgets, queue split, HA Redis + alerting + autoscaling.
7. **A3 ingestion decision** — keep n8n cron vs port to engine.
8. **A4 cleanup** — remove dead ops.

## Acceptance

- Every n8n V2 user-facing function has a **complete** engine implementation (no stub returns), reachable both from the hub/Eve **and** a Workbench control.
- With `HUB_BACKEND=engine`, **no** user action falls back to n8n (rewrite-with-research and brainstorm submit included); n8n can be turned off for everything except (optionally) the ingestion cron.
- Two+ gateway replicas and two+ worker instances run against shared Redis with per-provider shared budgets; a 96-chapter batch does not stall interactive ops; Redis is HA with uptime + queue-depth alerting.

## Out of scope (tracked elsewhere)

- Stripe payments (Sprint 9). Gateway B2B `/v1` keys (Sprint 23). Pointing the PROD Eve agent at `/internal/hub/voice` (baseline-protected; explicit authorization required).
