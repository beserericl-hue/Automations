# Compose Newsletter — Phase 2a Sprint

**Sprint name:** `sprint-compose-newsletter-2a`
**Sprint window:** 2 weeks
**Design doc:** [`compose-newsletter-design.md`](./compose-newsletter-design.md)
**Depends on:** `sprint-newsletter-migration.md` (S1–S11 merged to `develop`) — see [`newsletter-migration-workflow-ids.md`](./newsletter-migration-workflow-ids.md)
**Goal:** Replace the Postal-email human-loop with an in-app tracker so a curator can trigger, watch, and approve a newsletter run without leaving the Writer's Workbench. The public `/approvals/:token` SSR page stays as-is for external recipients.

**Scope boundaries.** This sprint delivers the **Phase 2a** slice from the design doc §10:

- ✅ Editions table + send columns (migration 012).
- ✅ Generate page + server proxy to the n8n form webhook.
- ✅ Execution tracker with stage strip, live log, inline approval resolution.
- ✅ Pending-approvals inbox + standalone approval detail.
- ✅ SSE stage events from the n8n workflow.

Deferred to **Phase 2b**: ScheduledSends, NewsletterDetail, preview iframe, IngestionBrowser, issue-number assignment.
Deferred to **Phase 2c**: Stage-event persistence, Playwright E2E, feature-flag removal.

All listed here so reviewers know what's _not_ shipping this window.

---

## Status

| Story | Title | Pts | Priority | Status |
|---|---|---|---|---|
| **S1** | Supabase migration 012 | 2 | P0 | planned |
| **S2** | Server — `/api/newsletter/editions` + `/generate` + `/execution/:id/status` | 3 | P0 | planned |
| **S3** | n8n — form-trigger `Edition Id` field + 9 stage-emit nodes + callback endpoint | 2 | P0 | planned |
| **S4** | Client — sidebar entry + 5 route stubs + `useNewsletterEvents` hook | 2 | P0 | planned |
| **S5** | Server — in-app approvals endpoints | 2 | P0 | planned |
| **S6** | Pages — `NewsletterHome` + `NewsletterGenerate` | 5 | P0 | planned |
| **S7** | Pages — `ExecutionStatus` (stage strip + live log + inline resolve) 🔑 | 8 | P0 | planned |
| **S8** | Pages — `PendingApprovals` + `ApprovalDetail` | 3 | P1 | planned |
| **S9** | Smoke — server + client vitest + fixture `simulate-run` endpoint | 3 | P0 | planned |
| **S10** | Docs — update handoff README + workflow doc §3 phase markers | 1 | P0 | planned |

**Total:** 10 stories, **31 points**.

No sprint is a commitment to _all_ P1 work landing; S8 may slip into a cleanup week.

---

## Environment + credential prerequisites

One new DEV credential, one new env variable on the Workbench server, one new env variable on n8n workflows.

| Scope | Name | Type / value | Notes |
|---|---|---|---|
| Workbench (Railway DEV) | `NEWSLETTER_CALLBACK_SECRET` | 32-byte hex | Consumed by `POST /api/callback/newsletter-stage`. Set via `railway variable set`. |
| Workbench (Railway DEV) | `N8N_UI_URL` | `https://n8n.agileadautomation.com` | Used to build `Open in n8n →` deep links on the ExecutionStatus page. |
| Workbench (Railway DEV) | `N8N_NEWSLETTER_FORM_URL` | full n8n form webhook URL | Target of `POST /api/newsletter/generate`. Pulled from `Content - Newsletter Agent V2` form-trigger URL on first activation after the `Edition Id` field is added (S3). |
| Workbench (already present) | `N8N_URL` / `N8N_API_KEY` | existing | Powers `GET /api/newsletter/execution/:id/status`. |
| n8n DEV | `DEV Workbench Newsletter Callback Secret` httpHeaderAuth | header `X-Callback-Secret`, value = same 32-byte hex | Attached to all 9 emit nodes (S3). Cred ID captured below after creation. |

### Credential registry (DEV tier)

Keep the same `| name | id | header |` format as the Newsletter Migration workflow-ids doc so the two registries dovetail.

| Credential name | ID | Header |
|---|---|---|
| `DEV Workbench Newsletter Callback Secret` | _(TBD — capture after `POST /api/v1/credentials` in S3)_ | `X-Callback-Secret` |

