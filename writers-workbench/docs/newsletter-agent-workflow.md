# Content - Newsletter Agent V2 — Workflow Reference

**Workflow ID:** `bMvMKyK8obwYZmNb` on `https://n8n.agileadautomation.com`
**State:** Active (`activeVersionId` updates with every structural change).
**Shape:** 87 nodes. One form trigger, one terminal (`final_notification`). 8 sticky notes annotate sections in the n8n canvas.

This document covers three things:

1. **How the workflow works** — step by step, with the nodes that do each step.
2. **How it fits into the newsletter system** — what it depends on (ingestion data, Workbench endpoints, Postal) and what it produces (a `newsletter_sends_v2` row + reviewer emails).
3. **How we integrate it into the Writer's Workbench** — what the web-app surface should look like so users don't have to open n8n to run or follow a newsletter.

The sister workflow — `AI News Data Ingestion V2` (`2T3TwGHhdGQlTpQ5`) — is what *populates* the data this agent reads. That one runs on its own schedule (every 3–4 hours) and is covered separately; only its outputs are referenced here.

---

## 1. How the workflow works

### 1.1 Trigger

A single **`form_trigger`** node exposes a public form at a webhook URL n8n generates when the workflow activates.

- Field `Date` (required, type `date`) — the date window the agent will read ingested content from. Prefix used throughout: `{Date}/*`.
- Field `Previous Newsletter Content` (optional, multiline text) — paste the prior edition's markdown. Used downstream by the LLM as "avoid duplicate coverage" context.

Every subsequent expression in the workflow refers back to the form via `$('form_trigger').item.json.Date`.

### 1.2 Data gathering (reads the Workbench, not S3)

This replaces the old S3 + `api.aitools.inc` path. Two parallel sub-streams feed into one aggregated blob.

**Markdown / article stream:**

```
form_trigger
  → search_markdown_objects       GET  /api/ingestion/search?prefix={Date}/&type_not=newsletter&user_id=+14105914612
  → split_search_markdown          splitOut on $json.items
  → download_markdown_object      GET  /api/ingestion/get/{encodeURIComponent(key)}
  → prepare_markdown_content       Set — wraps each item in <key>---front-matter---\n{markdown}\n</key>
  → aggregate_markdown_content     aggregate all items
  → combine_markdown_content       joins aggregated items with "\n\n" separator into `content_result`
```

Authentication on both HTTP calls is the `httpHeaderAuth` credential `jQBRJbmiUeTk8c11` (`DEV Workbench Ingestion Secret`), which maps to the `X-Ingestion-Secret` header. `type_not=newsletter` deliberately excludes prior-newsletter snapshots so the agent only considers article, reddit_post, and tweet items.

**Tweets stream:**

```
combine_markdown_content
  → search_tweets                 GET  /api/ingestion/search?prefix={Date}/tweet.&user_id=+14105914612
  → check_any_results             IF    {{ ($json.items || []).length > 0 }}
    ├── true  → split_search_tweets → download_tweet_objects → prepare_tweet_content → aggregate_tweet_content → combine_tweet_content → stories_prompt
    └── false → stories_prompt
```

Tweets aren't currently being uploaded by anything, so `check_any_results` usually takes the false branch today. The wiring is ready for when a tweet ingestor is added.

### 1.3 Top-story selection

`stories_prompt` (Set) builds a long instruction prompt that embeds the aggregated markdown and tweet blobs. The prompt tells the LLM to:

- Pick N most newsworthy AI stories from the content.
- For each: a short summary, the source `identifier`s that support it (those are the keys the agent will later use to download segment content), and a comma-separated list of external source URLs.

`pick_top_stories` (chainLlm) runs this against **Claude Sonnet** (`claude-3-5-sonnet`, cred `5LhCYKsaFO3fF7II`), using `top_stories_parser` (a structured output parser) to enforce `{top_selected_stories: [...], top_selected_stories_chain_of_thought: string}`.

`set_current_stories` pins the parsed output at `$json.current_stories` so every downstream email or LLM can reference it consistently across the stories-approval revision loop (see §1.4).

### 1.4 Stories approval gate

Before anything expensive runs, a human is kept in the loop.

