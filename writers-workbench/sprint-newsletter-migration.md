# Sprint: Newsletter Agent Migration → Writer's Workbench

**Version:** 1.0
**Date:** 2026-04-19
**Methodology:** Scrum — 2-week sprint, story points (Fibonacci), Definition of Done includes tests
**Total:** 11 stories, 36 points
**Goal:** Move the three-workflow newsletter sub-system off EC2/S3/Slack and into the Writer's Workbench Supabase data layer. Replace the final distribution channel with GoHighLevel. Add the previously-dropped Reddit self-post ingestion branch. Fix the broken scrape executeWorkflow pointer.

---

## Context

Three n8n workflows at `n8n.agileadautomation.com` form the newsletter production pipeline:

| Workflow ID | Name | Role | Status |
|---|---|---|---|
| `53SlwZMS21gpvz3H` | **AI News Data Ingestion Orig** | Scrapes 17 feeds daily, writes markdown/HTML + metadata to an AWS S3 bucket `data-ingestion` via an in-house EC2 proxy at `api.aitools.inc/admin/files/*` | **inactive** |
| `4DQ7DmA9pFtXzsKX` | **Content - Newsletter Agent** | Reads those S3 objects by date prefix, picks top stories via LLM, assembles a newsletter, uses 9 Slack nodes (including 2 `sendAndWait` approval gates) on channel `C08PGU0CLKS` | **inactive, 87 nodes** |
| `bXBsnU4d6OseXWho` | **Node - Scrape Url** | Firecrawl-based URL scraper, called via `executeWorkflow` from the ingestion workflow | **inactive, 2 nodes — WORKING REPLACEMENT, just not wired up** |

All three must move together as a logical group. The ingestion workflow's `scrape_url` node currently points at `qVEM2rCD1jlJPeRs` (404), but `Node - Scrape Url` is the working replacement — it just isn't activated or wired up.

### Five problems this sprint solves

1. **EC2/S3 dependency** — `api.aitools.inc` is an in-house EC2 proxy, and the S3 bucket is outside the Writer's Workbench environment. Target: align with Writer's Workbench Supabase (Postgres + Storage) — same DB that `Tool - Write Newsletter V2` and the other V2 workflows already use.
2. **Slack dependency** — 9 Slack nodes across approval gates and notifications; the business runs on Gmail (internal) and GoHighLevel (external subscribers).
3. **Broken scraper wiring** — `scrape_url` executeWorkflow points at a 404 workflow ID; the working Firecrawl replacement exists but isn't activated.
4. **Reddit self-post loss** — the Reddit filter drops all self-posts (`url_overridden_by_dest` absent), so the richest Reddit content (full user-written posts — a 15-post live sample totalled 18,125 body chars) never reaches the newsletter.
5. **No external distribution channel** — after approval the final newsletter currently emails to a small Gmail distribution list. For production, it must publish through **GoHighLevel** (CRM) to the subscriber audience.

### Outcome

All three workflows run entirely against the **Writer's Workbench Supabase** data layer. Approvals and ops messages go through Gmail. Ingestion captures full Reddit content including self-posts. Final distribution goes through GoHighLevel. No EC2, no external S3, no Slack remain in this pipeline.

### Relationship to existing Writer's Workbench

This sprint is **Phase 1 — backend groundwork**. It creates the data model and service endpoints the newsletter sub-system will share with the rest of Writer's Workbench, but does not yet surface the newsletter agent in the web UI. A future sprint (Phase 2) will add newsletter pages to the web app: a subscriber list manager, a send history viewer, a manual-trigger UI, and an approval viewer that complements the Gmail approval links.

Existing Writer's Workbench Supabase usage (users_v2, writing_projects_v2, published_content_v2, genre_config_v2, story_arcs_v2, etc.) is **unchanged** by this sprint. The new tables (`content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2`) follow the established V2 conventions: `user_id` partitioning, soft-delete via `deleted_at`, JSONB for flexible metadata, RLS policies mirroring the other V2 tables.

---