PROD credential doesn't exist yet — created at release promotion using the PROD secret value. `scripts/clone-prod-to-dev.py` already does credential-ID substitution during promotion; add `NEWSLETTER_CALLBACK_SECRET` to its substitution table before the first 2a promotion.

---

## Stories

Each story follows the same layout as the Newsletter Migration doc: a short prose block, explicit DB + endpoint + n8n deltas, then a verification table that must pass before merging.

### S1 — Supabase migration 012

Adds the `newsletter_editions_v2` table and the three new columns on `newsletter_sends_v2` (+ one new column on `newsletter_approvals_v2`). Seeds the `ai-news` edition row. Backfills existing sends + approvals.

**Migration file:** `writers-workbench/migrations/012_newsletter_editions.sql`

```sql
CREATE TABLE newsletter_editions_v2 (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  subheader       TEXT NOT NULL,
  genre           TEXT NOT NULL,
  description     TEXT,
  newsletter_name TEXT NOT NULL,
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
-- (policies: own-row SELECT/INSERT/UPDATE using get_current_user_id(), same pattern as every other V2 table)

ALTER TABLE newsletter_sends_v2
  ADD COLUMN edition_id   TEXT REFERENCES newsletter_editions_v2(id),
  ADD COLUMN execution_id TEXT,
  ADD COLUMN issue_number INTEGER;
CREATE INDEX idx_newsletter_sends_v2_edition_issue
  ON newsletter_sends_v2 (edition_id, issue_number);

ALTER TABLE newsletter_approvals_v2
  ADD COLUMN edition_id TEXT REFERENCES newsletter_editions_v2(id);

INSERT INTO newsletter_editions_v2
  (id, display_name, subheader, genre, newsletter_name, user_id)
VALUES
  ('ai-news', 'The Workbench',
   'Dispatches from the Machine Room', 'ai',
   'A CourseworxAI Weekly', '+14105914612');

-- Backfill
UPDATE newsletter_sends_v2     SET edition_id = 'ai-news' WHERE edition_id IS NULL;
UPDATE newsletter_approvals_v2 SET edition_id = 'ai-news' WHERE edition_id IS NULL;
```

**TypeScript:** add `NewsletterEdition` to `client/src/types/database.ts`; extend `NewsletterSend` with `edition_id`, `execution_id`, `issue_number`; extend `NewsletterApproval` with `edition_id`.

**Verification:**

| Check | Pass criterion |
|---|---|
| Table exists | `SELECT to_regclass('public.newsletter_editions_v2')` non-null |
| Seed row | `SELECT subheader FROM newsletter_editions_v2 WHERE id='ai-news'` = `'Dispatches from the Machine Room'` |
| Send backfill | `SELECT count(*) FROM newsletter_sends_v2 WHERE edition_id IS NULL` = 0 |
| Approval backfill | `SELECT count(*) FROM newsletter_approvals_v2 WHERE edition_id IS NULL` = 0 |
| RLS | anon-key SELECT on editions returns empty; service-role returns 1 row |
| Types | `npx tsc -p client/tsconfig.json --noEmit` clean |

**Depends on:** nothing.

---

### S2 — Server endpoints: editions + generate + execution status

Three endpoints in a new router at `writers-workbench/server/src/routes/newsletter.ts`. All behind `requireAuth` + `generalLimiter`.

**Endpoints:**

| Method | Path | Body / query | Response |
|---|---|---|---|
| `GET`  | `/api/newsletter/editions` | — | `{editions: NewsletterEdition[]}` |
| `GET`  | `/api/newsletter/editions/:id/last-sent-markdown` | — | `{markdown: string \| null}` |
| `POST` | `/api/newsletter/generate` | `{edition_id, send_date, previous_newsletter_content?}` (Zod `GenerateSchema`) | `{executionId?: string, started: true}` |
| `GET`  | `/api/newsletter/execution/:id/status` | — | `{executionId, status, mode, startedAt, stoppedAt, lastNodeExecuted}` |

**`/generate` implementation notes:**

- Validates body.
- Looks up `newsletter_editions_v2` row for the id; 404 if disabled or missing.
- POSTs `multipart/form-data` to `N8N_NEWSLETTER_FORM_URL` with fields `Date`, `Previous Newsletter Content`, `Edition Id`.
- n8n form webhooks don't return the `executionId` synchronously — the handler returns `{started: true}` immediately; the first `newsletter.stage` SSE event (from `emit_stage_gathering`) is what lets the client navigate to the tracker with a real id.
- Return shape therefore also includes a short-lived `correlationId` (server-generated UUID) that the server attaches to the form POST as a hidden field `Correlation Id`. `emit_stage_gathering` echoes it in the first SSE event so the client can stitch its optimistic redirect (`/newsletter/execution/<correlationId>`) onto the real executionId.