```
set_current_stories
  → share_selected_stories_email        POST /api/email/send  (cred: kxrSg24PIR2Npfvw / X-Email-Secret)
  → share_stories_reasoning_email       POST /api/email/send  (threaded-equivalent "Re: …" subject)
  → create_approval_stories             POST /api/approvals/create  (cred: ytjKAO1BESVf6Cnz / X-Approval-Secret)
  → send_approval_email_stories         POST /api/email/send with the returned approval_url in a button
  → wait_for_stories_approval           Wait (mode: webhook, 48h timeout)
  → extract_stories_approval_feedback   Gemini LLM classifies the resumed JSON body {decision, feedback} into {approved, feedback}
  → check_stories_feedback              IF $json.output.approved
     ├── true  → subject line stage (§1.5)
     └── false → edit_top_stories (chainLlm) loops back to set_current_stories with the feedback applied
```

Key mechanics:

- `create_approval_stories` POSTs `{user_id, stage:'stories', payload: current_stories, resume_url: $execution.resumeUrl, execution_id: $execution.id}`. The Workbench stores the row in `newsletter_approvals_v2` and returns `{token, approval_url}`. The Wait-node resume URL never leaves the server.
- `send_approval_email_stories` sends a Postal email whose HTML body is a button pointing at `{APPROVAL_BASE_URL}/approvals/{token}`.
- When the reviewer opens that URL and submits the SSR form, `POST /approvals/:token/resolve` records the decision and POSTs `{decision, feedback}` to the stored resume URL. The Wait node resumes.
- `extract_stories_approval_feedback` — a LangChain `informationExtractor` that used to handle free-text Slack replies. It still runs, now reading `JSON.stringify($json.body || $json)` and emitting `{approved: bool, feedback: string}` so the existing `check_stories_feedback` IF node didn't need to change.
- On `revise`, `edit_top_stories` runs Claude with the original stories + the feedback text and returns a modified `current_stories`. The loop repeats until `approved === true`.

### 1.5 Subject line + pre-header

Same shape as §1.4 for the second gate:

```
check_stories_feedback (true)
  → subject_examples              Set — hard-coded list of past high-performing subject lines for few-shot
  → set_subject_line_prompt       Set — assembles the prompt
  → write_subject_line            chainLlm (Claude) with subject_line_parser → {subject_line, pre_header_text, additional_subject_lines, subject_line_reasoning, pre_header_text_reasoning}
  → set_current_subject_line      Set — pins output as $json.current_subject_line
  → share_subject_line_email      POST /api/email/send
  → share_subject_line_reasoning_email  POST /api/email/send (threaded-equivalent)
  → create_approval_subject_line  POST /api/approvals/create (stage='subject_line')
  → send_approval_email_subject_line
  → wait_for_subject_line_approval
  → extract_subject_line_approval_feedback → check_subject_line_feedback IF
     ├── true  → story iteration (§1.6)
     └── false → edit_subject_line → back to set_current_subject_line
```

### 1.6 Per-story segment writing

Once both gates pass, the agent writes one section per approved story.

```
check_subject_line_feedback (true)
  → set_selected_stories          Set — final stories + subject + preheader
  → split_stories                  splitOut on current_stories.top_selected_stories
  → iterate_stories                splitInBatches (one story at a time)
```

`iterate_stories` has two outputs: "done" (main[0]) and "next item" (main[1]). Per-item path (main[1]) looks like this:

```
iterate_stories (next)
  → set_current_segment           Set — exposes the current story's identifiers + metadata
  → split_content_ids              splitOut on current_story.identifiers (the content-ingestion keys the LLM picked)
  → download_segment               HTTP GET /api/ingestion/get/{encodeURIComponent(current_story.identifiers)}
  → prepare_segment_content_item   Set — front-matter-wrapped snippet of each source
  → aggregate_segment_text_content aggregate all segments for this story
  → check_external_urls            IF any external source links exist?
      ├── true → split_segment_external_source_urls → scrape_segment_external_source_url (executeWorkflow → Node - Scrape Url V2, id BJaUNEt6PPIqbWLa)
      │         → filter_segment_external_source_errors → aggregate_segment_external_source_content
      │         → write_segment_content
      └── false → (skip directly to) write_segment_content
  → write_segment_content          chainLlm (Claude) — writes the section in the newsletter's voice
  → extract_image_urls             chainLlm (Gemini) — selects image URLs to use
  → share_segment_msg_email        POST /api/email/send — sends reviewer a preview of this section
  → set_story_segment              Set — stores the generated section in the iteration buffer
  → iterate_stories (loops)
```

