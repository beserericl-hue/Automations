---
name: Glossary
description: Domain terms, acronyms, and identifiers used across this project's wiki and codebase.
type: glossary
last_reviewed: 2026-05-09
---

# Glossary

## Tiers + identity

- **V1 (Orig)** — original 2025 baseline. Frozen. Workflows suffixed `... Orig`. Webhook `/webhook/author_request`. Baseline Eve agent.
- **PROD** — production tier (live customers). Workflows prefixed `PROD - `. Webhook `/webhook/author_request_v2`. PROD Supabase `faklxfakgzkpkbxfihzh`. See [[tier-separation]].
- **DEV** — development tier (sprint work). Workflows prefixed `DEV - `. Webhook `/webhook/author_request_dev`. DEV Supabase `gvbvwcnmjkdpclcisqrr`.
- **`user_id`** — phone number in E.164 (e.g. `+14105914612`). Foreign key everywhere in `*_v2` tables. NOT the Supabase Auth UUID.
- **`supabase_auth_uid`** — UUID from `auth.users`. Linked to `users_v2.user_id` via the `supabase_auth_uid` column. RLS uses `get_current_user_id()` to translate.
- **system__caller_id** — ElevenLabs's name for the phone number Eve passes to n8n. Same as `user_id`.

## Subsystems + components

- **Hub** — `PROD - The Author Agent` (workflow id `roMDypuMXHv6ugaZ`) / `DEV - The Author Agent` (`FLA6xIDEvejihQLP`). Receives webhook payload, runs Gemini 2.5 Flash agent, dispatches to tool sub-workflows. See [[prod-hub-and-tools]].
- **Tool workflow** — sub-workflow callable from the hub via `executeWorkflow` or as an `ai_tool`. Pattern documented in [[tool-workflow-pattern]].
- **Worker - Write Chapter** — heavy chapter-generation workflow (`PROD: VxO2eG6uvImqaPA2`, `DEV: fsKRGkzphWT62rja`). Sub-chapter parallelism + continuity merge. See [[chapter-writer-architecture]].
- **Eve** — voice agent (ElevenLabs). Three flavors: V1 baseline, DEV, PROD. See [[agents]].
- **Postal** — Mail server stack (`postal-web`, `postal-mariadb`, `postal-worker`) for email delivery. Replaces Gmail. See [[postal-mail-stack]].
- **BullMQ** — Redis-backed job queue. Four named queues (sync-ops, medium-ops, heavy-ops, background-ops). See [[job-queue]].

## Data model

- **base tables** — the 9 immutable tables (7 named + `content_versions_v2` + `outline_versions_v2`). See [[base-tables]] and `writers-workbench/docs/schema-governance.md`.
- **meta table** — sibling table with FK to a base table; the only legal way to extend a base entity. Pattern: `<feature>_v2` table with PK = `user_id` (or composite). See [[base-tables]].
- **`writing_projects_v2`** — functional root; contains `outline` JSONB which holds the chapter list, characters, and scanner exclusions.
- **`published_content_v2`** — chapters, blogs, newsletters, short stories, social posts. Body lives in `content_text` (NOT `content`).
- **`story_bible_v2`** — characters / events / items / locations per project. Populated by `extract_bible_*` chain in worker. See [[hotfixes]].
- **`outline_versions_v2`** — auto-snapshot via Postgres trigger when `writing_projects_v2.outline` changes (Sprint 3).
- **`content_versions_v2`** — manual snapshot before destructive content edits (annotation apply, etc.).

## Sprint terminology

- **Track A / B / C** — Sprint 12 sub-tracks. A = parallelism + perf (deferred to 16/17/18). B = rewrite-with-research, research pipeline, context builder. C = genre eval, drift scanner, annotations UI.
- **shadow mode** — run new architecture in parallel with the existing one for a week before traffic-shifting (Sprint 18).
- **Anthropic token budget** — Redis-backed sliding-window gatekeeper that replaces the per-chapter `rate_limit_delay` Wait node (Sprints 17/18). See [[planned-sprints]].

## Operations terms

- **promotion** — DEV → PROD transition at release time. Run via `scripts/promote-dev-to-prod.py`. See [[promotion-dev-to-prod]].
- **hotfix** — direct PROD edit + mirror back to DEV. See [[hotfix-flow]].
- **deactivate → PUT → activate** — required cycle for n8n workflow updates so `activeVersion` rebuilds. See [[tool-workflow-pattern]].
- **Publish (n8n 2.x)** — refresh workflow tab → click Publish (⌘P) to apply REST API changes. Without it, runtime keeps old `activeVersion`.

## External services

- **Anthropic** — Claude Sonnet 4.5 (writing) + Opus (deep tasks).
- **Gemini 2.5 Flash** — hub Agent LLM. Cheap + low latency for tool routing.
- **Perplexity** — research tool (native n8n node, credential `ggr9QCRobQVA6Lwb`).
- **Firecrawl** — scrape URL credential `oWli4irymtVqSDyC`.
- **OpenAI** — DALL-E 3 (older) and image generation. Native creds `xSzPIySN61drme77`. Old `httpHeaderAuth` cred `BZku8v1a2K12iFGQ` is broken — DO NOT use.
- **KIE.AI** — newer cover art generator. `KIEAI_API_KEY` env var.
- **Postal** — `postal-admin.courseworx.media` ; API key per mail server.
- **Stripe** — Sprint 9 (planned). Not yet integrated.