**Schemas:** add `GenerateSchema` and `NewsletterEditionSchema` to `server/src/schemas.ts`.

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — `GET /editions` returns seeded row | vitest green |
| Unit — `POST /generate` with valid body calls mock n8n webhook with correct form fields | vitest green |
| Unit — missing `send_date` → 400 | vitest green |
| Unit — unknown `edition_id` → 404 | vitest green |
| Unit — `/execution/:id/status` proxies mock n8n response, strips unwanted fields | vitest green |
| System — DEV curl `POST /api/newsletter/generate` → real n8n execution appears in the n8n UI within 3s | manual |
| System — `/execution/:id/status` after 30s returns `status: "running"` or `"success"` | manual |
| OpenAPI | annotations added; `npm run openapi:validate` clean |

**Depends on:** S1.

---

### S3 — n8n: form-trigger `Edition Id` field + 9 stage-emit nodes + callback endpoint

Wires the workflow to emit stage events into the Workbench's SSE channel. **Zero edits to existing nodes' expressions**, except the 3 nodes that read `editionId` from the form trigger.

**Workbench side:**

- New route `POST /api/callback/newsletter-stage` in `server/src/routes/newsletter.ts` (continues the S2 router).
  - Auth: `X-Callback-Secret` header equals `NEWSLETTER_CALLBACK_SECRET` env.
  - Body (Zod `StageCallbackSchema`): `{userId, executionId, editionId, stage, detail?, ts, correlationId?}`.
  - Side effect: push `{event: 'newsletter.stage', data: {...body}}` to the SSE channel for `userId`.
- Extend existing `POST /api/approvals/create` — after the DB insert (already live from S9 of the prior sprint), also broadcast `newsletter.approval.created` to the session's SSE channel.
- Extend existing `POST /api/approvals/:token/resolve` — after the DB update + n8n resume POST, also broadcast `newsletter.approval.resolved`.

**n8n side (all changes to `Content - Newsletter Agent V2`, workflow id `bMvMKyK8obwYZmNb`):**

1. **Credential:** create `DEV Workbench Newsletter Callback Secret` (httpHeaderAuth, header `X-Callback-Secret`, value = the Railway env). Capture the cred id in the registry table above.
2. **Form trigger:** add field `Edition Id` (type `text`, default `ai-news`, not required).
3. **Add 9 HTTP Request v4.2 nodes.** All identical except for placement and the `stage` literal. Template body JSON:

   ```json
   {
     "userId":      "={{ $execution.runData.ExecutionMetadata?.userId || '+14105914612' }}",
     "executionId": "={{ $execution.id }}",
     "editionId":   "={{ $('form_trigger').item.json['Edition Id'] || 'ai-news' }}",
     "stage":       "<STAGE>",
     "detail":      "<OPTIONAL EXPRESSION>",
     "ts":          "={{ $now.toISO() }}",
     "correlationId": "={{ $('form_trigger').item.json['Correlation Id'] || null }}"
   }
   ```

   | Node name | Placed after | `stage` | `detail` expression |
   |---|---|---|---|
   | `emit_stage_gathering` | `form_trigger` | `gathering` | `'started ingestion search'` |
   | `emit_stage_picking` | `pick_top_stories` | `selecting_stories` | `'picked ' + $json.output.top_selected_stories.length + ' stories'` |
   | `emit_stage_awaiting_stories` | `create_approval_stories` | `awaiting_stories_approval` | `'approval token ' + $json.token` |
   | `emit_stage_stories_approved` | `check_stories_feedback` → true | `stories_approved` | `'writing subject line'` |
   | `emit_stage_awaiting_subject` | `create_approval_subject_line` | `awaiting_subject_approval` | `'approval token ' + $json.token` |
   | `emit_stage_subject_approved` | `check_subject_line_feedback` → true | `subject_approved` | `'writing segments'` |
   | `emit_stage_writing_segment` | per-iteration inside `iterate_stories` (after `set_story_segment`) | `writing_segment` | `'segment ' + $runIndex + '/' + $('split_stories').all().length` |
   | `emit_stage_segments_done` | `set_combined_sections_content` | `segments_done` | `'assembling final'` |
   | `emit_stage_saved` | `save_scheduled_newsletter` | `saved` | `'issue #' + $json.issue_number + ' scheduled ' + $json.scheduled_send_at` |

   Every emit node uses `onError: continueRegularOutput` — a failed callback must never stop the workflow (the main path is the product of record; SSE is a nice-to-have).

