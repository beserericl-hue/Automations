# Sprint: Newsletter Agent Migration → Writer's Workbench

**Version:** 1.1
**Date:** 2026-04-19
**Methodology:** Scrum — 2-week sprint, story points (Fibonacci), Definition of Done includes tests
**Total:** 11 stories, 39 points
**Goal:** Move the three-workflow newsletter sub-system off EC2/S3/Slack and into the Writer's Workbench Supabase data layer. Install **Postal** as Writer's Workbench's self-hosted email server on `courseworx.media` — used first by this sprint, and positioned as the shared email infrastructure for all future V2 workflows. Store the finished newsletter in Supabase with a `scheduled_send_at` field so the Writer's Workbench calendar (future sprint) can release it. Add the previously-dropped Reddit self-post ingestion branch. Fix the broken scrape executeWorkflow pointer.

**Not in this sprint (deferred):**
- Active delivery of newsletters to subscribers — this sprint stores the approved newsletter for later scheduled release
- CRM integration (GoHighLevel) — reconsidered for a future sprint after the product is established
- Migration of the other 15 V2 workflows from Gmail OAuth to Postal — Postal is installed here, but only newsletter-related flows migrate in this sprint to limit blast radius

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
2. **Slack dependency** — 9 Slack nodes across approval gates and notifications; replacing with Postal-delivered email on `@courseworx.media`.
3. **Broken scraper wiring** — `scrape_url` executeWorkflow points at a 404 workflow ID; the working Firecrawl replacement exists but isn't activated.
4. **Reddit self-post loss** — the Reddit filter drops all self-posts (`url_overridden_by_dest` absent), so the richest Reddit content (full user-written posts — a 15-post live sample totalled 18,125 body chars) never reaches the newsletter.
5. **No Writer's Workbench-owned email infrastructure** — all email currently flows through a single Gmail OAuth credential (`CPCSZOInV8Zj1PI1`), which is domain-unbranded and capped at ~2,000 sends/day. Writer's Workbench needs its own email server on its own domain (`courseworx.media`) before any outbound subscriber-scale work makes sense. This sprint stands up **Postal** as that server and migrates newsletter flows to it.

### Outcome

All three workflows run entirely against the **Writer's Workbench Supabase** data layer. Approvals and ops messages go through **Postal** (`@courseworx.media`) instead of Gmail OAuth. Ingestion captures full Reddit content including self-posts. The approved newsletter is **stored in Supabase with a `scheduled_send_at` field**, ready for the future Writer's Workbench calendar to trigger release. No EC2, no external S3, no Slack remain in this pipeline. A working Postal server stands ready for future workflows to migrate onto.

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
│  │  17 triggers              │    │  form_trigger(Date)      │                │
│  │         │                │    │         │                │                │
│  │         ▼                │    │         ▼                │                │
│  │  split + filter          │    │  GET /api/ingestion/     │───┐            │
│  │         │                │    │      search?prefix=Date  │   │            │
│  │   ┌─────┴─────┐          │    │         │                │   │            │
│  │   ▼           ▼          │    │         ▼                │   │            │
│  │  LINK       SELF-POST    │    │  GET /api/ingestion/     │◄──┤            │
│  │  POSTS      (NEW BRANCH) │    │      get/:key (per item) │   │            │
│  │   │           │          │    │         │                │   │            │
│  │   ▼           │          │    │         ▼                │   │            │
│  │  executeWf→   │          │    │  pick_top_stories (LLM)  │   │            │
│  │  Node-Scrape  │          │    │         │                │   │            │
│  │  -Url V2      │          │    │         ▼                │   │            │
│  │  (Firecrawl)  │          │    │  write_segment (per)     │   │            │
│  │   │           │          │    │         │                │   │            │
│  │   ▼           ▼          │    │         ▼                │   │            │
│  │  evaluate_content        │    │  STORIES APPROVAL        │───┤            │
│  │  (Claude — relevant?)    │    │  POST /api/approvals/    │   │            │
│  │         │                │    │       create → email     │   │            │
│  │         ▼                │    │  via Postal → Wait       │   │            │
│  │  POST /api/ingestion/    │◄───┤         │                │   │            │
│  │       upload             │    │         ▼                │   │            │
│  │                          │    │  write_subject_line      │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  SUBJECT APPROVAL        │───┤            │
│  │                          │    │  (same pattern)          │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  POST /api/email/send    │───┤            │
│  │                          │    │  internal preview (Postal│   │            │
│  │                          │    │  to reviewers with       │   │            │
│  │                          │    │  .md attachment)         │   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │         ▼                │   │            │
│  │                          │    │  POST /api/newsletter-   │   │            │
│  │                          │    │       sends/save         │───┤            │
│  │                          │    │   (status='scheduled',   │   │            │
│  │                          │    │    scheduled_send_at set)│   │            │
│  │                          │    │         │                │   │            │
│  │                          │    │  ╔══════▼════════╗      │   │            │
│  │                          │    │  ║ Future sprint:║      │   │            │
│  │                          │    │  ║ Workbench     ║      │   │            │
│  │                          │    │  ║ calendar cron ║      │   │            │
│  │                          │    │  ║ picks up row  ║      │   │            │
│  │                          │    │  ║ and releases  ║      │   │            │
│  │                          │    │  ╚═══════════════╝      │   │            │
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
  │    /api/email/send             → Postal relay (shared future use)        │
  │    /api/newsletter-sends/save  → save finished newsletter with           │
  │                                   status='scheduled' + scheduled_send_at │
  │                                                                          │
  │  Env vars (Railway, NEW in this sprint):                                 │
  │    INGESTION_SECRET, APPROVAL_SECRET, APPROVAL_BASE_URL,                 │
  │    FIRECRAWL_API_KEY, EMAIL_SECRET,                                      │
  │    POSTAL_API_URL, POSTAL_API_KEY,                                       │
  │    SENDER_EMAIL=eve@courseworx.media, SENDER_NAME, REPLY_TO_EMAIL        │
  └───────┬───────────────────────────────────┬──────────────────────────────┘
          │ Supabase JS admin client          │ HTTPS to Postal API
          │                                   │ (internal Railway network)
          ▼                                   ▼
  ┌──────────────────────────────┐    ┌────────────────────────────────────────┐
  │ Supabase (V2):                │    │  Postal (NEW — Railway-hosted)         │
  │ faklxfakgzkpkbxfihzh.         │    │  writer's workbench email server       │
  │ supabase.co                   │    │                                        │
  │                               │    │  3 Railway services:                   │
  │ Existing tables (UNCHANGED)   │    │   • postal  (web/API/workers)          │
  │ NEW tables (this sprint):     │    │   • mariadb (metadata)                 │
  │  content_ingestion_v2         │    │   • rabbitmq(internal queue)           │
  │  newsletter_approvals_v2      │    │                                        │
  │  newsletter_sends_v2          │    │  Sending domain: courseworx.media      │
  │                               │    │  DKIM, SPF, DMARC, return-path         │
  │ Existing storage (UNCHANGED)  │    │  records published in DNS              │
  │ NEW bucket:                   │    │                                        │
  │  newsletter-ingestion         │    │  Admin UI: postal-admin.courseworx     │
  │                               │    │                .media                  │
  │                               │    │                                        │
  │                               │    │  Initially used by newsletter flows    │
  │                               │    │  only. Other V2 workflows migrate      │
  │                               │    │  from Gmail OAuth in future sprints.   │
  └──────────────────────────────┘    └────────────────────────────────────────┘
