---
name: Overview
description: System synthesis for The Writers Workbench + Author Agent. Read first for the full architecture, the three-tier model, and how the surfaces fit together.
type: overview
tags: [overview, system]
last_reviewed: 2026-05-09
---

# Overview

**The Writers Workbench** is a SaaS web application — the dashboard UI for **The Author Agent**, an n8n-based AI writing automation system. Users create content (books, stories, blogs, newsletters, research) through voice (Eve via ElevenLabs) or text chat (n8n webhook). The web UI is for **viewing, editing, managing, and organizing** that content — not for creating it directly. All content creation is funneled through chat or Eve. There are no UI forms for "New Project" or "Write Blog Post."

## The two surfaces

- **Chat Drawer** — text-based, POSTs to the n8n hub webhook. Supports async (writing → email + DB write + SSE callback) and sync (list/retrieve → immediate response) modes. Lives in the top bar. See [[chat-and-eve]].
- **Eve Voice Widget** — ElevenLabs `<elevenlabs-convai>` embed widget loaded from CDN. Lives in the sidebar. See [[chat-and-eve]] and [[agents]].

## Three-tier execution model

Every layer is split into V1 / DEV / PROD. See [[tier-separation]] for the rule book.

| Layer | V1 (frozen) | DEV (active sprint work) | PROD (live customers) |
|-------|-------------|--------------------------|-----------------------|
| Database | PROD Supabase (legacy V1 schema) | DEV Supabase `gvbvwcnmjkdpclcisqrr` | PROD Supabase `faklxfakgzkpkbxfihzh` |
| n8n workflows | `… Orig` (~20 workflows) | `DEV - <name>` (~24 workflows + newsletter cluster) | `PROD - <name>` (~24 workflows) |
| n8n hub webhook | `/webhook/author_request` | `/webhook/author_request_dev` | `/webhook/author_request_v2` |
| Workbench Railway | — | `writersworkbench-develop.up.railway.app` | `writersworkbench-production.up.railway.app` |
| Eve agent | `agent_6401kjwqy66nfhabj82dvy8pnh2b` (Baseline) | `agent_0001kpr667v6ffctex0a8dt4fk71` (DEV) | `agent_2801kks580vnf5q80j3bd0n0x45v` (PROD) |
| Redis | n/a | `Redis_Dev` | `Redis` |
| Postal mail server | n/a | `writers-workbench-mail-dev` (Development — swallows mail) | `writers-workbench-mail-prod` (Live) |

## Subsystems

- **Frontend** — React 18 + TypeScript + Vite + TailwindCSS, TanStack Query, TipTap editor. See [[frontend-stack]].
- **Backend** — Express + TypeScript, Supabase JS, BullMQ workers, Postal SDK. See [[backend-stack]].
- **Database** — Supabase (PostgreSQL 17). All tables suffixed `_v2`. RLS via `get_current_user_id()` mapping `auth.uid()` → `users_v2.user_id` (the user's E.164 phone number). See [[prod-database]] / [[dev-database]] / [[base-tables]].
- **Storage** — Supabase Storage buckets for `author-content`, `cover-images`, `social-images`, `writing-samples`, `newsletter-ingestion`, `newsletter-logos`. See [[supabase-storage]].
- **Email** — Postal 3.3.5 stack on Railway. Domain `courseworx.media` with SPF + DKIM. See [[postal-mail-stack]].
- **Queue** — Redis (one instance per tier) + BullMQ priority queues (sync / medium / heavy / background). See [[redis-bullmq]] and [[job-queue]].
- **n8n** — Self-hosted at `n8n.agileadautomation.com`. Hub fans out to ~24 tool sub-workflows per tier. See [[workflow-tiers]] and [[prod-hub-and-tools]].
- **ElevenLabs** — Three Eve agents (V1, DEV, PROD) sharing voice + base personality. See [[agents]] and [[voice-and-prompts]].

## Identity model

`users_v2.user_id` is the **phone number in E.164 format** (e.g. `+14105914612`). The same `system__caller_id` ElevenLabs passes when Eve calls n8n. The web app maps `auth.users.id` (Supabase Auth UUID) → `users_v2.supabase_auth_uid` → `user_id`. All foreign keys use `user_id` (phone), not the auth UUID. See [[security-model]].

## Lifecycle of an async chat request

1. User types in [[chat-and-eve|ChatDrawer]] → `POST /api/chat/proxy {user_message_request, caller_id}`.
2. Server [[classifier-and-priority|classifies]] the message → priority tier (sync/medium/heavy/background).
3. **Sync ops** (list/retrieve/approve) call the n8n hub directly and return.
4. **Async ops** (write/brainstorm/generate) → [[job-queue|BullMQ tracked job]] enqueued; server returns `{jobId, trackerRowId}` immediately.
5. Worker dequeues → POSTs to n8n hub `/webhook/author_request_{v2|dev}`.
6. n8n hub routes via Gemini Agent → tool sub-workflow → Claude Sonnet → DB write + Supabase Storage + email.
7. n8n calls back to `/api/callback/content-ready` (web session) OR phone (Eve outbound).
8. Server pushes [[session-and-sse|SSE event]] to client; chat drawer pill flips Queued → Processing → Complete.

## Recent + active sprints

- **v1.1.2** in flight — admin-create user + auth-link hotfix (PR pending).
- **Newsletter cluster** (S1–S5 + flow fixes + fan-out + cadence + bounces + CSV) shipped DEV-only via PRs #69, #70, #72, #73, #74, #75. PROD migration pending. See [[newsletter-cluster]].
- **Sprint 8** (RBAC + tiers + credits + impersonation, 55 pts) released v1.1.0. See [[sprint-8-rbac]].
- **Sprint 10.a** tier separation. See [[sprint-10a-tier-separation]].
- **Sprint 10.b** Redis + BullMQ. See [[sprint-10b-bullmq]].
- **Sprint 11** Postal email migration (DEV-complete). See [[sprint-11-postal]].
- **Sprint 12** Tracks B+C: rewrite-with-research, drift scanner, annotations UI. Track A deferred to Sprints 16/17/18. See [[sprint-12-chapter-tools]].
- **Hotfix 2026-04-29** story-bible extraction — see [[hotfixes]].
- **Planned** — Sprint 9 (Stripe), Sprint 14 (storage decision), Sprint 15 (load test), Sprints 16–18 (chapter writer multi-instance architecture). See [[planned-sprints]].

## What this wiki captures

Everything needed to make code or architecture changes without re-reading [SESSION_CONTEXT.md](../../writers-workbench/SESSION_CONTEXT.md). Indexed in [[index]]. Schema in [[CLAUDE]]. Activity log in [[log]].