4. **Edges:** each emit node is inserted in-line — upstream's existing `main[0]` is rewired to the emit node, and the emit node's `main[0]` goes to what used to be downstream. Net: 9 new nodes, 9 new edges, 9 removed edges. Node count 87 → 96.

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — callback without secret → 401 | vitest green |
| Unit — valid POST pushes event to SSE channel (mock broadcaster asserts `{event: 'newsletter.stage', data: {...}}`) | vitest green |
| Unit — payload validation: missing `stage` → 400 | vitest green |
| n8n — V2 re-activation succeeds after 9 emit nodes added (validates every expression compiles) | `activeVersionId` updates with `active: true` on the activate response |
| System — DEV full run → tail `/api/session/events` as the authenticated user → observe 9 `newsletter.stage` events in expected order | manual |
| System — observe `newsletter.approval.created` ×2 + `newsletter.approval.resolved` ×2 on the same channel | manual |

**Depends on:** S2.

---

### S4 — Client: sidebar entry + 5 route stubs + `useNewsletterEvents` hook

Puts every route in place so later stories can fill them without touching routing. Hook centralizes SSE consumption.

**Sidebar:** append a `Newsletter` group with five entries: `Home`, `Generate`, `Pending approvals` (with count badge slot), `Sends`, `Ingestion`.

**Routes:** add eight entries to `client/src/App.tsx` matching design doc §3. Stub each with `<PageHeader>` + `<EmptyState message="Stub — see compose-newsletter-sprint.md" />`. Stories S6–S8 replace the stubs.

**Files:**

```
client/src/pages/newsletter/NewsletterHome.tsx            (stub)
client/src/pages/newsletter/NewsletterGenerate.tsx         (stub)
client/src/pages/newsletter/ExecutionStatus.tsx            (stub)
client/src/pages/newsletter/PendingApprovals.tsx           (stub)
client/src/pages/newsletter/ApprovalDetail.tsx             (stub)
client/src/pages/newsletter/ScheduledSends.tsx             (stub, stays stubbed — Phase 2b)
client/src/pages/newsletter/NewsletterDetail.tsx           (stub, stays stubbed — Phase 2b)
client/src/pages/newsletter/IngestionBrowser.tsx           (stub, stays stubbed — Phase 2b)
client/src/components/newsletter/                          (empty; filled in S6/S7/S8)
client/src/lib/newsletter/schema.ts                        (TS types mirroring DB rows)
client/src/lib/newsletter/sse.ts                           (useNewsletterEvents hook)
client/src/lib/newsletter/formatStage.ts                   (stage enum → label/color/icon)
```

**`useNewsletterEvents(executionId?: string)`:**

- Subscribes to the existing `/api/session/events` SSE channel (already wired in Sprint 5).
- Filters events to the `newsletter.*` prefix.
- If `executionId` is passed, filters further to events where `data.executionId === executionId || data.correlationId === executionId`.
- Returns `{events: StageEvent[], latestStage: Stage | null, pendingApprovals: ApprovalRow[], pendingApprovalCount: number}`.
- Badge in sidebar binds to `pendingApprovalCount`.

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — hook filters 10 mixed events to only the 4 `newsletter.*` ones | vitest green |
| Unit — badge increments on `newsletter.approval.created`, decrements on `newsletter.approval.resolved` | vitest green |
| System — every new route returns 200 and renders the stub | manual |
| System — sidebar badge updates in real time when a DEV run reaches an approval gate | manual |

**Depends on:** S3.

---

### S5 — Server: in-app approvals endpoints

Session-authenticated counterparts to the public `/approvals/:token` endpoints from Sprint Newsletter Migration S9. Both endpoints go in the S2 router.

**Endpoints:**

| Method | Path | Body / query | Response |
|---|---|---|---|
| `GET`  | `/api/newsletter/approvals/open` | query: `execution_id?`, `stage?` | `{approvals: ApprovalRow[]}` — rows where `user_id = session AND resolved_at IS NULL AND expires_at > now()`. Each row includes `payload` and `approval_url`. |
| `POST` | `/api/newsletter/approvals/:token/resolve` | `{decision: 'approve' \| 'revise', feedback?: string}` | `{ok: true}` on success. Same status codes as the public endpoint: 403 (token ↛ session user), 409 (already resolved), 410 (expired), 502 (n8n resume failed — decision already persisted). |