## Writer's Workbench-Native Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                 n8n (n8n.agileadautomation.com)                              │
│                                                                              │
│  ┌──────────────────────────┐    ┌──────────────────────────┐                │
│  │  AI News Data            │    │  Content Newsletter      │                │
│  │  Ingestion V2            │    │  Agent V2                │                │
│  │  (clone of 53SlwZMS...)  │    │  (clone of 4DQ7DmA9...)  │                │
│  │                          │    │                          │                │
│  │  17 triggers:            │    │  form_trigger(Date)      │                │
│  │   6 RSS + 1 Beehiiv +    │    │         │                │                │
│  │   7 rss.app JSON +       │    │         ▼                │                │
│  │   3 Reddit direct        │    │  GET /api/ingestion/     │───┐            │
│  │         │                │    │      search?prefix=Date  │   │            │
│  │         ▼                │    │         │                │   │            │
│  │  split + filter          │    │         ▼                │   │            │
│  │         │                │    │  GET /api/ingestion/     │◄──┤            │
│  │   ┌─────┴─────┐          │    │      get/:key (per item) │   │            │
│  │   ▼           ▼          │    │         │                │   │            │
│  │  LINK       SELF-POST    │    │         ▼                │   │            │
│  │  POSTS      (NEW BRANCH) │    │  pick_top_stories (LLM)  │   │            │
│  │   │           │          │    │         │                │   │            │
│  │   ▼           │          │    │         ▼                │   │            │
│  │  executeWf→   │          │    │  write_segment (per)     │   │            │
│  │  Node-Scrape  │          │    │         │                │   │            │
│  │  -Url V2      │          │    │         ▼                │   │            │
│  │  (Firecrawl)  │          │    │  STORIES APPROVAL        │───┤            │
│  │   │           │          │    │  via Gmail + Workbench   │   │            │
│  │   ▼           ▼          │    │         │                │   │            │
│  │  evaluate_content        │    │         ▼                │   │            │
│  │  (Claude — relevant?)    │    │  write_subject_line      │   │            │
│  │         │                │    │         │                │   │            │
│  │         ▼                │    │         ▼                │   │            │
│  │  POST /api/ingestion/    │◄───┤  SUBJECT APPROVAL        │───┤            │
│  │       upload             │    │  via Gmail + Workbench   │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  Internal preview email  │   │            │
│  │                          │    │  (Gmail to reviewers)    │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  POST GoHighLevel API    │   │            │
│  │                          │    │  (create campaign →      │   │            │
│  │                          │    │   send to subscribers)   │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  Log send to Supabase    │   │            │
│  │                          │    │  (newsletter_sends_v2)   │   │            │
│  └──────────────────────────┘    └──────────────────────────┘   │            │
│                                                                 │            │
└─────────────────────────────────────────────────────────────────┼────────────┘
                                                                  │
  WRITER'S WORKBENCH (Railway) ───────────────────────────────────┼────────────
                                                                  │
  ┌───────────────────────────────────────────────────────────────▼──────────┐
  │                Service: writers-workbench (Express + React)              │
  │                                                                          │
  │  Existing routes (unchanged):                                            │
  │    /api/health, /api/chat, /api/export, /api/admin, /api/brainstorm,     │
  │    /api/account, /api/session, /api/images, /api/callback, /api/docs     │
  │                                                                          │
  │  NEW routes (this sprint):                                               │
  │    /api/ingestion/upload       → upload blob to Supabase Storage +       │
  │                                   upsert row in content_ingestion_v2     │
  │    /api/ingestion/search       → SELECT by key prefix + type filter      │
  │    /api/ingestion/get/:key     → return {markdown, html, ...metadata}    │
  │    /api/approvals/create       → mint token, write newsletter_approvals  │
  │    /approvals/:token           → SSR HTML approval form                  │
  │    /api/approvals/:token/resolve → POST resume_url on n8n Wait webhook   │
  │    /api/newsletter-sends/log   → n8n logs completed send                 │
  │                                                                          │
  │  Env vars (Railway):                                                     │
  │    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already present)            │
  │    INGESTION_SECRET            (new — shared with n8n)                   │
  │    APPROVAL_SECRET             (new — shared with n8n)                   │
  │    APPROVAL_BASE_URL           (new — Workbench public domain)           │
  │    FIRECRAWL_API_KEY           (new — stored in n8n credential, repeat   │
  │                                  here only if server-side scraping needs)│
  └───────────────────────────────────┬──────────────────────────────────────┘
                                      │ Supabase JS admin client
                                      │ (same instance as other V2 workflows)
                                      ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  Supabase (V2): faklxfakgzkpkbxfihzh.supabase.co                          │
  │                                                                           │
  │  Existing tables (UNCHANGED): users_v2, writing_projects_v2,              │
  │    published_content_v2, genre_config_v2, story_arcs_v2,                  │
  │    app_config_v2, token_usage_v2, generated_images_v2, etc.               │
  │                                                                           │
  │  NEW tables (this sprint):                                                │
  │    content_ingestion_v2       — feed ingestion metadata                   │
  │    newsletter_approvals_v2    — time-limited Gmail-gated approval tokens  │
  │    newsletter_sends_v2        — every GHL send with campaign ID + status  │
  │                                                                           │
  │  Existing storage (UNCHANGED): author-content, cover-images,              │
  │    social-images, writing-samples                                         │
  │                                                                           │
  │  NEW storage bucket (this sprint):                                        │
  │    newsletter-ingestion       — private, service-role write,              │
  │                                  authenticated read                       │
  │      2026-04-19/                                                          │
  │        openai-kevin-weil.wired.md                                         │
  │        openai-kevin-weil.wired.html                                       │
  │        redditopenai-1sobz3s.md                                            │
  │        redditopenai-1sobz3s.html                                          │
  └───────────────────────────────────────────────────────────────────────────┘
