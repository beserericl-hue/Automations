---
name: Security model
description: Auth, RLS, RBAC, impersonation, secrets, branch protection. Where each layer protects what.
type: concept
tags: [security, auth, rls, rbac]
last_reviewed: 2026-05-09
---

# Security model

Defense in depth: Supabase Auth → Postgres RLS → Express middleware → ACL-in-code on service-role paths.

## Authentication

- **Supabase Auth** — email/password (primary) + Google OAuth (gated by `VITE_GOOGLE_OAUTH_ENABLED=true`; currently disabled on both tiers because Google provider isn't configured in Supabase Dashboard).
- **`auth.users.id`** is a UUID. Mapped to `users_v2.user_id` (E.164 phone) via `users_v2.supabase_auth_uid`.
- **Onboarding flow** (`/onboarding`): if a logged-in `auth.users` row has no `users_v2` companion, route through profile + tier-selection screens; on completion `INSERT INTO users_v2 + INSERT INTO user_subscriptions`.
- **Admin-create** (`POST /api/admin/users-with-subscription`) — admin enters email + optional password. If password supplied, server creates the Supabase Auth user via `supabase.auth.admin.createUser` and links the UUID. If skipped, the profile is dangling until admin sets a password later (Edit User dialog auto-creates the auth row at that point — Sprint 8 v1.1.2 hotfix).

## Row-Level Security (RLS)

Enabled on every `*_v2` table. Policy template:

```sql
CREATE POLICY <name> ON <table>
  FOR SELECT USING (user_id = get_current_user_id());
```

`get_current_user_id()` is a SQL function:

```sql
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT user_id FROM users_v2 WHERE supabase_auth_uid = auth.uid()
$$;
```

Service role bypasses RLS. Routes that use the service-role client MUST add `.eq('user_id', req.userId)` (where `req.userId` is the impersonation-aware id from `requireAuth`).

Public-read tables (selectable without auth):
- `genre_config_v2` where `is_public = true`
- `story_arcs_v2` where `is_public = true`
- `subscription_tiers` where `publicly_selectable = true` (for signup pricing page)

## RBAC (Sprint 8)

Three-level hierarchy:

| Role | Source of truth | Can do |
|------|-----------------|--------|
| `user` | `users_v2.role = 'user'` (legacy) AND no `user_role_meta_v2` row | Self-scoped operations only |
| `admin` | `user_role_meta_v2.role = 'admin'` | All admin endpoints (`/api/admin/*`) — user CRUD, tier set, email bounces, queue/metrics dashboards |
| `superuser` | `user_role_meta_v2.role = 'superuser'` | Everything `admin` can + impersonation, tier management, system config (`/api/superuser/*`) |

`get_user_effective_role_v2(p_user_id)` — `COALESCE(meta.role, legacy, 'user')`. Use this in policies and middleware; the legacy column's CHECK constraint can't store `'superuser'` so it's always `admin` for superusers.

Server middleware:
- `requireAuth` — loads the effective role. Blocks `account_status != 'active'` (superuser bypass).
- `requireAdmin` — role IN admin/superuser.
- `requireSuperuser` — strict superuser.
- `requireTierFeature(name)` — subscription.tier.features[name].
- `requireCredits(opName)` — pre-flight 402 if exhausted.

Trigger `prevent_role_meta_escalation` blocks non-superuser callers from `INSERT/UPDATE/DELETE` on `user_role_meta_v2`. Service role bypasses (auth.uid() IS NULL).

## Impersonation

Superuser-only. End-to-end flow:

```
1. Superuser calls POST /api/superuser/impersonate {target_user_id, reason}
   → server inserts impersonation_log row (UNIQUE active session per superuser via partial index)
2. Client UserContext flips isImpersonating=true; sets X-Impersonate-User header on subsequent apiFetch calls
3. requireAuth on every request:
   - If X-Impersonate-User AND caller is superuser AND active impersonation_log row:
     - req.userId = target user's id
     - req.isImpersonating = true
4. /api/impersonate/data/* (read paths) — returns target user's data via service role + .eq('user_id', req.userId)
5. /api/impersonate/write/* (write paths) — only allowed when req.isImpersonating === true
   - field whitelist per resource
   - on success: append entry to impersonation_log.actions_taken (cap 500)
6. End impersonation: POST /api/superuser/impersonate/end → mark log row ended
```

Surfaced views during impersonation: Dashboard, ProjectList, ProjectDetail (8 tabs incl. nested data), ContentLibrary, ContentDetail, ResearchList/Detail, ImageGallery/Detail, SocialMediaPanel, StoryBiblePanel, TrashView, OutlineList, VersionHistory, ProvenancePanel, CostDashboard, Sidebar projects, TopBar breadcrumb + global search.

Surfaced writes: ProjectEditForm, ProjectDetail delete (cascade), ContentDetail save/status/schedule/cover/delete + content_versions snapshot, StoryBible CRUD, ResearchDetail save/delete, ResearchList delete, TrashView restore, ContentLibrary bulk approve/publish/delete (per-id audit), AnnotationsPanel apply/dismiss.

Banner shown on every page during active impersonation. Audit trail in `impersonation_log` table.

## Secrets

| Secret | Lives in | Used by |
|--------|----------|---------|
| `SUPABASE_SERVICE_ROLE_KEY` | Railway env (per service) | Express server only — never bundled |
| `VITE_SUPABASE_ANON_KEY` | Railway env | Client bundle — public (RLS protects) |
| `EMAIL_SECRET` | Railway env | n8n→Express `/api/email/send` (`X-Email-Secret`) |
| `INGESTION_SECRET` | Railway env | n8n→Express `/api/ingestion/*` (`X-Ingestion-Secret`) |
| `APPROVAL_SECRET` | Railway env | n8n→Express `/api/approvals/*` (`X-Approval-Secret`) |
| `NEWSLETTER_CALLBACK_SECRET` | Railway env | n8n→Express `/api/newsletter/cron-callback` |
| `CRON_SECRET` | (UNSET — TODO) | external scheduler → `/api/cron/*` (`X-Cron-Secret`) |
| `N8N_API_KEY` | `.mcp.json` (gitignored) + `writers-workbench/.env` | Manual scripts, mcp-n8n |
| `POSTAL_API_KEY` | Railway env per tier | `lib/email.ts` |
| `KIEAI_API_KEY` | n8n credential + Railway env | Cover art workflow |
| `ELEVENLABS_API_KEY` | n8n credential + scripts | Eve agent admin, knowledge upload |

n8n credentials (don't appear in workflow JSON; referenced by id):
- Anthropic — `5LhCYKsaFO3fF7II`
- Perplexity (native node) — `ggr9QCRobQVA6Lwb`
- Gmail OAuth2 — `CPCSZOInV8Zj1PI1` (used by V1 + (still) PROD newsletter agent until promotion)
- OpenAI native — `xSzPIySN61drme77`
- OpenAI httpHeaderAuth — `BZku8v1a2K12iFGQ` (BROKEN, do not use)
- Firecrawl — `oWli4irymtVqSDyC`
- DEV Workbench Email Secret — `kxrSg24PIR2Npfvw`
- DEV Workbench Ingestion Secret — `jQBRJbmiUeTk8c11`
- DEV Workbench Approval Secret — `ytjKAO1BESVf6Cnz`

## Branch protection

`main`: 4 required status checks (`TypeScript & Lint`, `Unit Tests`, `Production Build`, `Schema Governance Check`). PR author cannot self-approve (admin override is the documented escape hatch — see PR #40, #50, #51 precedents). Direct push blocked.

`develop`: 1 approving review required. Same self-approve restriction. Admin override used in practice for stacked-PR chains.

## Known security TODOs

- Set Supabase **Site URL + Redirect URLs** on both projects (factory default `http://localhost:3000` breaks password reset). See [[hotfixes]].
- Set `CRON_SECRET` on both Railway services when external cron is wired.
- Stripe webhook signing (Sprint 9 — planned).
- Refresh-token rotation policy — currently default Supabase (60 days). Documented in [[env-vars-by-tier]].
- Annotation-apply currently uses `text.split(target).join(replacement)` — replaces all occurrences. Could over-match if a target string appears in unintended places. Snapshot to `content_versions_v2` before mutation mitigates.
