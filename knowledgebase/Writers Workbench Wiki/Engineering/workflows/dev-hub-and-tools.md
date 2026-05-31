---
name: DEV hub + tools
description: DEV - The Author Agent + DEV tool sub-workflows. Mirror of PROD with sprint-in-flight changes.
type: concept
tags: [workflows, n8n, dev]
last_reviewed: 2026-05-09
---

# DEV hub + tools

Same shape as [[prod-hub-and-tools]] but with the active sprint state. **All sprint workflow editing happens here.**

## Hub: `DEV - The Author Agent`

- **ID:** `FLA6xIDEvejihQLP`
- **Webhook:** `https://n8n.agileadautomation.com/webhook/author_request_dev`
- **Trigger:** Webhook (POST). Same payload shape as PROD.
- All Set/Code nodes that hit Supabase use `https://gvbvwcnmjkdpclcisqrr.supabase.co` + DEV service-role key.
- All `executeWorkflow` refs point at DEV sibling ids (per [[workflow-id-map]]).

## DEV tool sub-workflows

Same 23 tools as PROD with DEV ids. See the table in [[workflow-id-map]] for the mapping.

## DEV-only workflows currently active

These exist on DEV but not yet on PROD:

### Sprint 12 Track B/C (some now on PROD via PR #71)

| Workflow | DEV ID | Status | What it does |
|----------|--------|--------|-------------|
| `DEV - Sub - Build Chapter Context` | `jJe84zB3U1HA9xVv` | mirrored to PROD | Builds LOCKED CHARACTER ROSTER context document for write-chapter sub-chapters |
| `DEV - Tool - Rewrite Chapter with Research` | `O8EWqLrqxcTJiWGN` | mirrored to PROD | Rewrites chapter using research pipeline; toggles `citations_in_prose` per project_type |
| `DEV - Sub - Research Pipeline` | `ACgIg1WPkIipiy5o` | mirrored to PROD | Perplexity → Claude derive_questions → research report inserted |
| `DEV - Tool - Evaluate Genre Compliance` | `e9LEpCM5L7zVpQxl` | mirrored to PROD | Computed-before validator (server computes evidence.context to defend against fabrication) |
| `DEV - Tool - Scan Character Drift` | `fJWDHXhle345f6jY` | mirrored to PROD | Deterministic regex v4 — Phase 0 reverse-order, Phase 1 longest-first canonical, Phase 2 forward drift, Phase 3 unknown-person noise filter |

### Newsletter cluster (DEV-only — promotion pending)

| Workflow | DEV ID | What it does |
|----------|--------|-------------|
| `Node - Scrape Url V2` | `BJaUNEt6PPIqbWLa` | Wraps Firecrawl with metadata extraction. Replaces broken `glJfsY6KaO0aoX0A` |
| `DEV - Newsletter Ingestion (Multi-User Cron)` | `JAQ8rmCaDoddqt2k` | Schedule trigger every 30 min → reads newsletter_feed_sources_v2 → drives scraping → inserts content_ingestion_v2 + newsletter_ingestion_runs_v2 |
| `Content - Newsletter Agent V2` | `bMvMKyK8obwYZmNb` | Per-edition compose: gathers ingestion items → Claude Sonnet draft → render HTML → INSERT newsletter_sends_v2 → email approval |
| `DEV - Newsletter Cadence Cron` | `7l1z4uMS9kdkYIT4` | Hourly trigger → /api/newsletter/cron/editions/due → SplitInBatches → POST /webhook/compose-newsletter-dev for each |

### Backfill workflow (DEV utility)

| Workflow | DEV ID | What it does |
|----------|--------|-------------|
| `DEV - Sub - Backfill Story Bible (one-shot)` | `hXkfrkuiWbJtJlEl` | Per-chapter re-extract story bible entries from existing chapter prose. Used during 2026-04-29 hotfix. PROD has no equivalent — manual backfill via `scripts/hotfix-backfill-story-bible-prod.py` |

### Legacy DEV workflows