```

---

## Three Architectural Decisions

### 1. Storage = Supabase Storage + Supabase Postgres

**Why not Railway Volume + Railway Postgres (original plan)?** The Writer's Workbench data layer is already Supabase. Adding a second database would fragment the data model, duplicate auth/RLS, and complicate Phase 2 (web UI). By putting newsletter tables and blobs into the same Supabase project, a web UI can query everything through the existing RLS-protected Supabase JS client. No dual-DB glue code, no cross-DB joins, no separate migration systems.

**Why not EC2 proxy + S3 bucket (today)?** External infra outside the Railway+Supabase stack. Requires maintaining api.aitools.inc, managing AWS credentials, paying S3 costs and EC2 time. Nothing about this pipeline justifies the separation.

### 2. Key scheme preserved: `{YYYY-MM-DD}/{slug}.{sourceName}.{md|html}`

The Newsletter Agent's existing date-prefix search logic works unchanged. It just calls `GET /api/ingestion/search?prefix=2026-04-19/` instead of hitting S3 directly. This keeps the diff to the Newsletter Agent workflow minimal — only the HTTP node URLs change.

### 3. Approvals = n8n Wait node + Workbench-rendered form

The Wait node's resume URL is captured when the approval token is created and lives only in `newsletter_approvals_v2`. The Gmail email links to `{APPROVAL_BASE_URL}/approvals/:token`, not to the resume URL directly — the n8n host URL never leaves the server. Revise-loop feedback flows back to n8n via the server's authenticated resume POST. This is the same pattern as other V2 approval flows.

---

## Workflows in this sprint

All three must activate together. Do **not** modify the `Orig` baselines per project rule — clone to V2.

| ID | New name | Action |
|---|---|---|
| `53SlwZMS21gpvz3H` | `AI News Data Ingestion V2` (clone) | New V2 workflow; rewire S3 → Workbench API; add Reddit self-post branch |
| `4DQ7DmA9pFtXzsKX` | `Content - Newsletter Agent V2` (clone) | New V2 workflow; rewire S3 → Workbench API; Slack → Gmail; sendAndWait → approval service; final send → GHL |
| `bXBsnU4d6OseXWho` | `Node - Scrape Url V2` (clone) | New V2 workflow; verify Firecrawl credential; activate. The ingestion V2 workflow's executeWorkflow references this one, not the broken `qVEM2rCD1jlJPeRs` |
| `glJfsY6KaO0aoX0A` | (Legacy Node - Scrape Url duplicate) | Mark `[OLD]` or delete — was the prior attempt that left a stale duplicate in the workflow list |

---

## Stories (11 stories, 36 points)

### S1 — Scrape URL wire-up (1 pt) | P0

Activate the working Firecrawl scraper and point the ingestion workflow at it.

**Developer Tasks:**
- [ ] Clone `Node - Scrape Url` (`bXBsnU4d6OseXWho`) to `Node - Scrape Url V2`. Capture new workflow ID for S4 wiring.
- [ ] In the clone, verify the existing Firecrawl credential (httpHeaderAuth: `Authorization: Bearer fc-...`); if missing, create it from the same API key stored in n8n credential vault.
- [ ] Test the V2 scrape workflow in isolation (single URL input → Firecrawl call → markdown + rawHtml output).
- [ ] Activate `Node - Scrape Url V2`.
- [ ] Mark `glJfsY6KaO0aoX0A` as `[OLD]` (rename) or delete to prevent future confusion.
- [ ] Note the V2 workflow ID — S4 rewires `scrape_url`'s executeWorkflow to point here (not to the broken `qVEM2rCD1jlJPeRs`).

**QA Tasks — Unit Tests:** n/a (n8n workflow — validated through system test)

**QA Tasks — System Tests:**
- [ ] Test: Execute `Node - Scrape Url V2` standalone with a known-good URL (e.g., a Wired article). Output must include non-empty `data.json.content` (markdown) and `data.rawHtml`.
- [ ] Test: Execute with a scrape that will fail (404 URL). Must return an error payload, not crash upstream.
- [ ] Test: Verify `glJfsY6KaO0aoX0A` no longer appears as an active workflow.

**QA Tasks — E2E Tests:** (Covered by S4 system test — ingestion workflow calls this successfully.)

**Definition of Done:**
- [ ] V2 workflow activated; Firecrawl credential verified
- [ ] Duplicate `glJfsY6KaO0aoX0A` renamed or deleted
- [ ] Workflow ID captured in sprint notes for S4

**Depends on:** nothing.

---

### S2 — Supabase schema + storage bucket provisioning (3 pts) | P0

Create the data layer on the existing Writer's Workbench Supabase.

**Developer Tasks:**
- [ ] Create migration `writers-workbench/migrations/009_newsletter_ingestion.sql`:
  ```sql
  CREATE TABLE content_ingestion_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT,
    authors TEXT,
    source_name TEXT NOT NULL,
    source_url TEXT,
    external_source_urls JSONB DEFAULT '[]'::jsonb,
    image_urls JSONB DEFAULT '[]'::jsonb,
    reddit_metadata JSONB,
    published_timestamp TIMESTAMPTZ,
    feed_url TEXT,
    storage_path_md TEXT NOT NULL,
    storage_path_html TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );
  CREATE INDEX idx_content_ingestion_v2_key_prefix ON content_ingestion_v2 (key text_pattern_ops)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_content_ingestion_v2_user_id ON content_ingestion_v2 (user_id)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_content_ingestion_v2_created_at ON content_ingestion_v2 (created_at DESC)
    WHERE deleted_at IS NULL;

  CREATE TABLE newsletter_approvals_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL,
    resume_url TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('stories', 'subject_line')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours',
    decision TEXT,
    feedback TEXT
  );
  CREATE INDEX idx_newsletter_approvals_v2_token ON newsletter_approvals_v2 (token);
  CREATE INDEX idx_newsletter_approvals_v2_user_id ON newsletter_approvals_v2 (user_id);

  CREATE TABLE newsletter_sends_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    send_date DATE NOT NULL,
    subject TEXT NOT NULL,
    preheader TEXT,
    html_body TEXT NOT NULL,
    markdown_body TEXT,
    ghl_campaign_id TEXT,
    ghl_audience_id TEXT,
    ghl_location_id TEXT,
    recipient_count INTEGER,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
    sent_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX idx_newsletter_sends_v2_user_date ON newsletter_sends_v2 (user_id, send_date DESC);

  -- RLS policies (match other V2 tables — service role bypasses; authenticated reads own rows)
  ALTER TABLE content_ingestion_v2 ENABLE ROW LEVEL SECURITY;
  ALTER TABLE newsletter_approvals_v2 ENABLE ROW LEVEL SECURITY;
  ALTER TABLE newsletter_sends_v2 ENABLE ROW LEVEL SECURITY;
  -- (policies listed in full in the migration file — own-row SELECT/INSERT/UPDATE using get_current_user_id())
  ```
- [ ] Add Supabase Storage bucket `newsletter-ingestion` via Supabase dashboard or migration:
  ```sql
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('newsletter-ingestion', 'newsletter-ingestion', false, 10485760,
            ARRAY['text/markdown', 'text/html', 'text/plain']);
  -- RLS policies on storage.objects: service role writes; authenticated reads own user_id folder
  ```
- [ ] Apply the migration to V2 Supabase (SQL Editor or `supabase db push`).
- [ ] Update `writers-workbench/.env.example` with `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL`, `FIRECRAWL_API_KEY`, `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_AUDIENCE_TAG`. (Only `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL` used in this story — the rest for S3, S10.)
- [ ] TypeScript types: add `ContentIngestion`, `NewsletterApproval`, `NewsletterSend` to `client/src/types/database.ts` (for future Phase 2 UI).

**QA Tasks — Unit Tests:**
- [ ] Type definitions compile (`npx tsc -p client/tsconfig.json --noEmit`)

**QA Tasks — System Tests:**
- [ ] All three tables present in V2 Supabase: `SELECT to_regclass('public.content_ingestion_v2'), to_regclass('public.newsletter_approvals_v2'), to_regclass('public.newsletter_sends_v2');` — all non-null
- [ ] Bucket `newsletter-ingestion` exists in Supabase Storage; upload a test file via service role key succeeds; anonymous access denied
- [ ] RLS policies active: a direct `SELECT * FROM content_ingestion_v2` with anon key returns empty (no rows leak); with service role returns data
- [ ] Foreign key to users_v2 enforced: insert with an unknown user_id fails with FK violation
- [ ] `updated_at` auto-update trigger works (if included — otherwise update via app layer)

**Definition of Done:**
- [ ] Migration file committed to `writers-workbench/migrations/`
- [ ] All tables + bucket created on V2 Supabase
- [ ] RLS policies active and verified
- [ ] `.env.example` updated
- [ ] TypeScript types added

**Depends on:** nothing (parallelizable with S1).

---

### S3 — Supabase-backed ingestion endpoints (5 pts) | P0

Express routes on the Workbench server that n8n calls instead of S3 + `api.aitools.inc`.

**Developer Tasks:**
- [ ] Create `writers-workbench/server/src/routes/ingestion.ts`:
  - `POST /api/ingestion/upload` — body `{ key, markdown, html, type, title, authors, source_name, source_url, external_source_urls, image_urls, reddit_metadata?, published_timestamp, feed_url, user_id }`. Protected by `X-Ingestion-Secret` header.
    - Validate `key` (no `..`, no absolute paths, no null bytes, no leading `/`)
    - Upload `{key}.md` and `{key}.html` to bucket `newsletter-ingestion` via Supabase service role client (`supabase.storage.from('newsletter-ingestion').upload(...)` with `upsert: true`)
    - Upsert row in `content_ingestion_v2` with `storage_path_md = ${key}.md`, `storage_path_html = ${key}.html`
    - On partial failure (e.g., DB insert fails after storage upload), attempt cleanup via `storage.remove([...])` — best-effort
    - Return `{ success: true, key }` on success
  - `GET /api/ingestion/search?prefix={date}/&type_not={type}&user_id={userId}` — service-role SELECT with `key LIKE prefix || '%'` and optional `type != type_not`, filtered by `user_id`, `deleted_at IS NULL`. Protected by `X-Ingestion-Secret`. Return array of metadata rows (no markdown/HTML bodies).
  - `GET /api/ingestion/get/:key` — URL-decode `key`, SELECT row from `content_ingestion_v2`, download both blobs from Supabase Storage (`storage.from('newsletter-ingestion').download(storage_path_md)`), return `{ ...metadata, markdown, html }`. 404 if row missing. Protected by `X-Ingestion-Secret`.
- [ ] Zod schemas in `writers-workbench/server/src/schemas.ts`:
  - `IngestionUploadSchema` — validates body including `key` format regex
  - `IngestionSearchQuerySchema`
- [ ] Register router in `server/src/index.ts` behind the existing `generalLimiter`.
- [ ] OpenAPI `@openapi` annotations.
- [ ] Path traversal guard: reject any `key` matching `/(\.\.|^\/|\0)/`.

**QA Tasks — Unit Tests** (`server/src/test/ingestion.test.ts`):
- [ ] Upload → search (prefix match) → get round trip returns all metadata + blob content
- [ ] Prefix filter returns only matching rows
- [ ] `type_not` filter excludes correctly
- [ ] Missing `X-Ingestion-Secret` → 401
- [ ] Wrong `X-Ingestion-Secret` → 401
- [ ] Path traversal attempt (`key: "../../etc/passwd"`) → 400
- [ ] Null byte injection (`key: "foo\0bar"`) → 400
- [ ] Re-upload with same key → upsert (no duplicate row, files replaced)
- [ ] Get missing key → 404
- [ ] Get key where DB row exists but blob missing from storage → 500 with clear error message (not silent)
- [ ] Zod validation: missing required field → 400 with field name in error
- [ ] `user_id` not in users_v2 → FK violation surfaces as 400 (not 500)

**QA Tasks — System Tests:**
- [ ] Upload 20 items rapidly (simulate feed ingestion burst) → all land without race conditions
- [ ] Search with 500 matching rows → LIMIT applied, response < 200KB
- [ ] Large markdown upload (1MB body) succeeds and round-trips byte-identical

**QA Tasks — E2E Tests:** (Covered by S4 and S6 system tests.)

**Definition of Done:**
- [ ] All unit tests passing
- [ ] TypeScript clean
- [ ] Route registered
- [ ] OpenAPI spec includes the three new endpoints
- [ ] Committed to `develop` on a feature branch

**Depends on:** S2.

---

### S4 — Ingestion workflow: S3 → Workbench API (3 pts) | P0

Rewire the ingestion workflow's storage nodes.

**Developer Tasks:**
- [ ] Clone `AI News Data Ingestion Orig` to `AI News Data Ingestion V2`.
- [ ] In `AI News Data Ingestion V2`:
  - [ ] Change the `scrape_url` executeWorkflow node's `workflowId` from `qVEM2rCD1jlJPeRs` (404) to the `Node - Scrape Url V2` ID from S1.
  - [ ] Delete the six S3/proxy nodes: `upload_temp_markdown`, `copy_markdown`, `delete_temp_markdown`, `upload_temp_html`, `copy_html`, `delete_temp_html`, `search_existing_resource`.
  - [ ] Insert `search_existing` (HTTP Request GET `{{$env.WORKBENCH_URL}}/api/ingestion/search?prefix={{$json.uploadFileName}}&user_id={{$json.userId}}`, `X-Ingestion-Secret` header). Downstream `skip_existing_resources` filter keeps its existing logic (empty array = new).
  - [ ] Insert `upload_content` (HTTP Request POST `{{$env.WORKBENCH_URL}}/api/ingestion/upload`, `X-Ingestion-Secret` header, body containing key, markdown, html, type, title, authors, source_name, source_url, external_source_urls, image_urls, published_timestamp, feed_url, user_id).
- [ ] Add n8n env vars: `WORKBENCH_URL`, `INGESTION_SECRET`.
- [ ] For first-pass testing, limit active feeds to one RSS + one Reddit to avoid burst traffic.

**QA Tasks — Unit Tests:** n/a

**QA Tasks — System Tests:**
- [ ] Dry-run with one blog feed (e.g., Wired): after execution, verify one `.md` + one `.html` file in bucket `newsletter-ingestion/{date}/` and one row in `content_ingestion_v2` with `type='article'`, populated `external_source_urls` + `image_urls`
- [ ] Second run of same item is deduped (search returns existing row → workflow skips)
- [ ] Scrape failure path: point one feed at an invalid URL; verify no orphan row in Supabase and no orphan blob in storage

**QA Tasks — E2E Tests:**
- [ ] Enable all 17 feeds for a 4-hour window; verify:
  - `SELECT count(*) FROM content_ingestion_v2 WHERE created_at > now() - interval '4 hours';` shows sustained ingestion (expect 20-80 rows depending on feed activity)
  - No failed executions in n8n execution log
  - No storage upload errors in Workbench server logs
  - All blobs have non-zero size

**Definition of Done:**
- [ ] Orig workflow unchanged
- [ ] V2 workflow active and processing a test feed
- [ ] System tests pass

**Depends on:** S1, S3.

---

### S5 — Reddit self-post ingestion branch (5 pts) | P0

Capture the richest Reddit content currently being dropped.

**Developer Tasks:**
- [ ] For each of the 3 Reddit pipelines in `AI News Data Ingestion V2` (r/OpenAI, r/artificial, r/ArtificialInteligence), add a parallel branch after `get_reddit_*_items`:
  - `filter_reddit_*_self_posts` (Filter node): keep if `is_self === true && selftext != null && selftext !== '' && selftext !== '[removed]' && selftext !== '[deleted]' && !crosspost_parent`.
  - `normalize_reddit_*_self_posts` (Code node): emit normalized shape:
    ```js
    {
      sourceName: 'reddit-{sub}',
      feedType: 'reddit_post',
      title,
      link: `https://reddit.com${permalink}`,
      body_markdown: selftext,
      body_html: decodeHtmlEntities(selftext_html),
      isoDate: new Date(created_utc * 1000).toISOString(),
      pubDate,
      feedUrl,
      reddit_metadata: { score, num_comments, author, subreddit, reddit_id: id, flair: link_flair_text }
    }
    ```
  - Skip the Firecrawl scrape (body is already in hand); route directly to `get_identity` → `upload_content` with `reddit_metadata` included.
  - Small HTML-entity decode Code node (Reddit's `selftext_html` returns `&lt;` etc.) — 10-line regex replace.

**QA Tasks — Unit Tests:**
- [ ] Decode utility: `decodeHtmlEntities('&lt;p&gt;hi&lt;/p&gt;')` → `'<p>hi</p>'`
- [ ] Normalizer function with a fixture Reddit post → produces correct shape

**QA Tasks — System Tests:**
- [ ] Live run against r/ArtificialInteligence: verify ≥1 row with `type='reddit_post'`, populated `reddit_metadata`, and `.md` blob in storage containing the `selftext`
- [ ] Edge case — test with a deleted post (`selftext='[deleted]'`) → filter rejects, no row created
- [ ] Edge case — test with a crosspost → filter rejects (we already have the original via scraping)
- [ ] Regression: link-post branch still produces `type='article'` rows, no duplication between branches

**QA Tasks — E2E Tests:**
- [ ] 24-hour run: verify `SELECT count(*) FROM content_ingestion_v2 WHERE type='reddit_post'` ≥ 3 (based on live sample, r/ArtificialInteligence alone produced 5/5 self-posts in a 15-post sample)

**Definition of Done:**
- [ ] Three parallel self-post branches added
- [ ] Live run produces `reddit_post` rows
- [ ] Link-post branch unaffected

**Depends on:** S1, S4.

---

### S6 — Newsletter Agent: S3 reads → Workbench reads (3 pts) | P0

Replace the newsletter agent's storage access with the new endpoints.

**Developer Tasks:**
- [ ] Clone `Content - Newsletter Agent` to `Content - Newsletter Agent V2`.
- [ ] Replace `search_markdown_objects` (S3 search) with HTTP GET `{{$env.WORKBENCH_URL}}/api/ingestion/search?prefix={{$json.Date}}/&type_not=newsletter&user_id={{$env.NEWSLETTER_USER_ID}}` with `X-Ingestion-Secret` header.
- [ ] Remove nodes now redundant (server filters replaces them):
  - `filter_only_markdown` (server returns only rows with both blobs)
  - `get_markdown_object_info` (metadata is in the search response)
  - `exclude_newsletters` (handled by `type_not` query param)
- [ ] Replace `download_markdown_object` with HTTP GET `{{$env.WORKBENCH_URL}}/api/ingestion/get/{{encodeURIComponent($json.key)}}`.
- [ ] Update downstream field paths — use `$json.markdown` instead of the old binary extraction pattern.
- [ ] Same swap for the tweet search path (`{Date}/tweet.*`) — GET `/api/ingestion/search?prefix={{$json.Date}}/tweet`.

**QA Tasks — Unit Tests:** n/a

**QA Tasks — System Tests:**
- [ ] Seed Supabase: upload 8-10 ingestion rows for date 2026-04-19 (mix: 5 articles, 2 newsletters, 1 reddit_post, 2 tweets) via a test script
- [ ] Run newsletter workflow up through `pick_top_stories`; verify the LLM sees only non-newsletter items (5 articles + 1 reddit_post + 2 tweets = 8 items), newsletter-type items filtered server-side
- [ ] Reddit post content reaches the LLM (previously impossible due to url_overridden_by_dest filter)

**QA Tasks — E2E Tests:** (Covered by S9 full-run test.)

**Definition of Done:**
- [ ] Agent V2 reads from Supabase
- [ ] Redundant filter nodes removed
- [ ] System tests pass

**Depends on:** S3, S5 (S5 adds the new type that this sprint now surfaces to the agent).

---

### S7 — Non-approval Slack → Gmail (3 pts) | P0

Swap the 7 informational Slack messages for Gmail emails.

**Developer Tasks:**
- [ ] In `Content - Newsletter Agent V2`, replace each of these 7 Slack nodes with a Gmail node (credential `CPCSZOInV8Zj1PI1`):
  - `share_selected_stories` → email "Newsletter {{Date}} — Selected Stories"
  - `share_stories_reasoning` → threaded reply email (subject `Re:` prefix)
  - `share_segment_msg` → email per story segment
  - `share_subject_line` → email
  - `share_subject_line_reasoning` → threaded reply email
  - `share_newsletter_msg` → internal preview notification email (pre-GHL send)
  - `upload_newsletter_file` (Slack file upload) → Gmail node with attachment (convert `create_newsletter_file`'s binary output to Gmail's `attachmentsBinary`)
- [ ] Pattern: read `recipient_email` + `bcc_email` from Supabase `app_config_v2` — matches the other 15 V2 workflows. Convert markdown to HTML via n8n Markdown node. Set `options.appendAttribution: false`.
- [ ] Delete all Slack channel references (`C08PGU0CLKS`) throughout.
- [ ] Remove the Slack credential from the V2 workflow entirely (verify no Slack nodes remain).

**QA Tasks — Unit Tests:** n/a (workflow config)

**QA Tasks — System Tests:**
- [ ] Dry-run the agent up through `share_newsletter_msg`; verify all 7 emails arrive at the test `recipient_email`
- [ ] Emails render correctly: HTML tables bold/links rendered, `.md` attachment is a valid file
- [ ] BCC recipient receives copies
- [ ] Thread replies group together in Gmail (subject `Re:` match)

**QA Tasks — E2E Tests:** (Covered by S9 full-run test.)

**Definition of Done:**
- [ ] Zero Slack nodes in `Content - Newsletter Agent V2`
- [ ] All 7 emails arrive and render correctly
- [ ] Attachment downloads as valid markdown

**Depends on:** S6.

---

### S8 — Gmail approval backend (3 pts) | P0

Workbench-hosted approval service — tokens in Supabase, SSR form on Express.

**Developer Tasks:**
- [ ] (Tables created in S2: `newsletter_approvals_v2`.)
- [ ] Create `writers-workbench/server/src/routes/approvals.ts`:
  - `POST /api/approvals/create` (requires `X-Approval-Secret`): body `{ user_id, stage, payload, resume_url, execution_id }`. Generate `token = crypto.randomBytes(24).toString('base64url')`. Insert into `newsletter_approvals_v2`. Return `{ token, approval_url: '${APPROVAL_BASE_URL}/approvals/${token}' }`.
  - `GET /approvals/:token` (no auth — public URL, token is the credential): SELECT row, check `resolved_at IS NULL AND expires_at > now()`. Render self-contained HTML form (template literal, same lightweight style as `routes/images.ts` — no React) showing the stage's payload (stories list or subject line) + radio Approve/Revise + textarea feedback + submit button. If resolved or expired, render "already resolved" or "expired" page respectively.
  - `POST /approvals/:token/resolve` (no auth, form POST): body `{ decision, feedback }`. In a transaction:
    - Verify row still open (`resolved_at IS NULL AND expires_at > now()`) — else 409
    - UPDATE `SET resolved_at = now(), decision = $1, feedback = $2`
    - `fetch(resume_url, { method: 'POST', body: JSON.stringify({ decision, feedback }) })` to kick the n8n Wait node
    - Render thank-you HTML
- [ ] Register router in `server/src/index.ts`.
- [ ] Add env vars to `.env.example`: `APPROVAL_SECRET`, `APPROVAL_BASE_URL`.
- [ ] Zod schemas for `create` body and `resolve` body.
- [ ] OpenAPI annotations.

**QA Tasks — Unit Tests** (`server/src/test/approvals.test.ts`):
- [ ] Token creation with valid payload returns `token` + `approval_url`
- [ ] Token creation with missing `X-Approval-Secret` → 401
- [ ] Token creation with invalid `stage` → 400 (Zod)
- [ ] GET `/approvals/:token` renders HTML containing the payload
- [ ] GET `/approvals/:token` on expired row renders expired page
- [ ] GET `/approvals/:token` on resolved row renders already-resolved page
- [ ] POST resolve: valid decision → UPDATE succeeds, resume POST fires (mock fetch called with correct body)
- [ ] POST resolve: double-resolve → 409
- [ ] POST resolve: expired token → 410 (gone)
- [ ] POST resolve: missing token → 404
- [ ] Path traversal in token param → sanitized or 404

**QA Tasks — System Tests:**
- [ ] End-to-end: curl create → open form URL in browser → submit Approve → verify resume endpoint (a test server) receives correct POST body
- [ ] End-to-end: same with Revise + feedback string containing special chars (quotes, newlines, emoji)

**QA Tasks — E2E Tests:** (Covered by S9.)

**Definition of Done:**
- [ ] All unit tests passing
- [ ] TypeScript clean
- [ ] Route registered
- [ ] `.env.example` updated
- [ ] Integration test with mock n8n resume endpoint passes

**Depends on:** S2.

---

### S9 — Newsletter Agent: Slack sendAndWait → Gmail approval (5 pts) | P0

Swap the two approval gates to use the new backend.

**Developer Tasks:**
- [ ] In `Content - Newsletter Agent V2`, for both `share_stories_approval_feedback` and `share_subject_line_approval_feedback`, replace with a 3-node group:
  - `create_approval_stories` (HTTP Request POST): `{{$env.WORKBENCH_URL}}/api/approvals/create` with `X-Approval-Secret` header, body `{ user_id, stage: 'stories', payload: <current stories>, resume_url: $execution.resumeUrl, execution_id: $execution.id }`. Returns `{ token, approval_url }`.
  - `send_approval_email_stories` (Gmail): subject `"Newsletter {{Date}} — approve stories"`, HTML body with rendered story list (use Markdown node to convert the LLM's markdown story list to HTML) + a prominent button linking to `{{$json.approval_url}}`.
  - `wait_for_stories_approval` (Wait node, mode "On Webhook Call", timeout 48h): resumes when the approval resolve endpoint POSTs `{ decision, feedback }` to its resume URL.
- [ ] Downstream: `extract_stories_approval_feedback` (LLM) and `check_stories_feedback` (IF) keep their existing logic — input shape `{ decision, feedback }` is preserved. Same for subject line.
- [ ] The `edit_top_stories` / `edit_subject_line` revise-loop path re-enters `create_approval_*` for the second round — identical pattern, new nodes only at the gate.
- [ ] Same 3-node pattern for the subject line gate.
- [ ] Add `NEWSLETTER_USER_ID` n8n env var (identifies which Workbench user owns these ingestions/approvals/sends — initially the superuser `+14105914612`).

**QA Tasks — Unit Tests:** n/a (workflow config)

**QA Tasks — System Tests:**
- [ ] Happy path (approve both rounds):
  - Submit form with a date that has ingested content
  - Stories email arrives < 30s
  - Click link → Workbench renders approval page with story list
  - Submit Approve → workflow advances
  - Subject-line email arrives
  - Click link → approve → workflow advances to final step
- [ ] Revise path:
  - Stories email arrives
  - Submit Revise with feedback text
  - Workflow loops; updated stories email arrives < 90s
  - Approve on round 2 → advances
- [ ] Timeout:
  - Create an approval; manually `UPDATE newsletter_approvals_v2 SET expires_at = now() - interval '1 hour' WHERE token = $1`
  - n8n Wait times out; workflow errors cleanly (not silently stuck)
- [ ] Double-click: click approval link → approve → refresh page → submit again → "already resolved" response, no duplicate resume POST

**QA Tasks — E2E Tests:**
- [ ] Full newsletter run (pre-GHL): approve stories + subject → internal preview email arrives with attached `.md` in < 3 minutes total
- [ ] Revise-then-approve full run: total time < 6 minutes

**Definition of Done:**
- [ ] Both approval gates use Workbench + Gmail
- [ ] Zero Slack mentions remain in `Content - Newsletter Agent V2`
- [ ] Happy path + revise path + timeout path + double-click all exercised

**Depends on:** S6, S7, S8.

---

### S10 — GoHighLevel CRM distribution (5 pts) | P0

Replace the final distribution step with GoHighLevel API integration.

**Developer Tasks:**
- [ ] Obtain GoHighLevel credentials:
  - OAuth 2.0 app credentials (client ID + client secret) OR a private integration API key, whichever your GHL subscription supports
  - Capture `location_id` (the GHL sub-account for this newsletter)
  - Create target audience: a smart list / tag / segment that represents "Daily AI Newsletter Subscribers"
  - Capture the audience ID or tag name
- [ ] Add env vars: `GHL_API_KEY` (or `GHL_CLIENT_ID` + `GHL_CLIENT_SECRET` for OAuth), `GHL_LOCATION_ID`, `GHL_AUDIENCE_TAG`, `GHL_API_BASE_URL` (default `https://services.leadconnectorhq.com`).
- [ ] Create n8n credential: HTTP Header Auth with `Authorization: Bearer {GHL_API_KEY}` and `Version: 2021-07-28` header (or the current GHL API version header).
- [ ] In `Content - Newsletter Agent V2`, after the subject-line approval branch completes and the internal preview email goes out, insert a **GHL distribution group** (replaces what was previously just a `send_newsletter_to_distribution_list` Gmail node):
  - [ ] `build_ghl_payload` (Code node) — construct the GHL email campaign body:
    - `subject`: approved subject line
    - `preheader`: approved pre-header
    - `htmlBody`: newsletter HTML (from the Markdown node conversion)
    - `from`: configured sender on GHL
    - `audience` or `tag`: the subscriber segment
    - Include a "view in browser" link — for now, a placeholder link to `{APPROVAL_BASE_URL}/newsletter-archive/:send_id` which will 404 until Phase 2 adds the archive page. (Tracked in follow-up issue.)
  - [ ] `create_ghl_campaign` (HTTP Request POST) — to the GHL email campaign creation endpoint (exact path depends on GHL API version; the developer task includes confirming the endpoint against current GHL docs and the subscription plan — typically `POST /emails/schedule` or `POST /campaigns/{id}/send` or `POST /conversations/messages` depending on the path chosen).
  - [ ] `log_ghl_send_pending` (HTTP Request POST) — to Workbench `/api/newsletter-sends/log` with `status: 'sending'`, subject, html_body, ghl_campaign_id (from response), ghl_audience_id, ghl_location_id, send_date, user_id.
  - [ ] `send_ghl_campaign` (HTTP Request POST) — trigger the send if GHL's model requires a separate schedule-then-send step (some API versions do).
  - [ ] `log_ghl_send_complete` (HTTP Request POST) — update the `newsletter_sends_v2` row with `status: 'sent'`, `sent_at: now()`, `recipient_count` (from GHL response if available).
  - [ ] Error branch: on GHL API failure, log `status: 'failed'` with error message; send a Gmail alert to the admin recipient.
