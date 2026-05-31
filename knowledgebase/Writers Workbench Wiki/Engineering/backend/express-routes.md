---
name: Express routes
description: Every Express route file with purpose, auth, and key endpoints.
type: concept
tags: [backend, express, routes]
last_reviewed: 2026-05-09
---

# Express routes

`server/src/routes/`. 25 route files. All registered in `server/src/index.ts`.

## health.ts

Public. `GET /api/health` — liveness + dependency checks.

```json
{"status":"ok", "version":"<sha>", "deployed_at":"<iso>", "environment":"production|development",
 "checks":{"supabase":"ok","redis":"ok","postal":"ok"}, "active_sessions": 4}
```

## chat.ts

`requireAuth` + `requireCredits('chat')`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/proxy` | POST | Classify message → sync direct call OR async BullMQ enqueue |
| `/stream/:jobId` | GET (EventSource) | SSE for a specific job (alternative to global session SSE) |

Sprint 10b-3 migration: classify via `lib/jobs/classifier`. Sync ops (list/retrieve/approve) keep the direct n8n fetch; async ops enqueue + return `{jobId, trackerRowId, status:'queued'}`.

## account.ts

`requireAuth`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/onboard` | POST | Step 1 onboarding — INSERT users_v2 row |
| `/subscribe` | POST | Step 2 onboarding — INSERT user_subscriptions |
| `/cascade-info` | GET | Counts of cascading entities for delete preview |
| `/` | DELETE | Hard delete account (cascades + supabase.auth.admin.deleteUser) |

## admin.ts

`requireAuth + requireAdmin`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/users` | GET | List users with enriched stats |
| `/users-with-subscription` | POST | Admin-create user (with optional password — auto-creates auth row v1.1.2) |
| `/users/:id` | PUT | Update user profile (legacy partial update) |
| `/users/:id/role` | POST | Canonical role-change endpoint (writes user_role_meta_v2; superuser-only for admin/superuser) |
| `/users/:id/full` | POST | Full edit: profile + email-delivery + password (creates auth row if missing — v1.1.2) |
| `/users/:id/email-prefs` | GET | Read app_config_v2 email fields for EditUserDialog |
| `/users/:id/lock` | POST | Lock account (user_account_meta_v2.account_status='locked') |
| `/users/:id/unlock` | POST | Unlock |
| `/users/:id/credits` | POST | Adjust credits (admin balance change) |
| `/users/:id/tier` | PUT | Set subscription tier (with UPSERT subscription) |
| `/metrics` | GET | 6 entity counts + content by status/type breakdown |
| `/workflows` | GET | n8n execution proxy (last 50) |
| `/storage` | GET | Storage stats per bucket |
| `/queues` | GET | BullMQ queue state (Sprint 10b-4) |
| `/email-bounces` | GET | List email_bounces_v2 |

## superuser.ts

`requireAuth + requireSuperuser`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/impersonate` | POST | Start impersonation session (INSERT impersonation_log) |
| `/impersonate/active` | GET | Current active session (if any) |
| `/impersonate/end` | POST | Mark active session ended_at |
| `/impersonate/log` | GET | Audit history |
| `/tiers` | GET / POST | List + create subscription_tiers |
| `/tiers/:id` | PUT | Update tier |
| `/tiers/:id/deactivate` | POST | Deactivate (sets publicly_selectable=false) |
| `/config` | GET / PUT | Read / write app_config_v2.sprint8_superuser_config (credit costs, etc.) |

## tiers.ts

Public — no auth. For signup pricing page.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | List `subscription_tiers WHERE publicly_selectable = true` |

## impersonate-data.ts

`requireAuth + requireSuperuser + active impersonation_log row`. ~25 endpoints mirroring every read view.

```
GET /dashboard
GET /projects[/:id]
GET /projects-summary
GET /content[/:id]
GET /research[/:id]
GET /story-bible/:projectId
GET /outline-versions[-info]/:projectId
GET /content-versions/:contentId
GET /images[/:id]
GET /social-posts
GET /trash
GET /search?q=...
GET /token-usage
GET /provenance/:contentId
GET /outlines
```