When the loop finishes (iterate_stories main[0] fires):

```
iterate_stories (done)
  → set_story_segments            Set
  → aggregate_story_sections       aggregate all rendered sections
  → set_combined_sections_content  Set — exposes the concatenated body as $json.story_sections
```

### 1.7 Intro, shortlist, and assembly

```
set_combined_sections_content
  → write_intro                    chainLlm (Claude) — writes the newsletter's intro paragraph
  → write_other_top_stories        chainLlm (Claude) — writes "The Shortlist" mini-summaries for stories that didn't get a full section
  → set_full_newsletter            Set — concatenates subject + preheader + intro + sections + shortlist into one markdown blob at $json.full_newsletter_content
  → create_newsletter_file         convertToFile — emits a binary file named {Date}.md with the full markdown
  → upload_newsletter_file_email   POST /api/email/send — sends the reviewer the .md as a base64 Postal attachment
  → share_newsletter_msg_email     POST /api/email/send — "Newsletter {Date} — Preview" note
```

### 1.8 Persist + notify (S11 final step)

```
share_newsletter_msg_email
  → save_scheduled_newsletter     POST /api/newsletter-sends/save
      body: { user_id, send_date, subject, preheader, markdown_body, html_body: "<pre>"+md+"</pre>",
              metadata:{ generated_by, execution_id } }
      returns: { id, scheduled_send_at, status: "scheduled" }
  → final_notification             POST /api/email/send — confirms the row id + scheduled_send_at and attaches the .md one more time
```

The save endpoint upserts on `(user_id, send_date)` — re-running the workflow for the same date overwrites the previous draft instead of duplicating. `scheduled_send_at` defaults to `now() + 24h` unless the caller supplies a value. `status='scheduled'` parks the row for a future **calendar cron** (deferred to a later sprint) to pick up and actually release.

### 1.9 Credentials cheat-sheet