- [ ] Add `POST /api/newsletter-sends/log` endpoint on Workbench server (mirrors ingestion pattern — protected by `X-Ingestion-Secret`, upserts to `newsletter_sends_v2`).
- [ ] Keep the internal preview email (S7 `share_newsletter_msg`) — it remains as a record-of-send / audit trail to the reviewer inbox, separate from GHL external send.
- [ ] Documentation in the sprint's runbook: how to rotate the GHL API key, how to change the target audience, how to check delivery status in GHL dashboard, what to do if a send is stuck in `status: 'sending'`.

**Rate limit & safety notes:**
- [ ] Start with GHL's lowest-tier send limit in env; the workflow should `sleep 5s` between `create_ghl_campaign` and `send_ghl_campaign` calls to allow GHL's internal queue to settle.
- [ ] First production runs should target a **test audience** (segment named e.g. `newsletter-test`) containing only the reviewer's own contact. Flip to production audience only after 3 successful test sends.

**QA Tasks — Unit Tests** (`server/src/test/newsletter-sends.test.ts`):
- [ ] `POST /api/newsletter-sends/log` with valid payload → inserts row, returns 200 + id
- [ ] Insert with duplicate `(user_id, send_date)` → upserts (updates existing row, no duplicate)
- [ ] Missing `X-Ingestion-Secret` → 401
- [ ] Invalid `status` value → 400 (CHECK constraint)

