# Compose Newsletter — user guide

Sprint 2a shipped. This page is what to hand a new editor or admin so
they can run, watch, and ship a Course Worx Workbench newsletter from
inside the Writer's Workbench.

> **DEV-only as of release v1.1.x.** PROD picks up the feature on the
> next release-day promotion.

## At a glance

| Action | Where in the app |
|---|---|
| Trigger a new newsletter run | Newsletter → Generate |
| Watch progress in real time | Newsletter → in-flight tile → Resume → |
| Approve / send back stories or subject line | Newsletter → Pending approvals |
| See past runs | Newsletter → Home → Recent runs table |
| Edit / create a template | Newsletter → Templates |

## The seven pages

### 1. Newsletter Home (`/newsletter`)

Three tiles + a Recent runs table:

- **In-flight** — lights up when a `newsletter.stage` event arrives in
  the last 30 min and clears on `saved` or `error`. Shows edition badge
  + stage pill + elapsed time + a Resume → link to the Execution page.
- **Pending approvals** — first three rows from the inbox. "See all N →"
  jumps to the full list when there are more.
- **Next scheduled send** — the soonest `status='scheduled'` row, if any.

The Recent runs table reads `GET /api/newsletter/sends?limit=10`. Click
any row to jump to the right view (sends detail for completed runs,
execution status for drafts).

### 2. Generate (`/newsletter/generate`)

Three fields:
- **Edition** — picks the edition row from `newsletter_editions_v2`.
  Each edition carries its own masthead + colors, so changing it changes
  the visual identity of the email.
- **Send date** — defaults to today, drives the masthead's date and the
  scheduled-send timestamp.
- **Previous newsletter content** — auto-fills from the most recent
  send for that edition. The model uses it to avoid duplicating coverage.

Two buttons:
- **Preview template** — opens a modal iframe rendering the active
  default template against its sample data. Use this to confirm the
  brand identity before kicking off a real run.
- **Generate newsletter →** — POSTs `/api/newsletter/generate`, gets
  back `{executionId}`, navigates to the Execution Status page.

### 3. Execution Status (`/newsletter/execution/:id`) — the marquee

Refresh-durable. Hydrates from `/api/newsletter/execution/:id/status`
and `/api/newsletter/approvals/open?execution_id=:id` on mount, then
streams via SSE.

```
┌─ Header: edition · send_date ──────────── Open in n8n → ─┐
│ ┌─ Stage strip ──────────────────────────────────────┐ │
│ │ Gathering | Selecting | Stories | Subject | Writing │ │
│ │              | Assembling | Saved                    │ │
│ └────────────────────────────────────────────────────┘ │
│ ┌── Live log ──────────────┐  ┌── Approval panel ──┐ │
│ │ 09:41:23  gathering       │  │ Stories approval   │ │
│ │ 09:41:24  selecting       │  │ ┌ story 1 ─────┐   │ │
│ │ 09:41:25  awaiting_       │  │ │ headline...  │   │ │
│ │           stories_        │  │ │ summary...   │   │ │
│ │           approval        │  │ │ source ↗     │   │ │
│ │           ↓ New events    │  │ └─────────────┘   │ │
│ └──────────────────────────┘  │ [Approve] [Revise] │ │
│                                  └────────────────────┘ │
│ <details>Raw events</details>                            │
└─────────────────────────────────────────────────────────┘
```

The 7 phases collapse the 9 server stages — `awaiting_*` and `*_approved`
share a single approval pill that swaps an hourglass (⌛) for a check (✓)
as the workflow progresses. An `error` event lands as a red overlay on
the active phase + a banner above the log.

When an approval is waiting, the right pane renders the relevant payload
(stories cards or subject + preheader) and the Approve / Revise form.
Submitting fires `POST /api/newsletter/approvals/:token/resolve` and
optimistically advances the strip before the next SSE event lands.

### 4. Pending approvals (`/newsletter/approvals`)

Inbox over `/api/newsletter/approvals/open`. Stage pill, edition badge,
excerpt, created (absolute) and expires (relative). Click any row to
review + resolve from there. Empty state: "No pending approvals.
You're caught up."

### 5. Approval detail (`/newsletter/approvals/:token`)

Same payload + form components as the Execution page, but addressable
straight from an email link or bookmark. On resolve → invalidates the
inbox query and navigates back to the list.

### 6. Sends (Phase 2b stub)

`/newsletter/sends` and `/newsletter/sends/:id` are placeholders today.
Phase 2b fills them in with a list view + per-issue preview.

### 7. Templates (`/newsletter/templates`)

Lists Handlebars templates the caller can see (system + own; admins see
all). Edit clicks land on `/newsletter/templates/:id`, a two-column
HTML source + sample-data JSON editor with a live iframe preview.