```

---

## Four Architectural Decisions

### 1. Storage = Supabase Storage + Supabase Postgres

**Why not Railway Volume + Railway Postgres (original plan)?** The Writer's Workbench data layer is already Supabase. Adding a second database would fragment the data model, duplicate auth/RLS, and complicate Phase 2 (web UI). By putting newsletter tables and blobs into the same Supabase project, a web UI can query everything through the existing RLS-protected Supabase JS client. No dual-DB glue code, no cross-DB joins, no separate migration systems.

**Why not EC2 proxy + S3 bucket (today)?** External infra outside the Railway+Supabase stack. Requires maintaining api.aitools.inc, managing AWS credentials, paying S3 costs and EC2 time. Nothing about this pipeline justifies the separation.

### 2. Key scheme preserved: `{YYYY-MM-DD}/{slug}.{sourceName}.{md|html}`

The Newsletter Agent's existing date-prefix search logic works unchanged. It just calls `GET /api/ingestion/search?prefix=2026-04-19/` instead of hitting S3 directly. This keeps the diff to the Newsletter Agent workflow minimal — only the HTTP node URLs change.

### 3. Approvals = n8n Wait node + Workbench-rendered form

The Wait node's resume URL is captured when the approval token is created and lives only in `newsletter_approvals_v2`. The approval email links to `{APPROVAL_BASE_URL}/approvals/:token`, not to the resume URL directly — the n8n host URL never leaves the server. Revise-loop feedback flows back to n8n via the server's authenticated resume POST. This is the same pattern as other V2 approval flows.

### 4. Email = self-hosted Postal on Railway, Writer's Workbench-owned

**Why self-hosted (Postal) over SaaS (Resend/SendGrid)?** Postal becomes the **permanent email infrastructure** for Writer's Workbench — not just this sprint. As the product grows (multi-tenant, higher volume, more V2 workflows), a SaaS would cap or meter our sends and constrain deliverability choices. Owning the server means owning the IP reputation, the templates, the bounce/complaint pipeline, and the cost curve. Short-term deliverability risk on a cold Railway IP is accepted in exchange for long-term sovereignty.

**Why on the same Railway project as the Workbench?** Private networking: Express talks to Postal over Railway's internal DNS at near-zero latency. No public SMTP exposure required for app-to-Postal sending (public port 25 only needed if external senders ever relay through — not required by this sprint's flows).

**Why a single `/api/email/send` abstraction in Express?** Every n8n workflow that sends mail calls this endpoint with `{to, subject, html, attachments?, from?}`. The endpoint is the only thing that knows Postal — so when Postal is replaced, reconfigured, or sharded, nothing in n8n changes. This sprint migrates newsletter flows; future sprints migrate other V2 workflows onto the same endpoint.

**Sending domain:** `courseworx.media`. Reviewer from-address: `eve@courseworx.media`. Reply-to: `support@courseworx.media` (no MX yet; future sprint when replies matter).

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
    -- scheduling
    scheduled_send_at TIMESTAMPTZ,             -- set when newsletter is approved; future sprint's calendar cron picks it up
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')),
    sent_at TIMESTAMPTZ,
    -- delivery tracking (populated by future sprint that does actual sending)
    recipient_count INTEGER,
    delivery_provider TEXT,                    -- 'postal' initially, 'ghl' if CRM added later
    provider_message_id TEXT,                  -- Postal message ID, or future GHL campaign ID
    error TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX idx_newsletter_sends_v2_user_date ON newsletter_sends_v2 (user_id, send_date DESC);
  CREATE INDEX idx_newsletter_sends_v2_scheduled ON newsletter_sends_v2 (status, scheduled_send_at)
    WHERE status = 'scheduled';                -- fast lookup for the future calendar cron
  CREATE UNIQUE INDEX idx_newsletter_sends_v2_user_date_unique ON newsletter_sends_v2 (user_id, send_date)
    WHERE status != 'cancelled';               -- one active newsletter per user per date

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
- [ ] Update `writers-workbench/.env.example` with `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL`, `FIRECRAWL_API_KEY`, `EMAIL_SECRET`, `POSTAL_API_URL`, `POSTAL_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`, `REPLY_TO_EMAIL`, `NEWSLETTER_USER_ID`. (Only `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL` used in this story — the rest set up in S7–S10.)
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

### S7 — Install Postal + configure courseworx.media (5 pts) | P0

Stand up Writer's Workbench's permanent self-hosted email server on Railway. This is shared infrastructure — newsletter flows use it first; other V2 workflows migrate onto it in later sprints.

**Railway services to add (3 services + 2 volumes):**

| # | Service | Docker image | vCPU / RAM | Volume |
|---|---------|--------------|------------|--------|
| 1 | `postal-mariadb` | `mariadb:10.11` | 0.25 / 512 MB | 5 GB at `/var/lib/mysql` |
| 2 | `postal-rabbitmq` | `rabbitmq:3-management` | 0.25 / 256 MB | 1 GB at `/var/lib/rabbitmq` |
| 3 | `postal` | `ghcr.io/postalserver/postal:3` | 0.5 / 1 GB | — |

All three on the same Railway project as `writers-workbench`, communicating over the private network. Total ~$34/mo.

**Developer Tasks:**

**Part A — Railway infrastructure:**
- [ ] Deploy `postal-mariadb` (MariaDB 10.11 image). Set env: `MARIADB_ROOT_PASSWORD`, `MARIADB_DATABASE=postal`, `MARIADB_USER=postal`, `MARIADB_PASSWORD`. Mount 5 GB volume at `/var/lib/mysql`. Capture internal hostname.
- [ ] Deploy `postal-rabbitmq` (rabbitmq:3-management). Set env: `RABBITMQ_DEFAULT_USER=postal`, `RABBITMQ_DEFAULT_PASS`, `RABBITMQ_DEFAULT_VHOST=postal`. Mount 1 GB volume at `/var/lib/rabbitmq`. Capture internal hostname.
- [ ] Deploy `postal` (`ghcr.io/postalserver/postal:3`). Configure `/config/postal.yml` (see template in runbook). Set env including `POSTAL_SIGNING_KEY` (generated via `openssl rand -hex 64`), all DB + RabbitMQ connection vars.
- [ ] Set the Postal start command to run `postal initialize-config && postal initialize && postal make-user` on first deploy, then `postal start` for subsequent boots. (Two-step: one-shot init job, then main process.)
- [ ] Attach public Railway domain to the Postal web service → maps to `postal-admin.courseworx.media` once DNS is in place.
- [ ] Do **not** expose port 25 publicly yet — app-to-Postal communication is internal-network only. Public SMTP only needed if external senders relay through us (not this sprint).

**Part B — Postal configuration (via admin UI, one-time):**
- [ ] Visit `https://postal-admin.courseworx.media` → log in with the admin user created by `postal make-user`
- [ ] Create organization: `Course Worx Media`
- [ ] Create mail server: `writers-workbench-mail`
- [ ] Create sending domain: `courseworx.media`. Postal displays the required DNS records for this domain.
- [ ] Create API credential: Organization → Credentials → New → type = API. Capture `key` value → store as Railway env `POSTAL_API_KEY` on `writers-workbench` service.