**QA Tasks — System Tests:**
- [ ] Send one test campaign through the full GHL flow to `newsletter-test` audience; verify:
  - Campaign appears in GHL dashboard with correct subject, preheader, HTML body
  - One email arrives at the reviewer's address as a GHL-delivered message (`from` matches configured GHL sender, not Gmail)
  - `newsletter_sends_v2` row created with `status='sent'`, correct `ghl_campaign_id`, `recipient_count`
  - GHL send analytics (opens, clicks) populate within 10 minutes (verify via GHL dashboard)
- [ ] Rate limit simulation: send 3 campaigns within 5 minutes; verify all three succeed or gracefully queue (no data loss)
- [ ] Failure simulation: temporarily rotate `GHL_API_KEY` to an invalid value; run campaign; verify:
  - GHL POST fails with 401
  - `newsletter_sends_v2.status = 'failed'`, `error` column populated
  - Admin alert email arrives
  - Workflow does not leave the row stuck in `status='sending'`

**QA Tasks — E2E Tests:**
- [ ] Full pipeline production run: ingestion → aggregation → approvals → internal Gmail preview → GHL send to test audience → logged success in `newsletter_sends_v2` — total elapsed time < 10 minutes
- [ ] Re-run for the same date: verify upsert behavior (one row per `(user_id, send_date)`)