All filter by `req.userId` (= target user's id during impersonation). Service role bypasses RLS but the explicit `.eq('user_id', req.userId)` keeps scope tight.

## impersonate-write.ts

Same gate + requires `req.isImpersonating === true`. Field whitelists per resource.

```
PATCH /projects/:id
DELETE /projects/:id [+ /restore]
PATCH /content/:id
DELETE /content/:id [+ /restore]
POST /content-versions
POST /story-bible[/:id]
PATCH /research/:id
DELETE /research/:id [+ /restore]
PATCH /images/:id
PATCH /social-posts/:id
```

Every successful write appends an entry to `impersonation_log.actions_taken` (cap 500).

## credits.ts

`requireAuth`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/balance` | GET | Current credit count + period dates |
| `/pricing` | GET | Credit pricing config |
| `/transactions` | GET | Paginated audit ledger |
| `/purchase` | POST | (Placeholder) record intent + bump balance — Stripe replaces this Sprint 9 |

## cron.ts

`X-Cron-Secret` gate (currently UNSET; routes return 503).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/trial-check` | POST | Find trials expiring; flip user_subscriptions to expired |
| `/credit-reset` | POST | Monthly credit reset (every active subscription) |
| `/trial-warnings` | POST | Send 7d/3d/1d expiry-warning emails via Postal |

## chat.ts (continued — already covered above)

## jobs.ts

`requireAuth`. User-scoped jobs API.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | List user's jobs |
| `/stats` | GET | Per-status counts |
| `/:id` | GET | Job detail |
| `/:id/status` | GET | Lightweight status |
| `/:id/cancel` | POST | Cancel waiting/delayed job (server moves to failed) |

## brainstorm.ts

`requireAuth + requireCredits('brainstorm')`. Wraps n8n `Brainstorm Story` tool. Mostly used by `BrainstormForm` legacy entry.

## content-actions.ts

`requireAuth`. Sprint 12.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/:id/rewrite-with-research` | POST | Enqueues heavy-ops `rewrite_chapter_with_research` job with pre-formed prompt |
| `/:id/annotations` | GET | Merged drift + genre annotations |
| `/:id/annotations/apply` | POST | Precise span replacement + content_versions_v2 snapshot |
| `/:id/annotations/dismiss` | POST | Dismiss without mutation |

## genres.ts

`requireAuth`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Active genres + feed counts (PR #75) |
| `/:slug` | GET / PUT / DELETE | Genre CRUD with cascade-warning |

## images.ts

`requireAuth + requireTierFeature('cover_art')`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/generate` | POST | Trigger cover art via n8n Generate Cover Art tool |
| `/:id` | GET | Get generated image |
| `/` | GET | List user's images |

## export.ts

`requireAuth`. KDP `.docx` generation via `docx` library. Service role required for Storage access.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/:contentId` | POST | Generate .docx with selected page size + scope |

## email.ts

`X-Email-Secret` gate. n8n → Workbench → Postal.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/send` | POST | Postal proxy with rate-limit + DRY_RUN_EMAIL aware |

In-memory + Redis 30/min/user_id rate-limit (Sprint 11 S11-4).

## ingestion.ts

`X-Ingestion-Secret` gate. Newsletter ingestion (Newsletter S3).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/upload` | POST | Upload `{markdown, html, metadata}` → bucket + INSERT content_ingestion_v2 |
| `/search?prefix=&user_id=` | GET | Metadata listing by key prefix |
| `/get/:key` | GET | Metadata + both blobs |
| `/mine/days` | GET (auth) | List of dates with content for current user (IngestionBrowser sidebar) |

Path traversal guard: Zod regex + runtime check after URL decode.

## session.ts

`requireAuth` for register/unregister; query-token auth for events.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Eve widget mount |
| `/unregister` | DELETE | Unmount |
| `/active?user_id=` | GET | n8n probe (currently un-authenticated) |
| `/events?token=` | GET (EventSource) | SSE channel for the user |
| `/callback/content-ready` | POST | n8n→server (sub-route on the same router) |
| `/callback/events?token=` | GET | Alias for /events |

## newsletter.ts + newsletter-edition-extras.ts + newsletter-feeds.ts + newsletter-sends.ts

`requireAuth` + various.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/editions` | GET / POST | List + create editions |
| `/editions/:id` | GET / PUT / DELETE | Edition CRUD |
| `/editions/:id/feeds` | GET / POST | Feed list + add |
| `/editions/:id/feeds/:feedId` | DELETE | Remove |
| `/editions/:id/feeds/import-from-genre` | POST | PR #75 — copy feeds from genre |
| `/editions/:id/subscribers` | GET / POST | List + import (CSV) |
| `/editions/:id/subscribers/:id` | DELETE | Remove |
| `/templates` | GET / POST | List + create |
| `/templates/:id` | GET / PUT / DELETE | CRUD |
| `/templates/:id/preview` | GET | Handlebars preview merging edition data (PR #73) |
| `/render-html` | POST | Internal — Handlebars merge endpoint (called by n8n compose agent) |
| `/sends` | GET | List newsletter_sends_v2 |
| `/sends/:id` | GET / DELETE | Detail + delete |
| `/generate` | POST | Trigger compose-newsletter for an edition |
| `/cron/editions/due` | GET | Cadence cron probe — editions due for send |
| `/cron-callback` | POST (X-Newsletter-Callback-Secret) | n8n stages emit progress |
| `/approvals/open?count_only=` | GET | Sidebar badge counter (currently empty in UI) |

## approvals.ts

`X-Approval-Secret` (server-internal token routing).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/:token` | GET / POST | Token-loaded approval view + approve/reject |

## test-newsletter.ts

DEV-only scaffold for generating sample newsletters. Excluded from production.

## Common gotchas

- **Order matters:** `requireAuth` first, then Zod, then `requireCredits` (so 402 has a real user).
- **Service-role queries** must `.eq('user_id', req.userId)` — RLS bypasses for service role.
- **`X-Cron-Secret`** unset → 503. Set when external cron is wired.
- **`X-Callback-Secret`** is TODO — `/api/callback/content-ready` is currently open. Tighten before billing sprint.
- **`/api/admin/users-with-subscription` POST without password** creates a profile-only row with no auth user. Use Edit User dialog later (auto-links auth user on first password set).