**Part C — DNS records for courseworx.media:**

Publish the records Postal shows at the DNS provider hosting `courseworx.media`. The types are:

- [ ] **TXT** `postal._domainkey.courseworx.media` — DKIM public key (from Postal UI)
- [ ] **TXT** `postal-verification.courseworx.media` — ownership proof (from Postal UI)
- [ ] **TXT** `@` (root) — SPF: `v=spf1 include:spf.courseworx.media ~all`
- [ ] **TXT** `spf.courseworx.media` — Postal's SPF detail (from Postal UI — contains Railway egress IP)
- [ ] **CNAME** `psrp.courseworx.media` — return-path target (from Postal UI)
- [ ] **TXT** `_dmarc.courseworx.media` — `v=DMARC1; p=quarantine; rua=mailto:dmarc@courseworx.media; pct=100`
- [ ] (MX record for inbound is **NOT** required for this sprint — we only send. User will add later once bounce/reply handling is needed.)

Wait for DNS propagation (usually < 30 minutes). Postal UI shows green checkmarks as each record verifies.

**Part D — Workbench Express email service:**
- [ ] Install `resend` — wait, no, we're using Postal. Install no extra npm packages (direct `fetch` to Postal API).
- [ ] Create `writers-workbench/server/src/lib/email.ts`:
  - `sendEmail({ to, subject, html, text?, bcc?, attachments?, replyTo?, from? })` function
  - Calls `POST ${POSTAL_API_URL}/api/v1/send/message` with `X-Server-API-Key: ${POSTAL_API_KEY}` header
  - Body includes `to`, `from`, `subject`, `html_body`, `plain_body`, `attachments` (array of `{name, content_type, data: base64}`)
  - Handles Postal's response format: `{ status: 'success'|'error', data: { message_id: '...' } }`
  - On error, throws with useful message (Postal's error codes: AccessDenied, ValidationError, NoContent, etc.)
  - Respects `DRY_RUN_EMAIL=true` env var: logs the payload and returns a fake success without actually calling Postal (used by unit tests + staging)
- [ ] Create `writers-workbench/server/src/routes/email.ts`:
  - `POST /api/email/send` — protected by `X-Email-Secret` header. Body: `{ to, subject, html, text?, bcc?, attachments?, replyTo?, user_id? }`. Calls `sendEmail()`. Returns `{ success: true, message_id }`.
  - Per-user rate limit: max 30 emails/minute per `user_id` (via a simple in-memory map; upgrade to Redis in a future sprint when Workbench scales).
- [ ] Zod schema in `schemas.ts`: `EmailSendSchema`.
- [ ] Register router in `server/src/index.ts` behind `generalLimiter`.
- [ ] Health check: add Postal reachability to `/api/health` — `checks.postal: 'ok' | 'error' | 'skipped'`.
- [ ] Add to `.env.example`: `POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1`, `POSTAL_API_KEY=<set in Railway>`, `EMAIL_SECRET=<generate>`, `SENDER_EMAIL=eve@courseworx.media`, `SENDER_NAME=The Writers Workbench`, `REPLY_TO_EMAIL=support@courseworx.media`.

**Part E — Runbook entry (write to `docs/newsletter-migration.md` as part of S11, but capture the content now):**
- Postal config template (`postal.yml`)
- How to rotate API key (Postal admin UI → Credentials → revoke → new)
- How to inspect message logs (Postal admin UI → Mail Server → Messages)
- How to add a new sending domain (rare — if subdomains needed)
- How to check DKIM signing status (Postal admin UI → Domain → Verify)
- Troubleshooting: email landing in spam, Railway IP blocklist, DKIM signature mismatch

**QA Tasks — Unit Tests** (`server/src/test/email.test.ts`):
- [ ] `sendEmail({to, subject, html})` calls Postal API with correct headers + body (mock fetch)
- [ ] `sendEmail` with `attachments` includes base64-encoded content array
- [ ] `sendEmail` throws on Postal error response
- [ ] `DRY_RUN_EMAIL=true` returns fake success without calling fetch
- [ ] `POST /api/email/send` without `X-Email-Secret` → 401
- [ ] `POST /api/email/send` with invalid body → 400 (Zod)
- [ ] Rate limit: 31st email/minute for same `user_id` → 429

**QA Tasks — System Tests:**
- [ ] After DNS propagates, send a test email from Railway: `curl -X POST .../api/email/send -d '{"to":"test@gmail.com","subject":"Postal test","html":"<p>hi</p>"}'` → arrives at Gmail inbox (not spam if DKIM/SPF/DMARC all green)
- [ ] Check Gmail message details → verify `Authentication-Results` shows `spf=pass dkim=pass dmarc=pass`
- [ ] Verify `from:` shows `eve@courseworx.media` (not a Railway-generated address)
- [ ] Send 5 rapid-fire emails — all arrive within 60 seconds
- [ ] Send with 2 MB PDF attachment — arrives intact
- [ ] Simulate Postal down: stop the Postal service; `POST /api/email/send` returns 502; `/api/health` reports `checks.postal: error`

**QA Tasks — E2E Tests:** (Covered by S8 end-to-end newsletter run using Postal.)

**Definition of Done:**
- [ ] 3 Railway services running (postal, mariadb, rabbitmq) with volumes attached
- [ ] Postal admin UI reachable at `postal-admin.courseworx.media`
- [ ] All 6 DNS records published and verified green in Postal
- [ ] Test email sent from Railway arrives at Gmail with SPF/DKIM/DMARC all passing
- [ ] `/api/email/send` endpoint live and authenticated
- [ ] `/api/health` reports Postal status
- [ ] Runbook content drafted

**Depends on:** nothing (parallelizable with everything).

---

### S8 — Slack → Postal email migration (3 pts) | P0

Swap the 7 informational Slack messages for Postal emails sent via the new Workbench endpoint.

**Developer Tasks:**
- [ ] In `Content - Newsletter Agent V2`, replace each of these 7 Slack nodes with an HTTP Request node calling `POST {{$env.WORKBENCH_URL}}/api/email/send` (with `X-Email-Secret` header):
  - `share_selected_stories` → email "Newsletter {{Date}} — Selected Stories"
  - `share_stories_reasoning` → threaded reply email (subject `Re:` prefix)
  - `share_segment_msg` → one email per story segment
  - `share_subject_line` → email
  - `share_subject_line_reasoning` → threaded reply email
  - `share_newsletter_msg` → internal preview notification email
  - `upload_newsletter_file` (Slack file upload) → email with `.md` attachment (convert `create_newsletter_file`'s binary output to Postal's base64 attachment format)
- [ ] Read `recipient_email` + `bcc_email` from Supabase `app_config_v2` (same pattern as other V2 workflows) for the `to` and `bcc` fields.
- [ ] Convert markdown bodies to HTML via n8n Markdown node (existing conversion, just re-targeted).
- [ ] Delete all Slack channel references (`C08PGU0CLKS`) throughout.
- [ ] Remove the Slack credential from the V2 workflow entirely (verify no Slack nodes remain).

**QA Tasks — Unit Tests:** n/a (workflow config)

**QA Tasks — System Tests:**
- [ ] Dry-run the agent up through `share_newsletter_msg`; verify all 7 emails arrive at the test `recipient_email`
- [ ] Emails render correctly: HTML tables, bold, links all render; `.md` attachment downloads as valid file
- [ ] `from:` header is `eve@courseworx.media` on all 7
- [ ] BCC recipient receives copies
- [ ] Thread replies group together in the Gmail reader (subject `Re:` match)
- [ ] Postal admin UI shows all 7 sent messages with `delivered` status

**QA Tasks — E2E Tests:** (Covered by S10 full-run test.)

**Definition of Done:**
- [ ] Zero Slack nodes in `Content - Newsletter Agent V2`
- [ ] All 7 emails route through Workbench `/api/email/send` → Postal
- [ ] All arrive with correct sender domain and pass SPF/DKIM/DMARC

**Depends on:** S6, S7.

---

### S9 — Approval backend (Workbench + Postal) (3 pts) | P0

Workbench-hosted approval service — tokens in Supabase, SSR form on Express, emails sent via Postal.

**Developer Tasks:**
- [ ] (Tables created in S2: `newsletter_approvals_v2`.)
- [ ] Create `writers-workbench/server/src/routes/approvals.ts`:
  - `POST /api/approvals/create` (requires `X-Approval-Secret`): body `{ user_id, stage, payload, resume_url, execution_id }`. Generate `token = crypto.randomBytes(24).toString('base64url')`. Insert into `newsletter_approvals_v2`. Return `{ token, approval_url: '${APPROVAL_BASE_URL}/approvals/${token}' }`.
  - `GET /approvals/:token` (no auth — public URL, token is the credential): SELECT row, check `resolved_at IS NULL AND expires_at > now()`. Render self-contained HTML form (template literal, same lightweight style as `routes/images.ts` — no React) showing the stage's payload (stories list or subject line) + radio Approve/Revise + textarea feedback + submit button. If resolved or expired, render "already resolved" or "expired" page respectively.
  - `POST /approvals/:token/resolve` (no auth, form POST): body `{ decision, feedback }`. In a transaction:
    - Verify row still open (`resolved_at IS NULL AND expires_at > now()`) — else 409
    - UPDATE `SET resolved_at = now(), decision = $1, feedback = $2`
    - `fetch(resume_url, { method: 'POST', body: JSON.stringify({ decision, feedback }) })` to kick the n8n Wait node
    - Render thank-you HTML (styled to match `eve@courseworx.media` branding)
- [ ] Register router in `server/src/index.ts`.
- [ ] Add env vars to `.env.example`: `APPROVAL_SECRET`, `APPROVAL_BASE_URL`.
- [ ] Zod schemas for `create` body and `resolve` body.
- [ ] OpenAPI annotations.

**Approval emails (sent from n8n via Postal in S10):** The emails sent to reviewers use Postal via `/api/email/send`. This story only covers the approval backend itself. The email-from-n8n wiring is S10.

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

**QA Tasks — E2E Tests:** (Covered by S10.)

**Definition of Done:**
- [ ] All unit tests passing
- [ ] TypeScript clean
- [ ] Route registered
- [ ] `.env.example` updated
- [ ] Integration test with mock n8n resume endpoint passes

**Depends on:** S2.

---

### S10 — Newsletter Agent: Slack sendAndWait → Postal approval flow (5 pts) | P0

Swap the two approval gates to use the new backend + Postal emails.

**Developer Tasks:**
- [ ] In `Content - Newsletter Agent V2`, for both `share_stories_approval_feedback` and `share_subject_line_approval_feedback`, replace with a 3-node group:
  - `create_approval_stories` (HTTP Request POST): `{{$env.WORKBENCH_URL}}/api/approvals/create` with `X-Approval-Secret` header, body `{ user_id, stage: 'stories', payload: <current stories>, resume_url: $execution.resumeUrl, execution_id: $execution.id }`. Returns `{ token, approval_url }`.
  - `send_approval_email_stories` (HTTP Request POST to `/api/email/send` with `X-Email-Secret`): subject `"Newsletter {{Date}} — approve stories"`, HTML body with rendered story list (use Markdown node to convert the LLM's markdown story list to HTML) + a prominent button linking to `{{$json.approval_url}}`. Sender: `eve@courseworx.media`.
  - `wait_for_stories_approval` (Wait node, mode "On Webhook Call", timeout 48h): resumes when the approval resolve endpoint POSTs `{ decision, feedback }` to its resume URL.
- [ ] Downstream: `extract_stories_approval_feedback` (LLM) and `check_stories_feedback` (IF) keep their existing logic — input shape `{ decision, feedback }` is preserved. Same for subject line.
- [ ] The `edit_top_stories` / `edit_subject_line` revise-loop path re-enters `create_approval_*` for the second round — identical pattern, new nodes only at the gate.
- [ ] Same 3-node pattern for the subject line gate.
- [ ] Add `NEWSLETTER_USER_ID` n8n env var (identifies which Workbench user owns these ingestions/approvals/sends — initially the superuser `+14105914612`).

**QA Tasks — Unit Tests:** n/a (workflow config)

**QA Tasks — System Tests:**
- [ ] Happy path (approve both rounds):
  - Submit form with a date that has ingested content
  - Stories email arrives from `eve@courseworx.media` in < 30s
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

**QA Tasks — E2E Tests:** (Covered by S11 full acceptance.)

**Definition of Done:**
- [ ] Both approval gates use Workbench + Postal
- [ ] Zero Slack mentions remain in `Content - Newsletter Agent V2`
- [ ] Happy path + revise path + timeout path + double-click all exercised

**Depends on:** S6, S7, S8, S9.

---

### S11 — Save scheduled newsletter, activation, docs, cutover (3 pts) | P0

Final step: after both approvals, save the approved newsletter to `newsletter_sends_v2` with `status='scheduled'` and `scheduled_send_at` set. The actual release is deferred to the future Writer's Workbench calendar sprint. Also: activate V2 workflows, retire Orig versions, write runbook.

**Developer Tasks:**

**Part A — `/api/newsletter-sends/save` endpoint:**
- [ ] Create `writers-workbench/server/src/routes/newsletter-sends.ts`:
  - `POST /api/newsletter-sends/save` (requires `X-Ingestion-Secret`): body `{ user_id, send_date, subject, preheader, html_body, markdown_body, scheduled_send_at? }`. Default `scheduled_send_at` to `now() + interval '24 hours'` if not provided. Upsert into `newsletter_sends_v2` with `status='scheduled'`. Returns `{ id, scheduled_send_at, status }`.
  - `GET /api/newsletter-sends/scheduled` (requires admin auth, for future calendar use): returns rows where `status='scheduled' AND scheduled_send_at <= now() + interval '7 days'`. Not actively consumed in this sprint but proves the data model.
- [ ] Register router; add Zod schema `NewsletterSendSaveSchema`.

**Part B — Wire newsletter agent final step:**
- [ ] In `Content - Newsletter Agent V2`, after the subject-line approval completes and the internal preview email (S8 `share_newsletter_msg`) is sent, insert a new terminal group:
  - [ ] `save_scheduled_newsletter` (HTTP Request POST to `/api/newsletter-sends/save`): body includes subject, preheader, html_body, markdown_body, send_date, user_id. Don't include `scheduled_send_at` — let the server default.
  - [ ] `final_notification` (HTTP Request POST to `/api/email/send`): email to reviewer "Newsletter for {{send_date}} saved as scheduled; release on {{response.scheduled_send_at}}" — includes attached `.md` + link to newsletter_sends_v2 row ID.
  - [ ] No actual subscriber delivery in this sprint.

**Part C — Cleanup & activation:**
- [ ] Final sweep of `Content - Newsletter Agent V2`: `grep -i slack` returns nothing; `grep C08PGU0CLKS` returns nothing; no Slack credential attached.
- [ ] Final sweep of `AI News Data Ingestion V2`: no references to `api.aitools.inc`, no references to the S3 bucket `data-ingestion`, no references to `qVEM2rCD1jlJPeRs`.
- [ ] Activate `AI News Data Ingestion V2` and `Content - Newsletter Agent V2`.
- [ ] Deactivate the Orig versions (`53SlwZMS21gpvz3H`, `4DQ7DmA9pFtXzsKX`).
- [ ] Run one full end-to-end acceptance test on a real date.

**Part D — Documentation & runbook (`writers-workbench/docs/newsletter-migration.md`):**
- [ ] Architecture diagram (copy from this sprint doc)
- [ ] Workflow inventory: IDs of `AI News Data Ingestion V2`, `Content - Newsletter Agent V2`, `Node - Scrape Url V2`
- [ ] Supabase tables: `content_ingestion_v2`, `newsletter_approvals_v2`, `newsletter_sends_v2` — schema reference
- [ ] Storage bucket: `newsletter-ingestion` — access pattern
- [ ] Postal service inventory: `postal`, `postal-mariadb`, `postal-rabbitmq` Railway services, admin URL, API endpoint
- [ ] DNS records reference for `courseworx.media`
- [ ] Env var reference table (all secrets used across Workbench + n8n)
- [ ] Credential IDs: Firecrawl (n8n httpHeaderAuth), Postal (Workbench env + n8n env)
- [ ] Postal `postal.yml` config template (exact YAML the production deployment uses)
- [ ] Runbook — common issues:
  - Approval email not arriving → check Postal admin UI → Messages, check spam folder, verify DKIM pass in received headers
  - Approval link shows 404 → check `APPROVAL_BASE_URL` env var on Railway, check row exists in `newsletter_approvals_v2`
  - Workflow timeout → check `expires_at`, check resume URL still valid (n8n execution ID not purged)
  - Postal down → check 3 Railway services (postal, mariadb, rabbitmq) all running; `/api/health` should report `checks.postal: error` if Postal is unreachable
  - Supabase storage full → check bucket quota (Supabase dashboard)
  - Newsletter stuck in `status='scheduled'` → this is expected until the calendar sprint is built; rows accumulate for future processing
- [ ] Ops queries:
  - Today's ingestion: `SELECT type, count(*) FROM content_ingestion_v2 WHERE created_at > now() - interval '24 hours' GROUP BY type;`
  - Pending approvals: `SELECT * FROM newsletter_approvals_v2 WHERE resolved_at IS NULL AND expires_at > now();`
  - Scheduled newsletters awaiting release: `SELECT id, send_date, subject, scheduled_send_at FROM newsletter_sends_v2 WHERE status='scheduled' ORDER BY scheduled_send_at;`
  - Postal messages sent today: visit `postal-admin.courseworx.media` → Mail Server → Messages

**Part E — Memory updates:**
- [ ] Update `CLAUDE.md` with new baseline protection: `AI News Data Ingestion V2`, `Content - Newsletter Agent V2`, `Node - Scrape Url V2` workflows, Postal installation on Railway, `courseworx.media` DNS.
- [ ] Update `MEMORY.md` with newsletter system pointers and Postal infrastructure notes.

**QA Tasks — Unit Tests** (`server/src/test/newsletter-sends.test.ts`):
- [ ] `POST /api/newsletter-sends/save` with valid payload → inserts row with `status='scheduled'` and default `scheduled_send_at = now() + 24h`
- [ ] `POST /api/newsletter-sends/save` with explicit `scheduled_send_at` → uses provided value
- [ ] Duplicate `(user_id, send_date)` where existing row has `status != 'cancelled'` → upsert (update existing, no duplicate)
- [ ] Missing `X-Ingestion-Secret` → 401
- [ ] Invalid `status` value enforced by CHECK → pre-validated by Zod, 400

**QA Tasks — System Tests:**
- [ ] End-to-end: approve stories + subject → final newsletter saved to `newsletter_sends_v2` with `status='scheduled'`
- [ ] Query the row: `scheduled_send_at` is ~24 hours in future
- [ ] Row contains full HTML body, markdown body, subject, preheader
- [ ] Internal preview email arrived with `.md` attachment

**QA Tasks — E2E (sprint acceptance):**
- [ ] All 17 feeds ingest without error over a 24-hour window
- [ ] Reddit self-posts captured (≥ 3 `type='reddit_post'` rows on a day with subreddit activity)
- [ ] Newsletter generation runs end-to-end:
  - Stories approval email < 30s after trigger, arrives from `eve@courseworx.media` with SPF/DKIM/DMARC pass
  - Revision loop works on demand
  - Subject-line approval email < 30s after story approval
  - Internal Postal preview email arrives after final approval with `.md` attachment
  - `newsletter_sends_v2` row inserted with `status='scheduled'`, correct `scheduled_send_at`
- [ ] **Zero Slack messages** (verify Slack channel `C08PGU0CLKS` has no new messages from the test period)
- [ ] **Zero Gmail OAuth sends** in these V2 workflows (verify via Gmail audit log — other workflows on Gmail are unaffected)
- [ ] **Zero** `api.aitools.inc` calls (verify n8n execution logs, Workbench server access logs)
- [ ] **Zero** references to old S3 bucket `data-ingestion` in the V2 workflows
- [ ] **Zero** references to `qVEM2rCD1jlJPeRs` in the V2 workflows
- [ ] Orig workflows inactive and have not executed since the cutover
- [ ] Writer's Workbench app itself (existing routes) unaffected: all 214 client unit tests, 124 server unit tests pass; existing E2E tests pass
- [ ] Postal admin UI shows all sent messages with `delivered` status, no bounces, no deferrals

**Definition of Done:**
- [ ] `/api/newsletter-sends/save` endpoint live with passing tests
- [ ] V2 workflows active, Orig workflows inactive
- [ ] Full E2E acceptance passed
- [ ] `docs/newsletter-migration.md` committed
- [ ] `MEMORY.md` and `CLAUDE.md` updated
- [ ] Sprint retrospective notes captured

**Depends on:** all previous stories (S1–S10).

---

## Dependency Graph

```
S1 ──────────────────────┐
                         │
S2 ──┬── S3 ──> S4 ──> S5 ──┐
     │   │                  │
     │   └──> S6 ───────────┤
     │                      │
S7 ──┼──> S8 ───────────────┤
     │                      │
     └──> S9 ──> S10 ───────┤
                            │
                            ▼
                           S11
```

**Recommended order (solo):** S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11

**Recommended order (two tracks):**
- Track A (n8n workflows): S1 → S4 → S5 → S8 → S10
- Track B (Workbench server + Supabase + Postal): S2 → S3 → S7 → S6 → S9
- Converge at S11

Note: S7 (Postal install) is fully parallelizable with S2–S6 since it touches different infra. Start S7 early to absorb the DNS-propagation wait.

---

## Critical Files

### New

| File | Story |
|---|---|
| `writers-workbench/migrations/009_newsletter_ingestion.sql` | S2 |
| `writers-workbench/server/src/routes/ingestion.ts` | S3 |
| `writers-workbench/server/src/lib/email.ts` | S7 |
| `writers-workbench/server/src/routes/email.ts` | S7 |
| `writers-workbench/server/src/routes/approvals.ts` | S9 |
| `writers-workbench/server/src/routes/newsletter-sends.ts` | S11 |
| `writers-workbench/server/src/test/ingestion.test.ts` | S3 |
| `writers-workbench/server/src/test/email.test.ts` | S7 |
| `writers-workbench/server/src/test/approvals.test.ts` | S9 |
| `writers-workbench/server/src/test/newsletter-sends.test.ts` | S11 |
| `writers-workbench/docs/newsletter-migration.md` | S11 |
| `writers-workbench/docs/postal-runbook.md` (or section of newsletter-migration.md) | S7 |

### Modified

| File | Change |
|---|---|
| `writers-workbench/server/src/index.ts` | Register 4 new routers: ingestion, email, approvals, newsletter-sends |
| `writers-workbench/server/src/routes/health.ts` | Add `checks.postal` reachability to health response (S7) |
| `writers-workbench/server/src/schemas.ts` | Zod schemas for new endpoints |
| `writers-workbench/client/src/types/database.ts` | Add `ContentIngestion`, `NewsletterApproval`, `NewsletterSend` types (for Phase 2 UI) |
| `writers-workbench/.env.example` | `INGESTION_SECRET`, `APPROVAL_SECRET`, `APPROVAL_BASE_URL`, `FIRECRAWL_API_KEY`, `EMAIL_SECRET`, `POSTAL_API_URL`, `POSTAL_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`, `REPLY_TO_EMAIL`, `NEWSLETTER_USER_ID` |
| `CLAUDE.md` | Add newsletter V2 workflows + Postal services to baseline protection list |

### Railway services (NEW)

| Service | Image | Purpose |
|---|---|---|
| `postal` | `ghcr.io/postalserver/postal:3` | Email server (web/API/worker — 1 container) |
| `postal-mariadb` | `mariadb:10.11` | Postal metadata + credentials |
| `postal-rabbitmq` | `rabbitmq:3-management` | Postal internal job queue |

### DNS records (NEW) on `courseworx.media`

| Record | Purpose | Source |
|---|---|---|
| TXT `postal._domainkey` | DKIM public key | Postal admin UI |
| TXT `postal-verification` | Domain ownership proof | Postal admin UI |
| TXT `@` | SPF include directive | Manually constructed |
| TXT `spf` | SPF IP list | Postal admin UI |
| CNAME `psrp` | Return-path target | Postal admin UI |
| TXT `_dmarc` | DMARC policy | Manually authored |

### n8n workflows

| Workflow | Action |
|---|---|
| `AI News Data Ingestion Orig` (`53SlwZMS21gpvz3H`) | Clone to V2, deactivate Orig in S11 |
| `Content - Newsletter Agent` (`4DQ7DmA9pFtXzsKX`) | Clone to V2, deactivate Orig in S11 |
| `Node - Scrape Url` (`bXBsnU4d6OseXWho`) | Clone to V2, activate |
| `Node - Scrape Url` duplicate (`glJfsY6KaO0aoX0A`) | Mark `[OLD]` or delete in S1 |

### n8n env vars (NEW)

- `WORKBENCH_URL`, `INGESTION_SECRET`, `APPROVAL_SECRET`, `EMAIL_SECRET`, `NEWSLETTER_USER_ID`

### Patterns to reuse

- `writers-workbench/server/src/services/supabase-admin.ts` — lazy-init singleton pattern (existing)
- `writers-workbench/server/src/routes/images.ts` — route structure + binary handling for new ingestion routes
- `writers-workbench/server/src/routes/session.ts` — SSE + token-based auth pattern for approval form

---

## Sprint-Level Verification

**Pre-sprint checklist:**
- [ ] V2 Supabase accessible; service role key rotated and in Railway env
- [ ] DNS admin access for `courseworx.media` confirmed (need to publish 6 records in S7)
- [ ] n8n credentials reviewed: Firecrawl API key valid
- [ ] Railway Workbench service healthy (all existing routes responding)
- [ ] Railway project has room for 3 new services (Postal, MariaDB, RabbitMQ) — ~$34/mo additional

**Sprint acceptance (executed in S11):**
1. **Clean state:** Apply migration; verify all 3 new tables + storage bucket exist; RLS active.
2. **Postal running:** 3 Railway services healthy. Admin UI reachable at `postal-admin.courseworx.media`. All DNS records verified green. Test email from `eve@courseworx.media` to a Gmail inbox arrives with SPF/DKIM/DMARC all passing.
3. **Env configured:** All secrets present on both Railway and n8n; `app_config_v2.recipient_email` set to reviewer inbox.
4. **Workbench deploys:** `/api/ingestion/search?prefix=never-matches` returns `[]`; `/api/approvals/create` without secret returns 401; `/api/email/send` without secret returns 401; `/api/newsletter-sends/save` without secret returns 401; `/api/health` reports `checks.postal: ok`.
5. **Ingestion active:** `AI News Data Ingestion V2` on for 4 hours; verify rows across types (`newsletter`, `article`, `reddit_post`, `tweet`).
6. **Blobs verified:** Download a random `.md` from `newsletter-ingestion` bucket → confirm non-empty + matches DB row's title.
7. **Approval flow:** Trigger `Content - Newsletter Agent V2` form; approval emails arrive from `eve@courseworx.media`; click link → form renders → submit Approve/Revise → workflow advances.
8. **Internal preview:** Postal `.md` attachment email arrives as internal record.
9. **Scheduled save:** `newsletter_sends_v2` row inserted with `status='scheduled'` and `scheduled_send_at` populated (default 24h out).
10. **Regression:** No Slack posts; no errors in Railway logs; no failed n8n executions; Writer's Workbench app unchanged (all existing 214 client + 124 server unit tests still pass).
11. **Cutover:** Orig workflows deactivated.

---

## Out of scope (future sprints)

- **Calendar-driven release.** The final release of scheduled newsletters (moving `status='scheduled'` → `sent`) is deferred to a future sprint that builds the Writer's Workbench calendar UI + a cron-style worker. This sprint leaves the rows waiting in `newsletter_sends_v2` with `scheduled_send_at` set.
- **Phase 2 — Web UI integration.** Newsletter pages in the Writer's Workbench app: subscriber list viewer, send history (`newsletter_sends_v2`), manual trigger, archive of past newsletters, approval viewer as alternative to email link.
- **Migration of other V2 workflows to Postal.** The other 15 email-sending V2 workflows (blog, chapter, short story, etc.) remain on Gmail OAuth for now. A future sprint migrates them onto `/api/email/send` → Postal to retire the Gmail credential entirely.
- **CRM integration (GoHighLevel).** Reconsidered later once the product is established. The `newsletter_sends_v2.delivery_provider` column is ready for it.
- **Data migration from old S3 bucket.** Historical newsletters + ingestion data remain in the AWS S3 bucket `data-ingestion`; no migration in scope.
- **Analytics dashboard.** Opens, clicks, bounces, unsubscribes — Phase 3.
- **Multiple newsletter lists / topics.** Currently one daily newsletter for one audience. Multi-list support is future scope.
- **Public SMTP relay through Postal.** Currently internal-only (Express → Postal). Exposing port 25 publicly (for external senders to relay) is a future hardening task.
- **Bounce / reply handling.** Requires MX record for `courseworx.media` and Postal inbound routing. Not needed until we send to real subscribers.

---

## Appendix A — Railway install quick reference (Postal)

**Copy-paste-ready** for the Railway dashboard. Follow in order.

### Service 1 — `postal-mariadb`

Create: New Service → Deploy from Docker Image
- Image: `mariadb:10.11`
- Env vars:
  ```
  MARIADB_ROOT_PASSWORD=<openssl rand -base64 24>
  MARIADB_DATABASE=postal
  MARIADB_USER=postal
  MARIADB_PASSWORD=<openssl rand -base64 24>
  ```
- Volume: New Volume, mount at `/var/lib/mysql`, size 5 GB
- Expose: private networking only (no public)
- Capture: service internal DNS name (e.g., `postal-mariadb.railway.internal`)

### Service 2 — `postal-rabbitmq`

Create: New Service → Deploy from Docker Image
- Image: `rabbitmq:3-management`
- Env vars:
  ```
  RABBITMQ_DEFAULT_USER=postal
  RABBITMQ_DEFAULT_PASS=<openssl rand -base64 24>
  RABBITMQ_DEFAULT_VHOST=postal
  ```
- Volume: New Volume, mount at `/var/lib/rabbitmq`, size 1 GB
- Expose: private only
- Capture: internal DNS name

### Service 3 — `postal`

Create: New Service → Deploy from Docker Image
- Image: `ghcr.io/postalserver/postal:3`
- Public domain: attach `postal-admin.courseworx.media` (Railway issues TLS cert after DNS points at Railway)
- Env vars:
  ```
  POSTAL_SIGNING_KEY=<openssl rand -hex 64>
  MAIN_DB_HOST=<postal-mariadb internal hostname>
  MAIN_DB_USERNAME=postal
  MAIN_DB_PASSWORD=<from service 1>
  MAIN_DB_DATABASE=postal
  MESSAGE_DB_HOST=<same as MAIN_DB_HOST>
  MESSAGE_DB_USERNAME=postal
  MESSAGE_DB_PASSWORD=<from service 1>
  MESSAGE_DB_PREFIX=postal
  RABBITMQ_HOST=<postal-rabbitmq internal hostname>
  RABBITMQ_USERNAME=postal
  RABBITMQ_PASSWORD=<from service 2>
  RABBITMQ_VHOST=postal
  RAILS_ENV=production
  ```
- Config file mount: `/config/postal.yml` (paste template below as a Railway config file or into the service's filesystem; alternatively use Railway's file mount feature)
- Pre-deploy one-shot command (run manually once, then replace with main command):
  ```
  postal initialize-config && postal initialize && postal make-user
  ```
  (`make-user` prompts interactively for email + password — use Railway shell or SSH into the container briefly.)
- Main command: `postal start`

### `postal.yml` template

```yaml
postal:
  web_hostname: postal-admin.courseworx.media
  smtp_hostname: smtp.courseworx.media
  use_ip_pools: false

web_server:
  bind_address: 0.0.0.0
  port: 5000

smtp_server:
  port: 25
  tls_enabled: false

main_db:
  host: <from env>
  username: postal
  password: <from env>
  database: postal

message_db:
  host: <from env>
  username: postal
  password: <from env>
  prefix: postal

rabbitmq:
  host: <from env>
  username: postal
  password: <from env>
  vhost: postal

dns:
  mx_records: ["mx.courseworx.media"]
  smtp_server_hostname: smtp.courseworx.media
  spf_include: spf.courseworx.media
  return_path: rp.courseworx.media
  dkim_identifier: postal
  domain_verify_prefix: postal-verification
  domain_mx_prefix: postal-mx
  custom_return_path_prefix: psrp
```

### After Postal boots

1. Visit `https://postal-admin.courseworx.media` → log in with the user from `make-user`
2. Click **New Organization** → name `Course Worx Media`
3. Inside org → **Servers** → **New Server** → name `writers-workbench-mail`
4. Inside server → **Domains** → **New Domain** → `courseworx.media`
5. Postal displays a list of DNS records to publish — **copy each one** and add at your DNS provider for `courseworx.media`
6. Wait for DNS propagation (5–30 min) → click **Verify** on each Postal domain record until all green
7. **Credentials** → **New Credential** → type `API` → name `writers-workbench-server` → copy the `key` value → save as Railway env `POSTAL_API_KEY` on the `writers-workbench` service

### Cost

| Item | vCPU / RAM | Volume | Monthly |
|---|---|---|---|
| postal-mariadb | 0.25 / 512 MB | 5 GB | ~$11 |
| postal-rabbitmq | 0.25 / 256 MB | 1 GB | ~$8 |
| postal | 0.5 / 1 GB | — | ~$15 |
| **Total** | | | **~$34/mo** |

This replaces the Gmail OAuth dependency for newsletter flows starting in S8. Other V2 workflows can migrate onto it in follow-up sprints with a one-line URL swap (Gmail node → HTTP POST `/api/email/send`).