**Definition of Done:**
- [ ] GHL credential active in n8n
- [ ] Test send arrives as a GHL-delivered email (not Gmail) at the reviewer
- [ ] `newsletter_sends_v2` row logged with `ghl_campaign_id` and `status='sent'`
- [ ] Failure path tested and graceful
- [ ] Runbook section added

**Depends on:** S6, S7, S9.

---

### S11 — Activation, documentation, cutover (3 pts) | P0

Flip the switch, document, and retire the Orig workflows.

**Developer Tasks:**
- [ ] Final sweep of `Content - Newsletter Agent V2`: `grep -i slack` returns nothing; `grep C08PGU0CLKS` returns nothing; no Slack credential attached.
- [ ] Final sweep of `AI News Data Ingestion V2`: no references to `api.aitools.inc`, no references to the S3 bucket `data-ingestion`, no references to `qVEM2rCD1jlJPeRs`.
- [ ] Create `writers-workbench/docs/newsletter-migration.md`:
  - Architecture diagram (copy from this sprint doc)
  - Workflow inventory: IDs of `AI News Data Ingestion V2`, `Content - Newsletter Agent V2`, `Node - Scrape Url V2`
  - Supabase tables: `content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2` — schema reference
  - Storage bucket: `newsletter-ingestion` — access pattern
  - Env var reference table (all secrets used)
  - Credential IDs: Gmail (`CPCSZOInV8Zj1PI1`), Firecrawl (n8n httpHeaderAuth), GoHighLevel (n8n credential ID TBD during S10)
  - Runbook:
    - Approval email not arriving → check `recipient_email` in `app_config_v2`, check Gmail OAuth token validity, check Workbench `/api/approvals/create` logs
    - Approval link shows 404 → check `APPROVAL_BASE_URL` env var on Railway, check row exists in `newsletter_approvals_v2`
    - Workflow timeout → check `expires_at`, check resume URL still valid (n8n execution ID not purged)
    - GHL send failed → check `newsletter_sends_v2.error`, check GHL API key validity, check GHL audience exists
    - Volume / bucket full → Supabase storage quota (N/A with current tier)
  - Ops:
    - How to query today's ingestion: `SELECT type, count(*) FROM content_ingestion_v2 WHERE created_at > now() - interval '24 hours' GROUP BY type;`
    - How to list approvals awaiting action: `SELECT * FROM newsletter_approvals_v2 WHERE resolved_at IS NULL AND expires_at > now();`
    - How to retry a failed GHL send: UPDATE status to `pending`, re-execute workflow from `send_ghl_campaign` node
