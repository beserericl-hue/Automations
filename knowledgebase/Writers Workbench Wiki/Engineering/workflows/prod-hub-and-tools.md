---
name: PROD hub + tools
description: PROD - The Author Agent (hub) + 23 PROD tool sub-workflows that customers actually use.
type: concept
tags: [workflows, n8n, prod]
last_reviewed: 2026-05-09
---

# PROD hub + tools

Production tier. Customer-facing. **Modify only via release-day promotion or hotfix** — see [[promotion-dev-to-prod]] and [[hotfix-flow]].

## Hub: `PROD - The Author Agent`

- **ID:** `roMDypuMXHv6ugaZ`
- **Webhook:** `https://n8n.agileadautomation.com/webhook/author_request_v2`
- **Trigger:** Webhook (POST). Payload: `{user_message_request, user_id, originalUserPrompt?}`. Response mode: `responseNode`.
- **First node:** `preprocess_message` (Code, JS) — regex pre-routing for sync ops + flag-setting (isAsyncOp, isWebhookTrigger, etc.).
- **Routing node:** `route_response` (IF) — async ack vs sync waitForData.
- **Agent:** `Author Agent` — `@n8n/n8n-nodes-langchain.agent`. LLM = Gemini 2.5 Flash. Has access to ~23 `ai_tool` sub-workflows.
- **Terminal:** `route_after_agent` (IF) → `respond_to_webhook` or `end_noOp`.

System prompt sections (truncated highlights):
- **TOOL OVERRIDE** — never fabricate tool results; always call the tool.
- **Type A vs Type B response** — async ack vs sync data return.
- **Available genres** — 8 enumerated.
- **Available story arcs** — 8 enumerated.
- **Listing & browsing content** — explicit allowance (Gemini fabricates "I can't" otherwise).
- **Mature fiction override** — Gemini refuses romance / sexual content by default; this prompt unlocks it.
- **Prologue + Epilogue** — chapter_number 0 and 999.
- **Numbered list selection** — "show me 3", "the first one", etc.
- **Eve mode rules** — async ack vs immediate Type B for sync.
- **Anti-stage-direction (rule 7)** — banned `[Sigh]`, `[whisper]`, etc. in voice output.

## Tool sub-workflows (23)

All called via `ai_tool` reference from the hub. PROD ids per [[workflow-id-map]].

### Writing tools

| Tool name (visible to agent) | PROD ID | Description |
|------------------------------|---------|-------------|
| `write_blog_post` | `WEzf89RwAbkBxmQZ` | Claude Sonnet generates blog post → DALL-E 3 cover → email + DB insert |
| `write_newsletter` | `RbKpigBMgbRG8EZn` | Perplexity research → Claude → save → email (PROD currently still on this path; newsletter cluster on DEV-only) |
| `write_short_story` | `dk75OYTASeu6NkTr` | Sequential research → style analysis → build prompt → write → DALL-E cover → email |
| `write_chapter` (entrypoint) | `iDCqICsm4OpQNV6C` | Validates project + outline → calls Worker - Write Chapter |
| `Worker - Write Chapter` | `VxO2eG6uvImqaPA2` | Heavy chapter generation — see [[chapter-writer-architecture]] |
| `brainstorm_story` | `CQdwL0Wo1ZmelyXF` | Perplexity research → Claude outline → save to writing_projects.outline → email HTML |
| `brainstorm_chapter` | `0c4ZDWNScdmcOtr1` | Sub-chapter outlining — generates `outline.chapters[N].chapter_outline` |
| `edit_outline` | `GzCpOrWwXHYkEAeX` | Lightweight outline edits (ages, names, descriptions) — no full re-brainstorm |
| `format_kindle_book` | `Ugc2BonNNMCoeXP0` | KDP-formatted manuscript export |
| `qa_chapter` | `TVNfTVwOrCAnWBo7` | 9-check QA chain on a chapter → metadata.qa_report |

### Research + image tools

| Tool name | PROD ID | Description |
|-----------|---------|-------------|
| `email_research_report` | `G31zGaaG2vaTS1rw` | Email a previously-saved research report |
| `generate_cover_art` | `iWIcj915TYJQkdmC` | KIE.AI / DALL-E 3 cover art → upload to `cover-images` bucket → INSERT generated_images_v2 |
| `repurpose_to_social` | `6cF3os8cvTT6Ie1d` | Multi-platform post generation (Twitter / LinkedIn / Instagram / Facebook) → INSERT social_posts_v2 |

### Sub-workflows (called via `executeWorkflow`)

| Sub-workflow name | PROD ID | Description |
|-------------------|---------|-------------|
| `Sub - Retrieve Content` | `2T7rElM5RqCKst51` | List/get any content type by id, type, search term. Stop-words filter. |
| `Sub - Manage Library` | `DTjjVk51Z9aHgAg0` | INSERT / approve / publish / reject / schedule / list_versions / get_version / save_version / revert. |
| `Sub - Manage Story Bible` | `NBNlHQ8kAy7nX8LO` | Add/update/delete story_bible_v2 entries from agent commands. |
| `Sub - Eve Knowledge Callback` | `Q0K3aQrBMhw48lCB` | Web vs phone callback router (Sprint 5). Checks `/api/session/active` first. |
| `Sub - Manage Research Reports` | `QJFwA21FgfRmrSap` | Add/list research_reports_v2. |
| `Sub - Approval Token Generator` | `wdRZw4bjqPMOYd64` | Newsletter approval token issuance. |
| `Tool - Reset Eve Greeting` | `t8xslqa3PWOFMAIM` | 30s-delayed agent first_message reset (Sprint 5 callback fix). |
| `Manage Library` (top-level) | `x7bJLdHw2Hd8Gyer` | Wrapper for content lifecycle ops surfaced as a hub tool. |