| Credential name | Type | Used by |
|---|---|---|
| `DEV Workbench Ingestion Secret` (`jQBRJbmiUeTk8c11`) | httpHeaderAuth | search/download + save_scheduled_newsletter |
| `DEV Workbench Approval Secret` (`ytjKAO1BESVf6Cnz`) | httpHeaderAuth | create_approval_* |
| `DEV Workbench Email Secret` (`kxrSg24PIR2Npfvw`) | httpHeaderAuth | every `*_email` HTTP node |
| `Anthropic account` (`5LhCYKsaFO3fF7II`) | anthropicApi | claude-3-5-sonnet |
| `Google Gemini(PaLM) Api account` (`QCbiHRahj2Q15wqr`) | googlePalmApi | gemini-2.5-pro |
| `OpenAi account` (`xSzPIySN61drme77`) | openAiApi | (inherited from sibling ingestion flow's LLMs) |

PROD tier uses a parallel credential set that does not exist yet — created at release-promotion time.

---

## 2. How it fits into the newsletter system

The Newsletter Migration sprint produced four collaborating pieces. This workflow is the middle one.

```
 ┌──────────────────────────────┐         ┌─────────────────────────────┐
 │ AI News Data Ingestion V2    │         │ Content - Newsletter Agent   │
 │ (2T3TwGHhdGQlTpQ5)           │         │ V2  (bMvMKyK8obwYZmNb)       │
 │                              │         │                              │
 │ RSS / Reddit feeds ─────────┐│         │ form_trigger                 │
 │ → scrape (Firecrawl)        ││         │   reads from Workbench API   │
 │ → /api/ingestion/upload     ││─────────│→ /api/ingestion/search,      │
 │                              ││         │   /api/ingestion/get         │
 │ Scheduled every 3-4h         ││         │                              │
 └────────────┬─────────────────┘│         │ → LLM pipelines (Claude,     │
              │                  │         │    Gemini)                   │
              ▼                  │         │                              │
 ┌──────────────────────────────┐│         │ → /api/approvals/create      │
 │ DEV Supabase                 ││         │   /api/email/send            │
 │  content_ingestion_v2        │◄────────┤                              │
 │  + newsletter-ingestion      ││         │ → /api/newsletter-sends/save │
 │    (Storage bucket)          ││         │                              │
 │  newsletter_approvals_v2     │◄─────────┤                              │
 │  newsletter_sends_v2         │◄─────────┤                              │
 └──────────────────────────────┘│         └──────────────┬───────────────┘
                                 │                        │
                                 │                        ▼
                                 │         ┌──────────────────────────────┐
                                 │         │ Writers Workbench (Express)  │
                                 │         │  /api/ingestion/*            │
                                 │         │  /api/email/send  (→ Postal) │
                                 │         │  /api/approvals/create       │
                                 │         │  /approvals/:token           │
                                 │         │  /approvals/:token/resolve   │
                                 │         │  /api/newsletter-sends/save  │
                                 │         └──────────────┬───────────────┘
                                 │                        │
                                 └────────────────────────┘
```

Concretely:

- **Ingestion workflow** writes to `content_ingestion_v2` and the `newsletter-ingestion` Storage bucket. It runs on its own schedule and doesn't know this agent exists.
- **Agent workflow** (this one) is user-triggered via its form. It reads from the ingestion tables, generates approval/email side effects via the Workbench server, and parks a final row in `newsletter_sends_v2`.
- **Workbench Express server** is the single choke point for every piece of state this workflow touches: ingestion metadata, approval rows, outgoing emails (Postal), and the scheduled-send row. n8n has no direct Supabase credentials — every DB write goes through an HTTP endpoint.
- **Postal** (on the same Railway project) delivers every email — reviewer notifications, segment previews, approval links, final newsletter .md attachments.
- **Deferred:** a calendar cron that flips `newsletter_sends_v2.status` from `scheduled` to `sending` and actually fans out to subscribers. This workflow does not fire that; it only parks the row.

---

## 3. How we integrate this workflow into the Writer's Workbench

Today, "integration" means a user opens the n8n form URL in a browser and types a date. That's functional but not product-grade. The Writer's Workbench app should surface the newsletter lifecycle end-to-end so a reviewer never has to visit n8n or sift through email. Below is a concrete proposal, grounded in what the workflow already emits.

### 3.1 Surfaces to add to the web app

| Surface | Data source | Purpose |
|---|---|---|
| **Sidebar → "Newsletter" section** | — | Single entry-point for everything below. |
| **"Generate newsletter" page** | `form_trigger` webhook | Date picker + "previous newsletter content" textarea. Submits via fetch to the n8n form webhook URL. Returns an executionId the UI can track. |
| **"In flight" panel** | `GET /api/v1/executions?workflowId=bMvMKyK8obwYZmNb` (n8n public API) | Live status of the current/recent run: what stage ("picking stories", "awaiting approval", "writing segments 3/7", "complete"). Pollable. |
| **"Pending approvals" inbox** | `SELECT * FROM newsletter_approvals_v2 WHERE user_id = $1 AND resolved_at IS NULL AND expires_at > now()` | Skip the email round-trip: render every open approval inline in the app with the Approve / Revise form (same payload as `/approvals/:token`). |
| **"Scheduled" list** | `GET /api/newsletter-sends/scheduled` (already exists) | See upcoming releases parked by `save_scheduled_newsletter`. |
| **"Sent history" list** | `SELECT * FROM newsletter_sends_v2 WHERE status IN ('sent','failed')` (Supabase direct, RLS own-row) | Past releases after the calendar cron lands. |
| **Individual newsletter detail** | `newsletter_sends_v2` row + archive markdown | View subject / preheader / full markdown / metadata / recipient_count after delivery. |
| **Ingestion browser** | `/api/ingestion/search` + `/api/ingestion/get/:key` | What's been scraped for a given date range, filterable by type and source_name. Helpful for debugging "why did story X not get picked?". |

All list pages reuse the existing `Pagination`, `TableSkeleton`, and `EmptyState` primitives from Sprint 2/6.

### 3.2 New Express endpoints to bridge them

Most of the data is already reachable via Supabase-RLS-filtered client queries, but three server endpoints would make the UI substantially simpler and avoid exposing n8n directly to the browser.

1. **`POST /api/newsletter/generate`** — proxies to the n8n form webhook. Body: `{send_date, previous_newsletter_content?}`. Server translates into a `multipart/form-data` POST against n8n's form URL, returns `{executionId}`. Protected by `requireAuth`. Cleaner than having the React client know the n8n webhook URL directly.

2. **`GET /api/newsletter/execution/:id/status`** — thin proxy over n8n's public `/api/v1/executions/:id`, returning only the fields the UI cares about: `status`, `stage` (derived from `lastNodeExecuted`), `startedAt`, `stoppedAt`, per-approval status. Avoids a client-side n8n API key.

3. **`GET /api/newsletter/approvals/open`** — returns the caller's open approvals (already queryable via Supabase RLS, but a purpose-built endpoint can embed the stage's payload shape and approval_url for direct in-app rendering).