- [ ] Activate `AI News Data Ingestion V2` and `Content - Newsletter Agent V2`.
- [ ] Deactivate the Orig versions (`53SlwZMS21gpvz3H`, `4DQ7DmA9pFtXzsKX`).
- [ ] Run one full end-to-end acceptance test on a real date.
- [ ] Update `CLAUDE.md` with newsletter-specific baseline rules (don't modify `AI News Data Ingestion V2`, `Content - Newsletter Agent V2`, `Node - Scrape Url V2` workflows without explicit user permission).
- [ ] Update `MEMORY.md` with newsletter system pointers.

**QA Tasks — E2E (acceptance):**
- [ ] All 17 feeds ingest without error over a 24-hour window
- [ ] Reddit self-posts captured (≥ 3 `type='reddit_post'` rows on a day with subreddit activity)
- [ ] Newsletter generation runs end-to-end:
  - Stories approval email < 30s after trigger
  - Revision loop works on demand
  - Subject-line approval email < 30s after story approval
  - Internal Gmail preview email arrives after final approval
  - GHL campaign created and sent to test audience
  - `newsletter_sends_v2` row logged with `status='sent'`
- [ ] **Zero Slack messages** sent anywhere in this flow (verify Slack channel `C08PGU0CLKS` has no new messages from the test period)
- [ ] **Zero** `api.aitools.inc` calls (verify n8n execution logs, Workbench server access logs)
- [ ] **Zero** references to old S3 bucket `data-ingestion` in the V2 workflows
- [ ] **Zero** references to `qVEM2rCD1jlJPeRs` in the V2 workflows
- [ ] Orig workflows inactive and have not executed since the cutover
- [ ] Writer's Workbench app itself (existing routes) unaffected: all 214 client unit tests, 124 server unit tests pass; existing E2E tests pass

**Definition of Done:**
- [ ] V2 workflows active, Orig workflows inactive
- [ ] Acceptance test passed
- [ ] Documentation committed
- [ ] `MEMORY.md` and `CLAUDE.md` updated
- [ ] Sprint retrospective notes captured

**Depends on:** all previous stories.

---

## Dependency Graph

```
S1 ──────────────┐
                 │
S2 ──┬── S3 ──┬──┼──> S4 ──> S5 ──┐
     │        │  │                 │
     │        │  └──────> S6 ──────┤
     │        │                    │
     │        └──> S8 ──> S9 ──────┤
     │                             │
     │              S7 ────────────┤
     │                             │
     │                             ▼
     └──────────────────────────> S10 ──> S11
```

**Recommended order (solo):** S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11

**Recommended order (two tracks):**
- Track A (n8n workflows): S1 → S4 → S5 → S7
- Track B (Workbench server + Supabase): S2 → S3 → S6 → S8 → S10
- Converge at S9, finish at S11

---

## Critical Files

### New

| File | Story |
|---|---|
| `writers-workbench/migrations/009_newsletter_ingestion.sql` | S2 |
| `writers-workbench/server/src/routes/ingestion.ts` | S3 |
| `writers-workbench/server/src/routes/approvals.ts` | S8 |
| `writers-workbench/server/src/routes/newsletter-sends.ts` | S10 |
| `writers-workbench/server/src/test/ingestion.test.ts` | S3 |
| `writers-workbench/server/src/test/approvals.test.ts` | S8 |
| `writers-workbench/server/src/test/newsletter-sends.test.ts` | S10 |
| `writers-workbench/docs/newsletter-migration.md` | S11 |

### Modified

| File | Change |
|---|---|
| `writers-workbench/server/src/index.ts` | Register 3 new routers: ingestion, approvals, newsletter-sends |
| `writers-workbench/server/src/schemas.ts` | Zod schemas for new endpoints |
| `writers-workbench/client/src/types/database.ts` | Add `ContentIngestion`, `NewsletterApproval`, `NewsletterSend` types (for Phase 2 UI) |
| `writers-workbench/.env.example` | `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL`, `FIRECRAWL_API_KEY`, `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_AUDIENCE_TAG`, `GHL_API_BASE_URL`, `NEWSLETTER_USER_ID` |
| `CLAUDE.md` | Add newsletter V2 workflows to baseline protection list |

### n8n workflows

| Workflow | Action |
|---|---|
| `AI News Data Ingestion Orig` (`53SlwZMS21gpvz3H`) | Clone to V2, deactivate Orig in S11 |
| `Content - Newsletter Agent` (`4DQ7DmA9pFtXzsKX`) | Clone to V2, deactivate Orig in S11 |
| `Node - Scrape Url` (`bXBsnU4d6OseXWho`) | Clone to V2, activate |
| `Node - Scrape Url` duplicate (`glJfsY6KaO0aoX0A`) | Mark `[OLD]` or delete in S1 |

### Patterns to reuse

- `writers-workbench/server/src/services/supabase-admin.ts` — lazy-init singleton pattern (existing)
- `writers-workbench/server/src/routes/images.ts` — route structure + binary handling for new ingestion routes
- `workflows/04_tool_email_research_report_v2.json` — Gmail node with HTML body (reference for S7)
- `workflows/08_tool_write_newsletter_v2.json` — markdown → HTML conversion (reference for S7)

---

## Sprint-Level Verification

**Pre-sprint checklist:**
- [ ] V2 Supabase accessible; service role key rotated and in Railway env
- [ ] GoHighLevel account accessible; API credentials generated; test audience created
- [ ] n8n credentials reviewed: Gmail OAuth valid, Firecrawl API key valid
- [ ] Railway Workbench service healthy (all existing routes responding)

**Sprint acceptance (executed in S11):**
1. **Clean state:** Apply migration; verify all 3 new tables + storage bucket exist; RLS active.
2. **Env configured:** All secrets present on both Railway and n8n; `app_config_v2.recipient_email` set to reviewer inbox.
3. **Workbench deploys:** `/api/ingestion/search?prefix=never-matches` returns `[]`; `/api/approvals/create` without secret returns 401; `/api/newsletter-sends/log` without secret returns 401.
4. **Ingestion active:** `AI News Data Ingestion V2` on for 4 hours; verify rows across types (`newsletter`, `article`, `reddit_post`, `tweet`).
5. **Blobs verified:** Download a random `.md` from `newsletter-ingestion` bucket → confirm non-empty + matches DB row's title.
6. **Approval flow:** Trigger `Content - Newsletter Agent V2` form; approval emails arrive; click link → form renders → submit Approve/Revise → workflow advances.
7. **Internal preview:** Gmail `.md` attachment arrives as internal record.
8. **GHL send:** Campaign created in GHL dashboard; test-audience email arrives GHL-branded; `newsletter_sends_v2.status='sent'`.
9. **Regression:** No Slack posts; no errors in Railway logs; no failed n8n executions; Writer's Workbench app unchanged (all existing tests still pass).
10. **Cutover:** Orig workflows deactivated.

---

## Out of scope (future sprints)

- **Phase 2 — Web UI integration.** Newsletter pages in the Writer's Workbench app: subscriber list viewer (pulled from GHL), send history (`newsletter_sends_v2`), manual trigger, archive of past newsletters, approval viewer as alternative to Gmail link.
- **Data migration from old S3 bucket.** Historical newsletters + ingestion data remain in the AWS S3 bucket `data-ingestion`; no migration in scope.
- **GHL subscriber sync.** Out of scope — assume subscribers are managed directly in GHL by the business team.
- **Analytics dashboard.** Open rates, click-through, unsubscribes from GHL — Phase 3.
- **Multiple newsletter lists / topics.** Currently one daily newsletter for one audience. Multi-list support is future scope.
- **Scheduled send times.** Currently on-demand via the form trigger. Cron-driven daily send is future scope — the existing Cron Scheduled Publisher workflow pattern can be adapted.