| Workflow | DEV ID | Status |
|----------|--------|--------|
| `AI News Data Ingestion V2` | `2T3TwGHhdGQlTpQ5` | Still active (legacy 17-trigger predecessor). Will be deactivated once new multi-user cron verified. |
| `[OLD] Node - Scrape Url` | `glJfsY6KaO0aoX0A` | Renamed-and-disabled. Was wired to broken `BZku8v1a2K12iFGQ` httpHeaderAuth credential. |
| `Node - Scrape Url` | `bXBsnU4d6OseXWho` | Original V1 scraper. Don't modify. |

## DEV-specific configuration

In every DEV workflow, the Set node that holds `supabase_url` + `supabase_service_role_key` carries DEV values. Same for any HTTP Request node with hardcoded URLs — `_dev` suffix on hub callbacks, DEV credentials for ingestion / email / approval secrets.

n8n credentials (DEV side):
- DEV Workbench Email Secret — `kxrSg24PIR2Npfvw`
- DEV Workbench Ingestion Secret — `jQBRJbmiUeTk8c11`
- DEV Workbench Approval Secret — `ytjKAO1BESVf6Cnz`
- Anthropic — `5LhCYKsaFO3fF7II` (shared with PROD; same Anthropic account)
- Perplexity — `ggr9QCRobQVA6Lwb` (shared)
- Firecrawl — `oWli4irymtVqSDyC` (shared)
- OpenAI native — `xSzPIySN61drme77` (shared)

Per-tier credentials only exist for the Workbench-side shared secrets (email/ingestion/approval). API credentials for Anthropic, Perplexity, etc. are shared.

## How to safely make a sprint change

1. Open `DEV - <name>` in n8n UI.
2. Edit the node(s) you need.
3. Save (yields a draft on n8n 2.x).
4. Test via `POST /webhook/author_request_dev` with `{user_message_request, user_id}` payload.
5. If satisfied, in n8n UI: refresh the workflow tab, click **Publish** (⌘P) so runtime picks up.
6. Or via REST API: `deactivate → PUT → activate`. Pure-PUT also works in practice but Publish-via-UI is safer.
7. Verify in DEV Workbench (`writersworkbench-develop.up.railway.app`).
8. **Do NOT** also edit the PROD twin. Promotion at release-time will sync.

## Sprint 12-aware DEV state

| Workflow | Last meaningful DEV change | Source |
|----------|----------------------------|--------|
| `DEV - The Author Agent` | +3 tools (rewrite/eval/scan), +ui:evaluate-genre source bypass | Sprint 12 Track C |
| `DEV - Worker - Write Chapter` | +4 extract_bible_* nodes between continuity_finalize and update_story_bible | Hotfix 2026-04-29 |
| `DEV - Sub - Build Chapter Context` | LOCKED CHARACTER ROSTER block; name_variants per character | Sprint 12 S12-2 patch |
| `DEV - Tool - Scan Character Drift` | Deterministic regex v4 (Phases 0-3, HONORIFICS expansion, HEADER_TOKENS, _scanner_exclusions hook) | Sprint 12 S12-12 |

See [[sprint-12-chapter-tools]] for sprint context, [[chapter-writer-architecture]] for worker deep-dive.

## Common gotchas (DEV-specific)

- **`POST /webhook/author_request_dev` payload must be flat JSON.** n8n wraps it under `body` automatically; double-wrapping `{"body": {...}}` ends up at `body.body.*` and silently fails.
- **DEV hub `preprocess_message` has aggressive pre-routing.** Mentioning "Q/A report" in user_message_request shortcuts to `direct_qa_chapter` and skips the Agent. Avoid trigger keywords in test prompts.
- **Mid-sprint workflow editing should NOT happen in PROD.** Branch protection on `main` mostly enforces this on the code side; on the n8n side, governance discipline is the only enforcement. Use `verify-env-isolation.py` periodically.
- **`POST /workflows/{id}/deactivate`** returns 403 on already-active workflows in n8n 2.x. Toggle via UI; PUT-in-place works anyway. See [[workflow-tiers]].
