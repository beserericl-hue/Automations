# Writer's Workbench — Newsletter Integration Spec

**Status:** Accepted — supersedes the Phase 2a draft of 2026-04-24.
**Last updated:** 2026-04-24
**Companion docs:**
- [`newsletter-agent-workflow.md`](./newsletter-agent-workflow.md) — canonical reference for `Content - Newsletter Agent V2` (`bMvMKyK8obwYZmNb`) and its dependencies. Read first.
- [`newsletter-migration-workflow-ids.md`](./newsletter-migration-workflow-ids.md) — IDs, credentials, activation history for the n8n side.
- [`compose-newsletter-sprint.md`](./compose-newsletter-sprint.md) — the two-week Phase 2a sprint that delivers the first slice of this spec.

**Owner:** TBD
**Scope:** Every web-app surface in `writers-workbench/client` + every Express endpoint in `writers-workbench/server` that the newsletter pipeline touches, once the UI replaces the email round-trip as the human in the loop.

---

## 0. TL;DR

The n8n pipeline `Content - Newsletter Agent V2` is production. It already:

- reads `content_ingestion_v2` through `/api/ingestion/*`,
- runs two approval gates through `/api/approvals/create` + the public `/approvals/:token` SSR page,
- sends reviewer emails through `/api/email/send` → Postal,
- parks the final draft in `newsletter_sends_v2` through `/api/newsletter-sends/save`.

**This spec does not change the n8n contract.** It replaces the _email + SSR-form_ human-loop with _in-app pages + SSE + session-authenticated approvals_, surfaces the lifecycle (ingestion → generate → watch → approve → scheduled → sent) as first-class routes, and makes the pipeline edition-agnostic so future genre newsletters plug in via a row insert into `newsletter_editions_v2`.

The UI is additive: the public `/approvals/:token` page keeps working for email recipients, and n8n still speaks only HTTP to the Workbench server — never to the browser.

---

## 1. Problem

Today, to publish _The Workbench — Dispatches from the Machine Room_ (AI news edition), a curator:

1. Opens an n8n-hosted public form URL in a browser.
2. Types a date, hits submit.
3. Switches to Gmail to wait for `Newsletter {Date} — Selected Stories` to arrive.
4. Clicks an _"Open approval form"_ button in the email to land on an SSR page at `writersworkbenchdev-production.up.railway.app/approvals/:token`.
5. Picks Approve or Revise, types feedback, submits.
6. Back to Gmail, waits for the subject-line approval email.
7. Repeats steps 4–5.
8. Waits for seven segment-preview emails.
9. Eventually gets `Newsletter {date} — saved as scheduled` with the `.md` as an attachment.

This works for a solo operator with Gmail in one window and a stopwatch. It doesn't work for:

- **Reviewing _why_ a story wasn't picked** — no browsable view of `content_ingestion_v2`.
- **Following a 20–40 minute run in real time** — seven Postal emails, not a progress bar.
- **Handing curation to a non-technical editor** — the n8n form URL and the Postal sender domain both expose internals.
- **Running the pipeline for different _editions_** — a new genre (political sci-fi, romance, etc.) means duplicating an n8n form, hard-coding subheaders in the workflow, and wiring a new Postal recipient.

This spec puts the entire lifecycle inside the Writer's Workbench app.

---

## 2. Product framing

### 2.1 One product surface, many editions

The web-app feature is called **"The Workbench"** — a dispatch desk for branded newsletters. The first live edition is:

> # The Workbench
> *Dispatches from the Machine Room*
> **A CourseworxAI Weekly**