The seeded `The Workbench (default)` template has Course Worx branding
baked in — wordmark, colors, masthead, footer, CourseworxAI stamp. Users
creating new templates supply their own branding inline; only the AI-generated
content (intro, lead, sponsor, pull quote, trending list, signoff) has
Handlebars placeholders.

## Stage vocabulary

The 9 stages emitted by the n8n workflow's `emit_stage_*` nodes:

| Stage | Phase pill | What's happening |
|---|---|---|
| `gathering` | Gathering | `search_markdown_objects` running |
| `selecting_stories` | Selecting | `pick_top_stories` (Claude) running |
| `awaiting_stories_approval` | Stories approval ⌛ | Wait node parked |
| `stories_approved` | Stories approval ✓ | Workflow resuming |
| `awaiting_subject_approval` | Subject approval ⌛ | Wait node parked |
| `subject_approved` | Subject approval ✓ | Workflow resuming |
| `writing_segment` | Writing | Per-segment loop running |
| `segments_done` | Assembling | Combining sections |
| `saved` | Saved | Row in `newsletter_sends_v2` (status=`scheduled`) |
| `error` (overlay) | (current pill) | Surface a red banner + tooltip |

## Troubleshooting

**Run is stuck at `writing_segment`.** Check the n8n execution
([Open in n8n →] link on the Execution Status header). Most often
Claude / Perplexity / Gemini hit a rate limit; the workflow retries
3× before failing the segment.

**Approval panel doesn't appear after the strip hits "Stories approval".**
Refresh the page — the in-app SSE channel may have lost the
`approval.created` event. The execution page rehydrates from
`/api/newsletter/approvals/open?execution_id=:id` on mount.

**"No template found for edition 'X'" when clicking Preview.** Go to
Newsletter → Templates → New, set `edition_id = X` and `is_default = true`.
Each edition needs exactly one active default.

**Email body looks like `<pre>...</pre>`.** The n8n `combine_markdown_content`
node hasn't been swapped to call the new `/api/newsletter/render-html`
endpoint yet. Tracked as issue #63 — release-day item.

## Endpoints (summary)

| Method | Path | Auth | Used by |
|---|---|---|---|
| `GET`  | `/api/newsletter/editions` | session | Generate, Home, Templates |
| `GET`  | `/api/newsletter/editions/:id/last-sent-markdown` | session | Generate (textarea prefill) |
| `POST` | `/api/newsletter/generate` | session | Generate (kicks off n8n) |
| `GET`  | `/api/newsletter/execution/:id/status` | session | Execution Status (hydration) |
| `GET`  | `/api/newsletter/sends` | session | Home tiles + recent runs |
| `GET`  | `/api/newsletter/approvals/open` | session | Inbox, Detail (`?token=`), Execution Status |
| `POST` | `/api/newsletter/approvals/:token/resolve` | session | Resolve form |
| `GET`  | `/api/newsletter/templates` (etc.) | session | TemplatesList / Editor |
| `POST` | `/api/newsletter/templates/:id/preview` | session | Editor preview iframe + Generate Preview button |
| `POST` | `/api/newsletter/render-html` | `X-Ingestion-Secret` | n8n send-time (T4 follow-up) |
| `POST` | `/api/callback/newsletter-stage` | `X-Callback-Secret` | n8n's 9 emit nodes |
| `POST` | `/api/test/newsletter/simulate-run` | none (NODE_ENV=test only) | Smoke fixture |

## Manual smoke runbook (DEV)

1. Open Newsletter → Templates. Confirm "The Workbench (default)" exists with a green "default" badge for `ai-news`.
2. Open Newsletter → Generate. Pick `ai-news`, today, blank previous content. Click **Preview template** → modal iframe shows the Workbench masthead + sample-data content.
3. Click **Generate newsletter →**. You should land on `/newsletter/execution/<id>`.
4. Watch the strip light up: Gathering → Selecting → Stories approval (⌛). The right panel populates with story cards.
5. Click **Approve** in the resolve form. Strip advances optimistically; n8n resumes within ~5 s.
6. Wait for Subject approval — repeat.
7. Strip reaches `Saved`. Refresh the page. The strip should still show the saved state (hydration from `/status`).
8. Open Newsletter → Pending approvals. Empty state visible.
9. Open Newsletter → Home → Recent runs table. The just-completed run shows up.

## Related docs

- [`compose-newsletter-design.md`](./compose-newsletter-design.md) — full design rationale + SSE event vocabulary
- [`compose-newsletter-sprint.md`](./compose-newsletter-sprint.md) — sprint plan + per-story verification tables
- [`newsletter-templates-sprint.md`](./newsletter-templates-sprint.md) — Templates side sprint
- [`newsletter-migration-workflow-ids.md`](./newsletter-migration-workflow-ids.md) — registry of credential + workflow IDs
- [`newsletter-agent-workflow.md`](./newsletter-agent-workflow.md) — the n8n workflow itself
