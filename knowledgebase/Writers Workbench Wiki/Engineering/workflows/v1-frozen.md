---
name: V1 frozen workflows
description: Original 2025 baseline workflow tree. Frozen — never modify.
type: concept
tags: [workflows, v1, frozen]
last_reviewed: 2026-05-09
---

# V1 (Orig) workflows

The original 2025 implementation. Used by:
- The **Baseline Eve agent** `agent_6401kjwqy66nfhabj82dvy8pnh2b` (still customer-facing for V1 contracts).
- The V1 webhook `/webhook/author_request`.
- Older recordings + integrations that hardcoded V1 URLs.

**DO NOT MODIFY ANY OF THESE.** Hard rule per [`CLAUDE.md`](../../../../CLAUDE.md) baseline protection.

## V1 workflow IDs

| Name | ID | Purpose |
|------|----|----|
| Hub: `The Author Agent Orig` | `RcHfwiB7uM2vFfJ3` | V1 hub. Webhook `/webhook/author_request`. Gemini Agent. |
| `Content Ingestion Orig` | `iLuMoCq0tNJJAH5n` | RSS / web scrape → content_index |
| `AI Scraping Pipeline Orig` | `ZhVhnuJkIbQrhhNr` | Firecrawl scrape orchestration |
| `Write Blog Post Orig` | `iMBIWzO2PjsLNH9w` | Blog post generation |
| `Write Newsletter Orig` | `cjIUEjrqvyGZyKwN` | Newsletter generation (single user) |
| `Generate Cover Art Orig` | `SxeLHxzvITEKyKc0` | DALL-E cover art |
| `Repurpose Social Orig` | `95z13RGuzJDHVNSw` | Multi-platform social |
| `Email Research Report Orig` | `QAbYfOOd05lyesva` | Email a research report |
| `Manage Story Bible Orig` | `9cvuhBS412AQRJxf` | Story bible CRUD |
| `Write Short Story Orig` | `LTZ63B2H0w8Sl4FW` | Short story generation |
| `Write Chapter Orig` | `tpj55Sf66jrBPNT8` | Chapter generation (single-LLM era) |
| `Manage Research Reports Orig` | `MLjncwcdMSjBkS4Z` | Research report CRUD |
| `Brainstorm Story Orig` | `StwejB5GLFE26hmU` | Outline brainstorm |
| `Manage Library Orig` | `1JERh5yJ3yDJka8s` | Library CRUD (approve/publish/etc.) |
| `Retrieve Content Orig` | `DQS2zIhVjyuxabcb` | List/get content |
| `Eve Knowledge Callback Orig` | `PaFJlsxWq4BKt0iq` | Eve KB injection + outbound call |
| `Edit Outline Orig` | `KfUTQZ7p1ZcDriDR` | Lightweight outline edits |
| `Cron Scheduled Publisher Orig` | `AtMuc7ZsL28LfU1b` | Scheduled publishing cron |
| `Reset Eve Greeting Orig` | `g59QidpmVzQUjQNj` | 30s-delay first_message reset |

## V1 architecture differences

V1 was the simpler "single-LLM writes the whole chapter" architecture:
- `Write Chapter Orig` (`tpj55Sf66jrBPNT8`) — one Claude call generates the entire chapter at once. No sub-chapter parallelism. No continuity merge. No story-bible extraction stage.
- The chapter writer LLM emitted a JSON envelope `{chapter_text, new_story_bible_entries}`. Downstream nodes parsed it and inserted into `story_bible_v2`. This is why V1 chapters have populated story bibles.
- No drift scanner. No genre evaluator. No annotations panel. No rewrite-with-research.

## V1 ingestion pipeline (newsletter precursor)

The original newsletter ingestion lived in:
- `Content Ingestion Orig` (`iLuMoCq0tNJJAH5n`)
- `AI Scraping Pipeline Orig` (`ZhVhnuJkIbQrhhNr`)
- `AI News Data Ingestion Orig` (`53SlwZMS21gpvz3H`) — single-user, hardcoded 17 RSS triggers.
- `Node - Scrape Url` (`bXBsnU4d6OseXWho`) — original Firecrawl wrapper.
- `[OLD] Node - Scrape Url` (`glJfsY6KaO0aoX0A`) — was wired to the broken `BZku8v1a2K12iFGQ` httpHeaderAuth OpenAI cred. Renamed-and-disabled during Newsletter Migration S1.

The V2 newsletter rewrite (Newsletter S2-S5 + Multi-User PRs #69, #70, #72-75) replaces this entire chain with `Node - Scrape Url V2` + DB-driven multi-user cron + per-user editions. **DEV-only** as of 2026-05-09. PROD still uses the V1 chain via `AI News Data Ingestion Orig`.

## What still hits V1 in production

- Baseline Eve agent (`agent_6401kjwqy66nfhabj82dvy8pnh2b`) — when called by anyone with V1-era Eve number provisioning, routes to V1 hub.
- Customer 1.0 contracts that hardcoded the V1 webhook URL.
- The V1 newsletter ingestion cron — still firing daily, still inserting into the legacy `content_index` table on PROD Supabase.

## Why we keep V1 alive

1. **Existing customer expectations.** Some users are still on V1 (E.164 numbers + voice config tied to the baseline agent).
2. **Reproducibility.** Reproducing a 2025 chapter generation requires the V1 codepath.
3. **Sunsetting cost.** Migrating customers to PROD tier requires a) acquiring a new Eve number, b) registering it on the PROD agent, c) reconfiguring their voice greetings.

V1 will likely sunset over Sprints 9-15 as customers convert to subscriptions. No formal date set.

## Related credentials

- `5LhCYKsaFO3fF7II` (Anthropic) — shared across all tiers.
- `CPCSZOInV8Zj1PI1` (Gmail OAuth2) — V1 used heavily; PROD/DEV have moved to Postal but a few V1 nodes still send via this. Gmail OAuth tokens auto-refresh; if it ever expires, V1 emails stop until reauthorized.
- `ggr9QCRobQVA6Lwb` (Perplexity native node) — shared.
- `oWli4irymtVqSDyC` (Firecrawl) — shared.

## V1 webhook payload contract

Identical shape to PROD: `{user_message_request, user_id, originalUserPrompt?}`. Same hub preprocess_message + Agent pattern.

## Modification policy

- **Bug in V1?** Document it but don't fix unless customer escalation forces the issue.
- **Feature parity?** Add to PROD/DEV; let V1 remain as-is.
- **Decommission?** Requires explicit customer-by-customer migration plan + user authorization per `CLAUDE.md`.