Future editions (one per genre the Writer's Workbench supports) follow the same masthead pattern with a genre-flavored subheader:

| Genre | Subheader |
|---|---|
| AI news | *Dispatches from the Machine Room* |
| Political sci-fi | *Field Notes from Tomorrow* |
| Political dark comedy | *Gallows & Gavels* |
| Literary fiction | *Margin Notes* |
| Historical fiction | *From the Archives* |
| Thriller | *Leads & Loose Ends* |
| Romance | *Longhand & Longing* |
| Non-fiction essay | *Received Wisdom* |

The subheader, display name, paper color, and primary color are stored per edition in a new `newsletter_editions_v2` table (§6.1). This sprint ships the AI-news edition only; subsequent editions are SQL row inserts — **no schema or code changes per genre**, no duplicate n8n workflows.

### 2.2 Audience for the UI

Primary user: **Eric and future peers** — curator/writer who wants to

- trigger a run,
- watch it run,
- review and curate stories without leaving the app,
- approve / revise both gates inline,
- see every scheduled send and every past send,
- drill into the source content that fed a story (the ingestion browser).

The UI is emphatically **not** a WYSIWYG editor for the final HTML. The n8n workflow generates the markdown + HTML; humans approve at two checkpoints (stories, subject). This spec does not change that contract. It makes the checkpoints livable.

### 2.3 The human-in-the-loop swap

Canonically:

- **Before:** n8n workflow sends a Postal email → user clicks button in email → SSR page at `/approvals/:token` → resolve → POST to `$execution.resumeUrl` resumes the Wait node.
- **After:** n8n workflow posts to `/api/approvals/create` as today, but the _reviewer-facing surface_ becomes the in-app tracker page. The email still goes out (for archive / external reviewer) but contains the same URL that the in-app tracker links to. The user approves inline, the session-authenticated `POST /api/newsletter/approvals/:token/resolve` runs the _identical_ server logic as the public endpoint, n8n resumes identically.

One token, two surfaces — one for external reviewers, one for the logged-in user. Double-resolve is prevented by the existing `WHERE resolved_at IS NULL` guard.

---

## 3. Information architecture

Single sidebar entry `Newsletter` expands into eight routes under `/newsletter/*`:

```
/newsletter                        Home — dashboard + recent runs
/newsletter/generate               Trigger form (edition, date, prev content)
/newsletter/execution/:id          Live stage tracker for an in-flight run
/newsletter/approvals              Pending-approvals inbox
/newsletter/approvals/:token       In-app Approve / Revise form
/newsletter/sends                  Scheduled + Sent history
/newsletter/sends/:id              Single newsletter detail (preview + metadata)
/newsletter/ingestion              "What got scraped" browser
```

All routes are protected by `requireAuth` session middleware; list pages are RLS-filtered to the session user's `user_id`.

### 3.1 Home (`/newsletter`)

Landing page is a **three-tile dashboard + recent runs table**.

1. **In-flight run?** — if any `newsletter.stage` SSE event in the last 30 minutes has `stage !== 'saved'`, show edition + stage pill + `Resume →` link to `/newsletter/execution/:id`.
2. **Pending approvals** — count + list of up to three with direct review links.
3. **Next scheduled send** — `SELECT ... FROM newsletter_sends_v2 WHERE status='scheduled' ORDER BY scheduled_send_at LIMIT 1`.

Below: `RecentRunsTable` — 10 rows, columns `send_date`, edition badge, subject, status pill, stage, issue_number, row click → send detail (if saved) or execution tracker (if in-flight).

Primary action in `PageHeader`: `Generate newsletter →`.

### 3.2 Generate (`/newsletter/generate`)

UI fields:

- **Edition** — dropdown populated from `GET /api/newsletter/editions`. Default `ai-news`.
- **Date** — required date input, defaults to today. Used as the `prefix` for `/api/ingestion/search` inside the workflow.
- **Previous newsletter content** — optional textarea, prefilled from the most recent `newsletter_sends_v2.markdown_body` for the selected edition via `GET /api/newsletter/editions/:id/last-sent-markdown`.
- **Submit** — `POST /api/newsletter/generate` → server POSTs JSON to the n8n **webhook trigger** (not the form trigger) at `N8N_NEWSLETTER_WEBHOOK_URL` with `X-Ingestion-Secret` header. The webhook's first node is `Respond to Webhook` returning `{executionId: $execution.id, editionId}` synchronously → server returns `{executionId, started: true}` → client navigates directly to `/newsletter/execution/:executionId`. **No `correlationId` round-trip** — the executionId is known before the client redirects.

**Webhook over form trigger.** The original sprint draft used the n8n `formTrigger` because the workflow predates the in-app UI; with the UI owning input collection there's no reason to render an n8n-hosted HTML form, encode `multipart/form-data`, or invent a `correlationId` to stitch the optimistic redirect. A plain `webhook` trigger with a synchronous `respondToWebhook` node returns `executionId` directly. The trigger is auth-gated by `X-Ingestion-Secret` (reused from the existing ingestion cred), closing the "anyone with the URL can trigger a run" gap that the form trigger left open.

The n8n `formTrigger` node stays in the workflow as a **secondary entry point** for ops/debug use (curators can still hit the form URL in a browser if the Workbench is down). Both triggers funnel through a single `set_trigger_inputs` Set node so every downstream reference is `$('set_trigger_inputs')` regardless of which entry was used.

### 3.3 Execution tracker (`/newsletter/execution/:id`)

**The** key page for the day a run happens. Four regions:

1. **Header** — `Edition · Date · Issue #<n>` (issue number is only present after `saved`); right-aligned `Open in n8n →` dev-mode link.
2. **Stage strip** — 7 pills, horizontally, labels and icons matching §4.1:

   `Gathering → Selecting stories → Stories approval → Subject line → Subject approval → Writing segments → Saved`

   States: `done` (green check + elapsed time), `active` (blue, pulsing), `pending` (gray), `error` (red + last-error detail on hover).
3. **Two-column body** at `lg` (stacks at `md`):
   - Left (`flex-1`): **Live log** — terminal-style SSE feed, monospace, auto-scrolls to bottom unless the user scrolled up. Color codes info / stage-change / warn / error. Fixed height, scrollable.
   - Right (`w-[480px]`): **Awaiting-your-action panel** — conditional. Renders only when the active stage is `awaiting_stories_approval` or `awaiting_subject_approval`. Body is the appropriate `ApprovalPayload*` component; footer is a radio (`Approve` / `Revise`), feedback textarea (shown on Revise), submit button. Submit → `POST /api/newsletter/approvals/:token/resolve` → optimistic stage advance → n8n Wait node resumes within seconds.
4. **Collapsible `<details>` `Raw events`** at the bottom — every SSE event in the session, pretty-printed JSON. Debugging aid.

State durability: on mount, fetch `GET /api/newsletter/execution/:id/status` (n8n proxy) _and_ `GET /api/newsletter/approvals/open?execution_id=:id` so a page refresh during a run reconstructs the strip and re-renders the pending approval. If Story S12 (stage-event persistence) ships, also reconstruct the log from `newsletter_stage_events_v2`.

### 3.4 Pending approvals (`/newsletter/approvals`)

Table over `GET /api/newsletter/approvals/open`. Columns: stage, edition, created_at, expires_at (relative — "in 36h"), excerpt (first 140 chars of `payload.top_selected_stories[0].title` or `payload.subject_line`), `Review →`.

Sidebar badge binds to the row count.

### 3.5 Approval detail (`/newsletter/approvals/:token`)

Same `ApprovalPayload*` + form as the execution tracker's right pane, but full-width and standalone. Used when navigating from the email or from the inbox. On submit, navigates back to the inbox.

### 3.6 Scheduled + Sent history (`/newsletter/sends`)

Single table. Status filter pills across the top (`All / Scheduled / Sending / Sent / Failed / Cancelled`). Columns: `send_date`, edition badge, subject, status pill, `recipient_count` (nullable), `scheduled_send_at`, `sent_at`. Row click → detail.

### 3.7 Newsletter detail (`/newsletter/sends/:id`)

Two columns at `lg`, tabbed at `md`:

- **Rendered preview** — left, 640px iframe. Desktop / Mobile toggle (640px / 375px). Loads `GET /api/newsletter/sends/:id/preview.html` — a standalone HTML doc with `Content-Security-Policy` headers that scope editorial styling inside the iframe.
- **Metadata** — right, 360px. All DB fields cleanly formatted. `execution_id` linked to the n8n execution viewer via `N8N_UI_URL`. `provider_message_id` shown when Postal delivery is complete.

Below, collapsible `<details>` `Markdown source` with a copy button.

### 3.8 Ingestion browser (`/newsletter/ingestion`)

Dense table over `content_ingestion_v2`. Filters on top:

- Date range (default: last 7 days).
- Type checkboxes (`article` / `reddit_post` / `tweet` / `newsletter`).
- Source multi-select, facets from `GET /api/newsletter/ingestion/sources`.
- Search box (ILIKE on `title`).

Row click → right drawer with full markdown preview + _"Used in newsletter ##X"_ backlink if the key appears in any `newsletter_sends_v2.metadata.source_keys` (stretch; returns `null` in v1).

---

## 4. Visual design

Writer's Workbench chrome is cool-gray + Signal Blue, flat-first, Tailwind-native. See `/README.md` → Visual Foundations in the design system. The newsletter feature follows that chrome **exactly** — it's a product surface, not an editorial surface.

### 4.1 Stage strip vocabulary

Seven canonical stages. Labels, pill colors, and SSE event stages align one-to-one:

| # | Label | `stage` (SSE) | Emitting n8n node | Pill when active |
|---|---|---|---|---|
| 1 | Gathering | `gathering` | `emit_stage_gathering` (after `set_trigger_inputs`) | `bg-blue-100 text-blue-700` pulsing |
| 2 | Selecting stories | `selecting_stories` | `emit_stage_picking` (after `pick_top_stories`) | same |
| 3 | Stories approval | `awaiting_stories_approval` | `emit_stage_awaiting_stories` (after `create_approval_stories`) | `bg-amber-100 text-amber-700` pulsing |
| 4 | Subject line | `subject_approved` ← upstream `writing` | `emit_stage_stories_approved` (after `check_stories_feedback` true) | blue pulsing |
| 5 | Subject approval | `awaiting_subject_approval` | `emit_stage_awaiting_subject` (after `create_approval_subject_line`) | amber pulsing |
| 6 | Writing segments | `writing_segments` | `emit_stage_subject_approved` (after `check_subject_line_feedback` true) | blue pulsing |
| 7 | Saved | `saved` | `emit_stage_saved` (after `save_scheduled_newsletter`) | `bg-green-100 text-green-700` ✓ |

`error` is not a stage — it's an overlay on whichever pill was active when `/api/callback/newsletter-stage` posts `{stage: 'error', detail}` or when `GET /api/newsletter/execution/:id/status` reports `status: 'error'`.

### 4.2 Live log pane

Single visual exception to the flat-first rule — inspired by a build log, not an app pane:

- `bg-gray-950 text-gray-100 font-mono text-xs`
- Lines: `[HH:MM:SS]` timestamp gray-500, stage gray-300, detail gray-100.
- Color codes: info gray-100, stage-change brand-300, warn amber-400, error red-400.
- Auto-scroll to bottom unless the user scrolls up; scroll-lock indicator (`↓ New events`) appears at the bottom edge when locked.

### 4.3 Editorial preview within product chrome

The only place editorial styling leaks into the product UI is inside the newsletter preview iframe (§3.7). The iframe loads a scoped `newsletter-preview.css` — paper `#fbf8f2`, Ink Blue `#14288c`, Playfair serif — so the editorial language is preserved without polluting the host page's Tailwind cascade.

### 4.4 Sidebar

Existing sidebar grows one group:

```
Newsletter
  Home
  Generate
  Pending approvals   [• 2]   ← count badge when > 0
  Sends
  Ingestion
```

Badge updates via SSE on `newsletter.approval.created` / `newsletter.approval.resolved` events.

---

## 5. SSE event vocabulary

All events arrive on the existing `/api/session/events` SSE channel from Sprint 5. No new transport.

| Event | Source | Payload shape | Consumer |
|---|---|---|---|
| `newsletter.stage` | n8n `emit_stage_*` nodes → `POST /api/callback/newsletter-stage` | `{userId, executionId, editionId, stage, detail?, ts}` | Execution tracker — advances strip + appends to log |
| `newsletter.approval.created` | `POST /api/approvals/create` | `{userId, executionId, editionId, stage, token, approval_url, payload, expires_at}` | Sidebar badge + approvals inbox + tracker's right pane |
| `newsletter.approval.resolved` | `POST /api/approvals/:token/resolve` (public) + `POST /api/newsletter/approvals/:token/resolve` (in-app) | `{userId, executionId, stage, decision, feedback, resolved_at}` | Execution tracker — advances strip — + sidebar badge decrement |
| `newsletter.saved` | `POST /api/newsletter-sends/save` | `{userId, executionId, editionId, send_id, issue_number, scheduled_send_at}` | Home "next scheduled" tile + toast |

The server pushes each event to the SSE channel for the matching `userId` only — RLS at the transport layer.

---

## 6. Backend contracts

All new routes live under `writers-workbench/server/src/routes/newsletter.ts`. All require `requireAuth` (session cookie) unless marked `X-Callback-Secret`. All bodies validated by Zod schemas in `server/src/schemas.ts`.

### 6.1 New Supabase table: `newsletter_editions_v2`

```sql
CREATE TABLE newsletter_editions_v2 (
  id              TEXT PRIMARY KEY,                -- slug: 'ai-news', 'political-scifi', etc.
  display_name    TEXT NOT NULL,                   -- 'The Workbench' (masthead wordmark)
  subheader       TEXT NOT NULL,                   -- 'Dispatches from the Machine Room'
  genre           TEXT NOT NULL,                   -- 'ai' | 'political-scifi' | ...
  description     TEXT,
  newsletter_name TEXT NOT NULL,                   -- 'A CourseworxAI Weekly' footer line
  primary_color   TEXT NOT NULL DEFAULT '#14288c',
  paper_color     TEXT NOT NULL DEFAULT '#fbf8f2',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  user_id         TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_newsletter_editions_v2_user_id
  ON newsletter_editions_v2 (user_id) WHERE enabled = true;

ALTER TABLE newsletter_editions_v2 ENABLE ROW LEVEL SECURITY;
-- own-row SELECT/INSERT/UPDATE using get_current_user_id() — same pattern as other V2 tables

-- Seed (sprint migration):
INSERT INTO newsletter_editions_v2
  (id, display_name, subheader, genre, newsletter_name, user_id)
VALUES
  ('ai-news', 'The Workbench', 'Dispatches from the Machine Room', 'ai',
   'A CourseworxAI Weekly', '+14105914612');
```

### 6.2 New columns on `newsletter_sends_v2`

```sql
ALTER TABLE newsletter_sends_v2
  ADD COLUMN edition_id   TEXT REFERENCES newsletter_editions_v2(id),
  ADD COLUMN execution_id TEXT,        -- lifted out of metadata.execution_id for indexing
  ADD COLUMN issue_number INTEGER;     -- server-assigned on save

CREATE INDEX idx_newsletter_sends_v2_edition_issue
  ON newsletter_sends_v2 (edition_id, issue_number);

-- Backfill:
UPDATE newsletter_sends_v2 SET edition_id = 'ai-news' WHERE edition_id IS NULL;
```

`issue_number` is assigned by `/api/newsletter-sends/save` as
`SELECT COALESCE(MAX(issue_number), 0) + 1 FROM newsletter_sends_v2 WHERE edition_id = $1`
inside the same transaction as the upsert, with `FOR UPDATE` on a tiny `newsletter_edition_locks` row (or a per-edition Postgres sequence — either works; see Risk register).

### 6.3 Express endpoints

#### New

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/api/newsletter/editions` | session | List enabled editions for the current user. |
| `GET`  | `/api/newsletter/editions/:id/last-sent-markdown` | session | Returns `{markdown: string \| null}` from the most recent `newsletter_sends_v2` row for the edition. |
| `POST` | `/api/newsletter/generate` | session | Validates `{edition_id, send_date, previous_newsletter_content?}`, POSTs JSON to `N8N_NEWSLETTER_WEBHOOK_URL` with `X-Ingestion-Secret`, returns the synchronous `{executionId, started: true}` from the workflow's `Respond to Webhook` node. |
| `GET`  | `/api/newsletter/execution/:id/status` | session | Thin proxy over n8n `GET /api/v1/executions/:id` with `X-N8N-API-KEY`. Strips to `{executionId, status, mode, startedAt, stoppedAt, lastNodeExecuted}`. |
| `GET`  | `/api/newsletter/approvals/open` | session | Open approvals for the session user: `SELECT * FROM newsletter_approvals_v2 WHERE user_id = $session AND resolved_at IS NULL AND expires_at > now() [AND execution_id = $1] [AND stage = $2]`. Includes `payload` + `approval_url`. |
| `POST` | `/api/newsletter/approvals/:token/resolve` | session | Authenticated counterpart to the existing public endpoint. Verifies `user_id` matches session; reuses the extracted `server/src/lib/approvals.ts` core; emits `newsletter.approval.resolved`. |
| `GET`  | `/api/newsletter/sends` | session | Filterable list, joins `newsletter_editions_v2` for `display_name`. |
| `GET`  | `/api/newsletter/sends/:id` | session | Row + `preview_url`. |
| `GET`  | `/api/newsletter/sends/:id/preview.html` | session | SSR preview doc with CSP headers (see §7). |
| `GET`  | `/api/newsletter/ingestion` | session | Search over `content_ingestion_v2`, metadata only. |
| `GET`  | `/api/newsletter/ingestion/:key` | session | Full row (markdown + html) for a single key. |
| `GET`  | `/api/newsletter/ingestion/sources` | session | Distinct `source_name` values with counts — facet endpoint. |
| `POST` | `/api/callback/newsletter-stage` | `X-Callback-Secret` | Called by n8n stage-emitter nodes; broadcasts `newsletter.stage` SSE. |

#### Extended (existing)

| Endpoint | Extension |
|---|---|
| `POST /api/approvals/create` (S9) | After DB insert, broadcast `newsletter.approval.created` to the session's SSE channel. |
| `POST /api/approvals/:token/resolve` (S9) | After DB update + n8n resume-POST, broadcast `newsletter.approval.resolved`. |
| `POST /api/newsletter-sends/save` (S11) | After upsert, assign `issue_number`, broadcast `newsletter.saved`. |

### 6.4 n8n workflow additions

Twelve nodes added to `Content - Newsletter Agent V2` (`bMvMKyK8obwYZmNb`): one new `webhook` trigger, one `respondToWebhook` node, one `set_trigger_inputs` Set node that normalizes both trigger paths, and the nine `emit_stage_*` HTTP Request nodes. Net 87 → 99 nodes.

**Trigger fan-in.** The existing `form_trigger` node is preserved as a secondary ops/debug entry point. A new `webhook_trigger` (n8n-nodes-base.webhook v2, `responseMode: 'responseNode'`, auth = `httpHeaderAuth` cred `DEV Workbench Ingestion Secret` checking `X-Ingestion-Secret`) is the primary path. The webhook's first downstream node is `respond_to_webhook` (n8n-nodes-base.respondToWebhook) returning `{ "executionId": "={{ $execution.id }}", "editionId": "={{ $json.body['Edition Id'] || 'ai-news' }}" }` synchronously to the caller, then execution continues. Both triggers funnel into a single `set_trigger_inputs` Set node that exposes a normalized `{Date, "Previous Newsletter Content", "Edition Id"}` shape on `$json` regardless of which trigger fired. Every downstream reference uses `$('set_trigger_inputs').item.json[...]` — no node references either trigger directly.

**Stage-emit nodes.** Nine HTTP Request nodes, all authenticated via a new DEV httpHeaderAuth credential `DEV Workbench Newsletter Callback Secret` (header `X-Callback-Secret`, matching env `NEWSLETTER_CALLBACK_SECRET` on Railway). All POST to `{WORKBENCH_URL}/api/callback/newsletter-stage` with body:

```json
{
  "userId":       "+14105914612",
  "executionId":  "={{ $execution.id }}",
  "editionId":    "={{ $('set_trigger_inputs').item.json['Edition Id'] || 'ai-news' }}",
  "stage":        "<stage>",
  "detail":       "<optional human-readable string>",
  "ts":           "={{ $now.toISO() }}"
}
```

| Node | Placed after | `stage` |
|---|---|---|
| `emit_stage_gathering` | `set_trigger_inputs` | `gathering` |
| `emit_stage_picking` | `pick_top_stories` | `selecting_stories` |
| `emit_stage_awaiting_stories` | `create_approval_stories` | `awaiting_stories_approval` |
| `emit_stage_stories_approved` | `check_stories_feedback` → true | `stories_approved` (→ UI advances to pill #4) |
| `emit_stage_awaiting_subject` | `create_approval_subject_line` | `awaiting_subject_approval` |
| `emit_stage_subject_approved` | `check_subject_line_feedback` → true | `subject_approved` (→ UI advances to pill #6) |
| `emit_stage_writing_segment` | per-iteration inside `iterate_stories` | `writing_segment` (with `detail: "segment N/M"`) |
| `emit_stage_segments_done` | `set_combined_sections_content` | `segments_done` |
| `emit_stage_saved` | `save_scheduled_newsletter` | `saved` |

`emit_stage_writing_segment` is the one that emits repeatedly — it fires once per iteration of `iterate_stories` (see workflow doc §1.6). The UI treats the most recent `writing_segment` event as the ticker inside pill #6 ("Writing segments · 3/7").

### 6.5 Trigger updates

Both trigger nodes carry the new `Edition Id` field:

- **`webhook_trigger`** — accepts a JSON body with `Date`, `Previous Newsletter Content`, `Edition Id`. Header `X-Ingestion-Secret` required (re-uses existing `DEV Workbench Ingestion Secret` cred).
- **`form_trigger`** (preserved) — gains an optional `Edition Id` field (type `text`, default `ai-news`).

`set_trigger_inputs` (Set node, `runOnceForEachItem`, `includeOtherFields: false`) normalizes both into a uniform `{Date, "Previous Newsletter Content", "Edition Id"}` so `create_approval_stories` (for `newsletter_approvals_v2.edition_id`) and `save_scheduled_newsletter` (for `newsletter_sends_v2.edition_id`) can both read `$('set_trigger_inputs').item.json['Edition Id']` without caring which trigger fired.

### 6.6 New column on `newsletter_approvals_v2`

```sql
ALTER TABLE newsletter_approvals_v2
  ADD COLUMN edition_id TEXT REFERENCES newsletter_editions_v2(id);
-- Backfill:
UPDATE newsletter_approvals_v2 SET edition_id = 'ai-news' WHERE edition_id IS NULL;
```

Enables per-edition filtering in the pending-approvals inbox and correct masthead rendering in the in-app approval detail page.

---

## 7. Preview iframe + CSP

`GET /api/newsletter/sends/:id/preview.html` returns a standalone HTML document containing:

- `<!DOCTYPE html>` + a `<head>` with a scoped `newsletter-preview.css` (inlined, not external).
- `<body>` rendering the `html_body` column. If `html_body` is empty or `<pre>`-wrapped (the S11 fallback), the server compiles `markdown_body` through the server-side Handlebars template at `writers-workbench/server/src/lib/newsletter-template.hbs` (shared with Postal, guaranteeing preview = subscriber output).
- Response headers:
  ```
  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data:;
  X-Frame-Options: SAMEORIGIN
  ```
- Loaded from the app via `<iframe sandbox="allow-same-origin" src="/api/newsletter/sends/:id/preview.html">`. Editorial CSS cannot leak into the app's Tailwind cascade; the app's cookies stay inaccessible to anything the preview tries to run.

Mobile toggle: wraps the iframe in a `width: 375px` flex container; the iframe's own content is responsive via the template's `@media` rules.

---

## 8. Component tree (client)

```
pages/newsletter/
  NewsletterHome.tsx          — dashboard + recent runs table
  NewsletterGenerate.tsx      — edition + date + prev content form
  ExecutionStatus.tsx         — live tracker (SSE-driven)
  PendingApprovals.tsx        — inbox
  ApprovalDetail.tsx          — standalone resolve form
  ScheduledSends.tsx          — history table
  NewsletterDetail.tsx        — preview iframe + metadata + markdown drawer
  IngestionBrowser.tsx        — content_ingestion_v2 search

components/newsletter/
  StageStrip.tsx              — 7-pill progress indicator
  LiveLog.tsx                 — terminal-style SSE log pane
  NewsletterPreviewFrame.tsx  — sandboxed iframe + desktop/mobile toggle
  EditionBadge.tsx            — colored pill (border = edition.primary_color)
  ApprovalPayloadStories.tsx  — renders stories-stage payload
  ApprovalPayloadSubject.tsx  — renders subject-stage payload
  ApprovalResolveForm.tsx     — shared radio + feedback + submit
  StatusPill.tsx              — reuses existing StatusPill
  IngestionTypeIcon.tsx       — article / reddit / tweet / newsletter SVG

lib/newsletter/
  schema.ts                   — TS types mirroring DB rows
  sse.ts                      — useNewsletterEvents(executionId?) hook
  formatStage.ts              — stage enum → label, color, icon
  useExecutionState.ts        — merges initial fetch + SSE into the tracker's view model
```

All pages reuse existing Sprint 2/6 primitives (`PageHeader`, `Pagination`, `TableSkeleton`, `EmptyState`, `Breadcrumb`).

---

## 9. Example run, end to end

> Eric opens The Workbench at 8:45 on Thursday. Wants the AI-news edition out by 10:00.

1. `/newsletter` — Home: no in-flight runs, 0 pending approvals, last send 7 days ago. Clicks **Generate newsletter**.
2. `/newsletter/generate` — Edition: _The Workbench — AI news_ (default). Date: today. Previous content prefilled from last week's markdown. Clicks **Start run**.
3. App navigates to `/newsletter/execution/e_2486`. Stage strip: `Gathering…` pulsing. Log pane: `[08:45:12] gathering: started ingestion search prefix=2026-04-24/`. After ~90s, strip advances to `Selecting stories`, then `Stories approval`.
4. Awaiting-your-action panel renders 7 stories + per-story sources. Eric flags one as low quality:
   > _Revise — drop the Nvidia fluff piece, it's a rehash of last week's IBM story._

   Submits. Strip returns to `Selecting stories` (edit loop), ~20s later back to `Stories approval` with a revised set. Approves. Strip advances to `Subject line`.
5. Subject proposal: `"👀 OpenAI drops a privacy-focused model"` + three alternates + reasoning. Approves.
6. Strip advances to `Writing segments`. Pill ticker: `3/7 · 4/7 · 5/7 · …`. ~4 minutes.
7. Strip reaches `Saved`. Green toast: _"The Workbench #43 scheduled for release Fri 2026-04-25 10:00."_ Link → `/newsletter/sends/wb_43`.
8. `/newsletter/sends/wb_43` — Left: editorial preview iframe (Playfair masthead, Ink Blue). Right: metadata panel. Bottom: markdown drawer. Eric forwards the link to a copy-editor for a final read.
9. At the scheduled time, the future calendar cron (deferred) flips `status='scheduled'` → `sending`, Postal fans out, status reaches `sent`. Home page updates in real time via SSE.

Total runtime: 8 minutes including two approvals. Zero Gmail context switches.

---

## 10. Phasing

The workflow doc (§3.6) proposes splitting the integration into three phases. This spec adopts that split and names the sprint that delivers each:

| Phase | Scope | Sprint |
|---|---|---|
| **2a** (next) | Editions table + Generate + ExecutionStatus + PendingApprovals + ApprovalDetail + SSE stage wiring. Replaces the email click-through as primary path. | [`compose-newsletter-sprint.md`](./compose-newsletter-sprint.md) |
| **2b** | ScheduledSends + NewsletterDetail + IngestionBrowser + preview.html SSR + issue-number assignment. Depends on the calendar-cron sprint for `sent` status transitions. | TBD |
| **2c** | Stage-event persistence (`newsletter_stage_events_v2`), refresh-durable tracker, end-to-end Playwright coverage, feature-flag removal. Self-contained polish. | TBD |

Each phase uses existing Workbench auth, RLS, and test harnesses. No new Supabase tables are needed beyond migration 009 (already shipped) + migration 012 (`newsletter_editions_v2` + send columns, in Phase 2a) + migration 013 (`newsletter_stage_events_v2`, Phase 2c).

---

## 11. Non-goals

Explicitly out of scope for the entire 2a/2b/2c arc:

- **WYSIWYG editing of the final HTML.** Editorial output is canonical. Human edits happen via the two Revise paths.
- **Subscriber management** (add/remove/segment/unsubscribe). Its own sprint, already planned.
- **Actual send fan-out.** This arc only parks rows in `scheduled`. The calendar cron that releases them is its own sprint.
- **Multi-tenant orgs.** User-scoped for now; RLS on `user_id`.
- **Open/click/bounce analytics.** Postal captures them; UI surfaces them in a later sprint.
- **Writing-project ↔ edition linkage.** `newsletter_editions_v2.id` is a free slug today; whether it should FK into `writing_projects_v2` is deferred (see §12 Q1).

---

## 12. Open questions

1. **Edition ↔ writing-project linkage.** Should `newsletter_editions_v2.id` FK into `writing_projects_v2.id` so editions inherit a project's genre, audience settings, and brand colors? Lean: yes, long-term; deferred to post-2c so this arc doesn't grow.
2. **Ingestion browser source labels.** Raw Reddit subreddit names vs. human labels? Lean: add `source_display_name` to `newsletter_editions_v2` so editions map `reddit-ArtificialInteligence` → "Artificial Intelligence (Reddit)" at their own discretion.
3. **Stage-event retention.** Keep `newsletter_stage_events_v2` forever (rows are tiny) or TTL after 90 days? Lean: forever for now; revisit if volume surprises us.
4. **Public `/approvals/:token` parity.** The public SSR page stays for external email recipients. Do we keep it in sync with the in-app `ApprovalPayload*` components (i.e., share the renderers via SSR-compatible React) or let it drift as a minimal fallback? Lean: keep the public page minimal; it's the backup, not the product.
5. **`Edition Id` form field default.** The n8n form-trigger currently has no `Edition Id` field. When the UI submits without one (e.g. during backfill or a manual n8n form run), fall back to `'ai-news'` inside the emit nodes. Document in the workflow doc's Appendix A.

---

## Appendix A — Preview rendering data shape

The Handlebars template at `writers-workbench/server/src/lib/newsletter-template.hbs` receives:

```ts
type NewsletterData = {
  edition: {
    displayName: string;         // 'The Workbench'
    subheader: string;           // 'Dispatches from the Machine Room'
    newsletterName: string;      // 'A CourseworxAI Weekly'
    primaryColor: string;        // '#14288c'
    paperColor: string;          // '#fbf8f2'
  };
  issue: {
    number: number;
    sendDate: string;            // ISO date
    viewInBrowserUrl: string;
  };
  subject: string;
  preheader: string;
  intro: string;
  leadStory: {
    kicker: string;
    title: string;
    body: string[];
    cta?: { label: string; url: string };
    sourceUrls: string[];
  };
  sections: Array<{
    kicker: string;
    title: string;
    body: string[];
    sourceUrls: string[];
    image?: { src: string; alt: string };
  }>;
  shortlist: Array<{
    title: string;
    source: string;
    url: string;
    readTime?: string;
  }>;
  sponsor?: {
    name: string;
    headline: string;
    body: string;
    cta: string;
    ctaUrl: string;
  };
  pullQuote?: { quote: string; attribution: string };
  signoff: { body: string; name: string };
  footer: { address: string; reasonForReceiving: string };
};
```

This shape is the contract between `save_scheduled_newsletter` (which must produce it) and the preview + Postal renderers (which both consume it). Today `save_scheduled_newsletter` persists `subject`, `preheader`, `markdown_body`, `html_body`; Phase 2b extends it to persist the full structured object in `newsletter_sends_v2.metadata.newsletter_data` for loss-free preview + re-render.

---

## Appendix B — Trust boundaries

| Actor | May call | May not call |
|---|---|---|
| Browser (session-auth'd user) | Every `/api/newsletter/*` route; public `/approvals/:token` | `/api/callback/*`; raw n8n API |
| n8n workflow | `/api/ingestion/*` (with `X-Ingestion-Secret`), `/api/approvals/*` (with `X-Approval-Secret`), `/api/email/*` (with `X-Email-Secret`), `/api/newsletter-sends/save` (with `X-Ingestion-Secret`), `/api/callback/newsletter-stage` (with `X-Callback-Secret`) | Nothing else on the Workbench server |
| Postal | Nothing on the Workbench server (outbound-only) | — |
| External email recipient clicking a Postal button | Public `/approvals/:token` + `/approvals/:token/resolve` only | Anything else |

The n8n API key lives only on the Workbench server (`N8N_API_KEY` env). The browser never sees it.

---

**See also:**
- [`compose-newsletter-sprint.md`](./compose-newsletter-sprint.md) — the Phase 2a sprint.
- [`newsletter-agent-workflow.md`](./newsletter-agent-workflow.md) — canonical workflow reference.
- `samples/compose-newsletter-sample.html` — visual mock of the ExecutionStatus page.
- `samples/the-workbench-newsletter-sample.html` — rendered editorial output.