### Cron + content

| Workflow | PROD ID | Description |
|----------|---------|-------------|
| `Cron: Scheduled Publisher` | `Z18KOsqW17VQgt8i` | Hourly cron — auto-publishes any `published_content_v2` with `metadata.schedule_date <= now()`. |
| `Content - Newsletter Agent` | `z9E2vmG8sZux4aNH` | Compose-newsletter agent (per-edition draft → DB → approval). PROD version pending newsletter cluster promotion. |

## Sprint 12 additions (now on PROD)

| Tool | PROD ID | Description |
|------|---------|-------------|
| `rewrite_chapter_with_research` | (PROD id from PR #71 promotion) | Citations-toggle rewrite using a Perplexity-driven research pipeline |
| `evaluate_genre_compliance` | (mirrored from DEV `e9LEpCM5L7zVpQxl`) | Computed-before validator → metadata.genre_eval |
| `scan_character_drift` | (mirrored from DEV `fJWDHXhle345f6jY`) | Deterministic regex v4 → outline._character_drift_scan |

The hub system prompt was updated to register these three. Agent can call them as `rewrite_chapter_with_research`, `evaluate_genre_compliance`, `scan_character_drift`.

## How a request flows through PROD

```
client → POST /api/chat/proxy
  → Express requireAuth + classifier
  → if heavy: BullMQ enqueue → worker dispatches
  → POST https://n8n.agileadautomation.com/webhook/author_request_v2
       {user_message_request, user_id}
  → Hub preprocess_message → flags
  → Author Agent (Gemini) picks tool
  → executeWorkflow → Tool - Write Chapter (entrypoint)
       → Worker - Write Chapter (VxO2eG6uvImqaPA2)
            → build_chapter_context (sub VxO2…)
            → research_topic
            → write each sub-chapter (Anthropic)
            → continuity merge
            → extract_bible (Anthropic)
            → INSERT published_content_v2 + content_versions_v2
            → UPSERT story_bible_v2
            → POST /api/email/send (Postal)
            → POST /api/callback/content-ready
       → return result up
  → Hub respond_to_webhook (Type A: ack) or end_noOp
```

## Recent PROD changes (per `writers-workbench/workflows/promotion-log.md` 2026-04-28)

Promoted at v1.1.0 release:
- `PROD - Tool - Brainstorm Chapter` — ~3 nodes changed (send_email, re_embed_project, track_token_usage)
- `PROD - Tool - Repurpose to Social Posts` — ~2 changed (send_email, generate_post_image)
- `PROD - Tool - Write Blog Post` — ~4 changed (get_recent_content, send_email, generate_blog_image, track_token_usage)
- `PROD - Tool - Edit Outline` — ~1 (send_email)
- `PROD - Tool - Email Research Report` — ~1 (send_email)
- `PROD - Sub - Manage Library` — ~1 (send_email)
- `PROD - Tool - Brainstorm Story` — ~3 (send_email, re_embed_project, track_token_usage)
- `PROD - Worker - Write Chapter` — **+6 nodes** (build_chapter_context, continuity_prepare, continuity_merge_llm, continuity_merge_claude, continuity_finalize) **−1** (rate_limit_delay) **~7** (workflow_trigger, build_sub_chapter_prompts, send_email, generate_cover_image, insert_draft)
- `PROD - Tool - Format Kindle Book` — ~1 (send_email)
- `PROD - 17 Cron: Scheduled Publisher` — ~1 (send_notification)
- `PROD - Tool - Generate Cover Art` — ~1 (send_email_with_image)
- `PROD - The Author Agent` — **+3 tools** (rewrite_chapter_with_research, evaluate_genre_compliance, scan_character_drift); **~20 nodes** changed
- `PROD - Tool - QA Chapter` — ~3 (send_email, track_token_usage, send_clean_email)
- `PROD - Tool - Write Newsletter` — ~3 (get_recent_content, send_email, track_token_usage)
- `PROD - Tool - Write Short Story` — ~4 (get_recent_content, send_email, generate_cover_image, track_token_usage)

After this promotion, PROD is current with DEV (excluding newsletter cluster). Story-bible extractor was added later in PR #71 hotfix.

## Common gotchas

- **Hub system-prompt drift** — DEV's prompt evolves during sprints. The promotion script copies the entire workflow JSON, including system prompt. Verify in n8n UI after promotion.
- **`$('parent_node')` expressions** — they return null in `ai_tool` sub-workflows. Tool sub-workflows can NOT access parent flow nodes; must fetch config independently. Real bug from Sprint 5.
- **`$fromAI()` requires 4-arg form to be optional**: `$fromAI('field', 'description', 'string', 'default')`. Without the 4th arg, the field is required and the agent will fail to call without it.
- **`if` branches must terminate at an explicit node**, otherwise sub-workflow returns 0 items. See [[tool-workflow-pattern]].