**Implementation:** extract the resolve core from `server/src/routes/approvals.ts` into `server/src/lib/approvals.ts` (pure function: `resolveApproval({token, decision, feedback, sessionUserId?}) => Result`). Both the public endpoint and the new authenticated one call it. Guarantees identical behavior — including the `WHERE resolved_at IS NULL` guard that prevents double-resolve if both surfaces race.

After successful resolve, broadcast `newsletter.approval.resolved` (already wired in S3).

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — session user A resolving user B's approval → 403 | vitest green |
| Unit — resolving an already-resolved approval → 409 | vitest green |
| Unit — expired approval → 410 | vitest green |
| Unit — `GET /approvals/open` RLS-filters to session user | vitest green |
| Unit — `POST /approvals/:token/resolve` n8n-resume failure → 502 (decision persisted, SSE still broadcast) | vitest green |
| System — resolve an in-app stories approval → n8n Wait node resumes within 5s → `newsletter.approval.resolved` SSE event observed | manual |
| Full server suite | `npm test -w server` green |

**Depends on:** S1.

---

### S6 — `NewsletterHome` + `NewsletterGenerate` pages

Two entry-point pages.

**`NewsletterHome.tsx`:**

- PageHeader: `Newsletter`, subtitle `Compose and schedule editions`, primary action button `Generate newsletter →`.
- Three tiles (reuse existing `Card` primitive):
  1. **In-flight** — appears only if any `newsletter.stage` event in the last 30 minutes has `stage !== 'saved'`. Shows edition badge + stage pill + elapsed + `Resume →`.
  2. **Pending approvals** — reads from `GET /api/newsletter/approvals/open`. Count + up to 3 rows with `Review →`.
  3. **Next scheduled send** — reads `GET /api/newsletter/sends?status=scheduled&limit=1` (sprint S9 isn't shipping the full sends list, but this single-row query is thin enough to ship here).
- Below: `RecentRunsTable` — 10 rows from `GET /api/newsletter/sends?limit=10`. Row click → `/newsletter/sends/:id` if `status` ≠ `null`, else `/newsletter/execution/:executionId`.

**`NewsletterGenerate.tsx`:**

- Three fields: **Edition** (select, from `GET /api/newsletter/editions`, default `ai-news`), **Date** (defaults today), **Previous newsletter content** (textarea, prefilled from `GET /api/newsletter/editions/:id/last-sent-markdown`).
- Submit → `POST /api/newsletter/generate` → receives `{started: true, correlationId}` → navigates to `/newsletter/execution/<correlationId>`.
- Loading, inline field-error, disabled-while-in-flight states.

**Components added:**

```
client/src/components/newsletter/EditionBadge.tsx   — colored pill; border = edition.primary_color
client/src/components/newsletter/StatusPill.tsx     — thin wrapper over existing StatusPill
```

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — Home with no events, no approvals, no scheduled shows empty tiles | vitest green |
| Unit — Home with one in-flight event within 30min shows the in-flight tile | vitest green |
| Unit — Generate disables submit while request in-flight | vitest green |
| Unit — Generate surfaces a 400 validation error inline | vitest green |
| System — trigger a run from the Generate page → arrive on execution tracker within 2s | manual |
| System — previous-content textarea prefills with last sent markdown for `ai-news` | manual |

**Depends on:** S2, S4.

---

### S7 — `ExecutionStatus` page (stage strip + live log + inline resolve) 🔑

The flagship page. Biggest story in the sprint.

**Components added:**

```
client/src/components/newsletter/StageStrip.tsx             — 7-pill horizontal strip
client/src/components/newsletter/LiveLog.tsx                — terminal-style SSE feed
client/src/components/newsletter/ApprovalPayloadStories.tsx — renders stories-stage payload
client/src/components/newsletter/ApprovalPayloadSubject.tsx — renders subject-stage payload
client/src/components/newsletter/ApprovalResolveForm.tsx    — shared radio + feedback + submit
```

**`StageStrip.tsx` props:** `stages: Stage[]`, `currentStage: Stage`, `timestamps: Record<Stage, Date>`, `error?: {stage: Stage, detail: string}`. States per §4.1 in the design doc.

**`LiveLog.tsx` props:** `events: StageEvent[]`. Auto-scroll-to-bottom unless user scrolled up; "↓ New events" scroll-lock indicator at the bottom edge when locked.

**`ApprovalPayloadStories.tsx`:** reads `payload.top_selected_stories: [{title, summary, identifiers, external_source_urls}]`. Renders 5–8 story cards — each shows kicker (source domain), title, summary, 2–3 source domain chips, `view source ↗` opening a drawer with the full markdown of each identifier (via `GET /api/newsletter/ingestion/:key` — endpoint exists from S10 _in Phase 2b_; for Phase 2a the drawer shows the bare URL list with a "ingestion browser not yet available" note).

**`ApprovalPayloadSubject.tsx`:** renders `payload.subject_line`, `payload.pre_header_text`. `<details>` for `additional_subject_lines` + `subject_line_reasoning` + `pre_header_text_reasoning`, collapsed by default.

**`ExecutionStatus.tsx` layout:**

- PageHeader: `{edition.display_name} · {send_date}` + right-aligned `Open in n8n →` dev-mode link.
- `<StageStrip>` full-width.
- Two-column `lg:grid-cols-[1fr_480px]` body:
  - Left: `<LiveLog>`.
  - Right: awaiting-approval panel — renders `<ApprovalPayloadStories>` or `<ApprovalPayloadSubject>` + `<ApprovalResolveForm>`. Submit → `POST /api/newsletter/approvals/:token/resolve` → optimistically advance the strip.
- Below: collapsible `<details>` `Raw events`.

**Mount-time fetch (refresh durability):**

1. `GET /api/newsletter/execution/:id/status` — reconstruct strip from `lastNodeExecuted` if no SSE events have arrived yet.
2. `GET /api/newsletter/approvals/open?execution_id=:id` — surface any pending approval the user refreshed into.

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — `StageStrip` renders 7 pills, current pill has `aria-current="step"` | vitest green |
| Unit — `LiveLog` auto-scrolls when at bottom; does not when scrolled up | vitest green |
| Unit — `ApprovalPayloadStories` with 0 stories → empty state; with 7 → 7 cards | vitest green |
| Unit — `ApprovalPayloadSubject` reasoning collapsed by default; expands on click | vitest green |
| Unit — Approve submit fires POST with `decision: 'approve'`, empty feedback ok | vitest green |
| Unit — Revise with empty feedback blocks submit with inline validation | vitest green |
| System — DEV full run: trigger → watch 7 strip advances in real time with no refresh | manual |
| System — resolve both approvals inline; n8n resumes; next stage fires within 5s of each resolve | manual |
| System — kill an n8n execution mid-run; strip shows error overlay at current pill + detail visible | manual |

**Depends on:** S2, S3, S4, S5.

---

### S8 — `PendingApprovals` + `ApprovalDetail` pages (P1)

Replaces the "open email, click link" loop for logged-in users.

**`PendingApprovals.tsx`:**

- Table over `GET /api/newsletter/approvals/open`.
- Columns: stage pill, edition badge, `created_at` (absolute), `expires_at` (relative — "in 36h"), excerpt (first 140 chars of `payload.top_selected_stories[0].title` or `payload.subject_line`), `Review →`.
- Empty state: _"No pending approvals. You're caught up."_
- Sidebar badge count double-checked via initial fetch on page load.

**`ApprovalDetail.tsx`:**

- Fetches the single approval: `GET /api/newsletter/approvals/open?token=:token` (extend the endpoint to accept a `token` query param filter).
- Renders the same `<ApprovalPayloadStories>` / `<ApprovalPayloadSubject>` + `<ApprovalResolveForm>` as the tracker's right pane.
- On submit → navigates back to `/newsletter/approvals` (or browser-back if came from the inbox).

**Verification:**

| Check | Pass criterion |
|---|---|
| Unit — Empty state renders when inbox returns `{approvals: []}` | vitest green |
| Unit — Expired rows (if any leak through) are filtered client-side | vitest green |
| System — DEV run reaches stories approval → inbox shows 1 row → click Review → Approve → inbox empty + tracker advances | manual |
| System — same for subject-line approval | manual |

**Depends on:** S5, S7.

---

### S9 — Smoke coverage

Two vitest suites + one in-project fixture endpoint, so S10 can mark the sprint complete without a 20-minute live n8n run per CI.

**New fixture endpoint (test-only):** `POST /api/test/newsletter/simulate-run` — only mounted when `NODE_ENV === 'test'`. Body: `{userId, executionId}`. Server emits the nine stage events + two approval-created + two approval-resolved events in the canonical order, with ~50 ms gaps, using the same broadcaster as production.

**Fixture data:** `writers-workbench/tests/fixtures/newsletter-run.json` — a canned run with 9 stage events, 1 stories payload (7 stories), 1 subject payload, 1 saved payload.

**Test files:**

- `server/src/test/newsletter.test.ts` — S2 + S3 + S5 endpoints (covered by their stories, but consolidated here for a suite-level run).
- `client/src/pages/newsletter/__tests__/NewsletterHome.test.tsx` — renders against fixture data.
- `client/src/pages/newsletter/__tests__/ExecutionStatus.test.tsx` — subscribes to a mock EventSource, feeds it the fixture, asserts strip advances through all 7 pills and both approval panels render with correct content.

**Verification:**

| Check | Pass criterion |
|---|---|
| Suite — `npm test -w server` | ≥ 200/200 (prior 193 + ~10 new) |
| Suite — `npm test -w client` | green, no skipped |
| `simulate-run` triggers the full vocabulary in < 2s | manual curl |

**Depends on:** S6, S7, S8.

---

### S10 — Docs

Leave the project in a state where the next developer finds everything.

**Updates:**

- [`newsletter-agent-workflow.md`](./newsletter-agent-workflow.md) — mark §3 Phase 2a as `complete` in the phasing table; append a short note under §1 describing the 9 emit nodes added in S3 and their callback target.
- [`newsletter-migration-workflow-ids.md`](./newsletter-migration-workflow-ids.md) — add a new section at the bottom, `## Compose Newsletter 2a — additions (2026-XX-XX)`, listing the new httpHeaderAuth credential ID and the 9 emit node names with their activation state.
- `writers-workbench/docs/compose-newsletter-feature.md` (new) — user-facing doc with screenshots of Home + Generate + ExecutionStatus + PendingApprovals, plus the keyboard shortcut table (if any), plus troubleshooting ("run is stuck at `writing_segments`" → check n8n executions list).
- This sprint doc — flip each story's `status` from `planned` → `done` as merges land; update the total point count at the end.

**Verification:**

| Check | Pass criterion |
|---|---|
| Workflow doc §3 phase table shows 2a = done with a link to this sprint | visual |
| Workflow-ids registry has a `Compose Newsletter 2a — additions` section with the new credential ID | visual |
| `compose-newsletter-feature.md` renders cleanly + all screenshots load | manual |

**Depends on:** everything else merging.

---

## Dependency graph

```
             S1 ─┐
                  ├─► S2 ─┐
                  │        ├─► S5 ──┐
             S1 ─┘        │        │
                          ├─► S3 ──┤
                          │        │
                          └─► S4 ──┤
                                    │
                                    ├─► S6 ──┐
                                    │        │
                                    ├─► S7 ──┤
                                    │        │
                                    └─► S8 ──┤
                                              │
                                              ├─► S9 ─► S10
                                              │
                                              (any order)
```

S1 + S2 + S3 + S4 + S5 can ship in the first week (plumbing). S6 + S7 + S8 ship in the second week (pages, blocking on plumbing). S9 + S10 land at the tail.

---

## Merge order

1. **S1** — migration. Safe to land behind a feature flag even if the UI isn't wired yet; rows just sit.
2. **S2** — server editions + generate + status. No user-visible change yet.
3. **S3** — n8n stage emitters + callback endpoint. User-visible: SSE events flowing, no UI consumer yet.
4. **S4** — sidebar + stubs + hook. Feature-flag the sidebar group behind `NEWSLETTER_UI_ENABLED`.
5. **S5** — in-app approvals endpoints.
6. **S6** — Home + Generate.
7. **S7** — ExecutionStatus. 🔑
8. **S8** — PendingApprovals + ApprovalDetail.
9. **S9** — smoke suites + simulate-run fixture.
10. **S10** — docs. Flip `NEWSLETTER_UI_ENABLED=true` on DEV once S9 passes; leave PROD off until Phase 2b brings the history + ingestion pages.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SSE delivery gap during a long run | Medium | High — user sees stale state | On tracker mount, `GET /api/newsletter/execution/:id/status` reconstructs strip from `lastNodeExecuted`. Full fix in Phase 2c (stage-event persistence table). |
| `executionId` not returned synchronously by n8n form webhook | High | Medium | `correlationId` scheme in S2 + S3. `emit_stage_gathering` echoes it in its callback body; client replaces the placeholder URL with the real executionId once the first event arrives. |
| n8n form webhook URL rotates on workflow reactivation | Low | Medium | `N8N_NEWSLETTER_FORM_URL` env var is a one-line change. Document the refresh procedure in `compose-newsletter-feature.md` troubleshooting. |
| Double-resolve race (email click + in-app click) | Low | Low | `WHERE resolved_at IS NULL` guard already handles this; second resolver gets 409. |
| n8n resume-POST failure after in-app resolve | Low | Medium | Decision already persisted in `newsletter_approvals_v2`. 502 response tells the user to retry; retry is idempotent (same token, same resolved-state check). |
| LLM picked a story with no `identifiers` | Low | Medium | `ApprovalPayloadStories` shows empty-state card with suggested Revise feedback (`"story 3 has no sources"`). |
| Issue-number race (two concurrent saves for same edition) | Low | Medium | Deferred to Phase 2b (where the issue-number assignment lands); for Phase 2a no issue number is shown on the tracker. |
| Preview iframe CSP breaks on complex fonts | n/a | n/a | Phase 2b concern (preview iframe ships there). |

---

## Out-of-scope confirmations

Explicitly _not_ in this sprint:

- ❌ ScheduledSends + NewsletterDetail pages (Phase 2b).
- ❌ Preview iframe + SSR preview.html (Phase 2b).
- ❌ IngestionBrowser + ingestion facet endpoint (Phase 2b).
- ❌ Issue-number assignment on save (Phase 2b).
- ❌ `newsletter_stage_events_v2` persistence (Phase 2c).
- ❌ Playwright E2E (Phase 2c).
- ❌ Send fan-out, subscriber mgmt, analytics (separate sprints).
- ❌ Production n8n credential tier (release-promotion task).
- ❌ Edition ↔ writing-project FK linkage (post-2c decision).

---

## Recommendation — who writes this sprint

**Hand this sprint to Claude Code** with the repo already-imported context. Claude Code has full read access to the Workbench codebase, the existing test harness, the ingestion + approvals + email + sends routes, the Supabase schema, and the n8n REST API + credential handling already demonstrated in S1–S11 of the newsletter-migration sprint. Every delta in this doc has a precedent already in the repo:

- S1's migration follows the shape of migration 009 + the ALTER pattern from S6's newsletter-agent-migration work.
- S2 + S5's route file is a drop-in alongside `routes/approvals.ts` (S9) and `routes/newsletter-sends.ts` (S11).
- S3's n8n HTTP Request nodes copy the header-auth + `onError: continueRegularOutput` pattern already used by the self-post branch's HTTP nodes.
- S4–S8's client work mirrors the existing `ContentLibrary.tsx` feature folder structure.

Scope notes for Claude Code:

- **Do all DB + server work against DEV** (`writersworkbenchdev-production.up.railway.app`, DEV Supabase). Mirror cred patterns from S9 + S11. Do **not** touch PROD credentials; they'll be minted at promotion time.
- **Do not alter** `Content - Newsletter Agent V2`'s existing 87 nodes. Every S3 node is additive.
- **Emit-node credentials** must use the `genericCredentialType: httpHeaderAuth` pattern, same as every other outbound call to the Workbench (`oWli4irymtVqSDyC`, `jQBRJbmiUeTk8c11`, `ytjKAO1BESVf6Cnz`, `kxrSg24PIR2Npfvw`).
- **When in doubt on UI tokens**, read the design system root `README.md` → Visual Foundations. The StatusPill color map is already canonical and must be reused.
- **Treat `correlationId`** as load-bearing: without it the client can't stitch its optimistic redirect onto the real executionId. Add test coverage for it in S3 + S9.

If any of this runs into an environmental blocker (e.g., `.mcp.json` still pointing at the wrong n8n host, per the workflow-ids doc's "MCP config drift" note) — stop and ask; don't guess.

---

## Appendix A — Sample visual references

Both already committed under `handoff/writers-workbench/docs/samples/`:

- `compose-newsletter-sample.html` — ExecutionStatus page mid-run, stories-approval gate active.
- `the-workbench-newsletter-sample.html` — rendered editorial output, AI-news issue.

Reviewers should open both before sprint kickoff; they're the pixel-level specification for what S6 + S7 must produce.

---

## Appendix B — Feature flag

`NEWSLETTER_UI_ENABLED=true` — single env var on the Workbench server. Client reads via `GET /api/config`. Hides the entire sidebar group + all `/newsletter/*` routes (redirect to `/` with a toast) when `false`. Default: `false` on PROD until Phase 2b lands.