4. **`POST /api/newsletter/approvals/:token/resolve`** — same logic as the public `/approvals/:token/resolve` but takes an authenticated Supabase user instead of a bare token. Lets the sidebar inbox resolve approvals without the email round-trip. (The public URL still works for email recipients.)

### 3.3 Client routes

Following Sprint 2's App.tsx pattern:

```
/newsletter                        NewsletterHome       — list + "Generate" CTA
/newsletter/generate               NewsletterGenerate   — Date + previous content form
/newsletter/execution/:id          ExecutionStatus      — live status; reuses existing SSE infra
/newsletter/approvals              PendingApprovals     — inbox
/newsletter/approvals/:token       ApprovalDetail       — resolve form
/newsletter/sends                  ScheduledSends       — upcoming + past
/newsletter/sends/:id              NewsletterDetail     — subject/preheader/markdown/metadata
/newsletter/ingestion              IngestionBrowser     — content_ingestion_v2 filterable view
```

### 3.4 SSE for live status

The Workbench already runs the SSE session infrastructure from Sprint 5 + S10b-5. Bolting newsletter-status onto it costs a single call from the n8n workflow: add a tiny HTTP Request node at strategic points (after `pick_top_stories`, after each approval resolve, after `save_scheduled_newsletter`) that POSTs `{event:'newsletter.stage', stage:'...', executionId, userId}` to a new `POST /api/callback/newsletter-stage` route. Server pushes it to the logged-in user's SSE channel. The React client shows real-time stage updates without polling.

This is the cheapest path to a "watching my newsletter get made" UX.

### 3.5 What to do about the n8n form URL

For now the form webhook is public and anyone with the URL can trigger a run. Options:

- Short term: add a shared secret to n8n's form configuration (validated by a small Code node at the top of the workflow). Proxy through `POST /api/newsletter/generate` which injects the secret server-side. Client never sees it.
- Longer term: replace the n8n formTrigger with an n8n webhook trigger (no form UI), drive everything through `/api/newsletter/generate`, and let the Workbench own the input validation. The form in n8n becomes purely a debug/manual path.

### 3.6 Phasing

A reasonable sprint split if we want to stage this:

- **Phase 2a** — Generate + ExecutionStatus + PendingApprovals (in-app approvals replace the email click-through). One sprint.
- **Phase 2b** — ScheduledSends + NewsletterDetail + IngestionBrowser. Depends on the calendar-cron sprint that flips `status='scheduled'` → `'sent'`.
- **Phase 2c** — SSE stage events. Self-contained polish.

Each phase uses the existing Workbench auth, RLS, and test harness. No new Supabase tables are needed beyond the three migration 009 already shipped.

---

## Appendix A — Quick file map for future edits

| Need to change | File / node |
|---|---|
| Story-picking prompt | `stories_prompt` Set node `select_top_stories_prompt` assignment |
| Subject-line few-shots | `subject_examples` Set node `subject_line_examples` assignment |
| Writing voice | `write_segment_content`, `write_intro`, `write_other_top_stories` chainLlm prompts |
| Edit-loop behaviour | `edit_top_stories` / `edit_subject_line` chainLlm prompts |
| Email subject lines | individual `*_email` HTTP body expressions |
| Approval token expiry | `newsletter_approvals_v2.expires_at` default (48h; DDL in migration 009) |
| Scheduled-release default | `/api/newsletter-sends/save` server logic (+24h fallback) |
| LLM models | `claude-3-5-sonnet` and `gemini-2.5-pro` LangChain nodes — change the model string, credential stays |

## Appendix B — Test & monitoring pointers

- `scripts/newsletter-final-e2e-sim.py` exercises the approvals + save paths against live dev.
- `scripts/newsletter-ingestion-e2e-sim.py` + `-selfpost-` + `-agent-read-` cover the three ingestion data paths the agent reads.
- `GET /api/v1/executions?workflowId=bMvMKyK8obwYZmNb&limit=10` on n8n lists recent runs.
- `GET /api/health` on dev Railway exposes `checks.postal`, `checks.supabase`, `checks.redis` — all three green is the happy-path precondition for a newsletter run.
