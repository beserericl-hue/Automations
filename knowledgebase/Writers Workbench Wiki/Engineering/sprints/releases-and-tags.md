---
name: Releases and tags
description: v1.0.0 (2026-04-17), v1.1.0 (2026-04-28), v1.1.1 (2026-04-28), v1.1.2 (in flight). Tagged on main; PROD Railway deploys from release/v1.0.
type: concept
tags: [sprints, releases, ops]
last_reviewed: 2026-05-09
---

# Releases and tags

## v1.0.0

**Tag:** `v1.0.0`
**Released:** 2026-04-17
**Branch:** `main` (production)

First production release. PROD Railway started deploying.

**Scope:**
- Sprints 0-7 complete (52 stories, 204 points).
- 338 automated tests passing.
- Sprint 8 (RBAC) and Sprint 9 (Stripe) planned but not implemented.
- Sprint 10 (environment separation + CI/CD) in progress — this release is the prerequisite baseline.

**Branching policy effective from this release:**
- `main` — production baseline. Railway production env auto-deploys from `release/v1.0` (which advances to match `main` at each release).
- `develop` — integration branch.
- Feature branches → develop. Release branches → main.
- Hotfixes from main, cherry-pick to develop.

**Deployed:**
- PROD Railway tracks `main` (v1.0.0).
- Supabase V2 (unchanged): `https://faklxfakgzkpkbxfihzh.supabase.co`.
- n8n V2 hub: `roMDypuMXHv6ugaZ`.
- ElevenLabs Beta agent: `agent_2801kks580vnf5q80j3bd0n0x45v`.

## v1.1.0

**Tag:** `v1.1.0`
**Released:** 2026-04-28
**Merge commit:** `f392403` (PR #56 — release/v1.1 → main)

First release on the v1.1 line.

**Scope:**
- **Sprint 8** — RBAC + 5 subscription tiers + credit ledger + chat-proxy deduction + 402 + exhaustion modal + superuser impersonation full read AND write data plane + trial cron + Postal warning emails + AdminPanel rebuild (7 tabs, inline edit/lock/credits/impersonate/set-tier).
- **Sprint 10.a** — V1/DEV/PROD tier separation. CLAUDE.md governance. `scripts/check-base-table-immutability.py` CI.
- **Sprint 10.b** — Redis + BullMQ + per-user concurrency + SSE pub/sub. ~50% latency reduction on chat heavy ops.
- **Sprint 11** — Postal email migration (14/14 PROD email workflows on Postal) + rate limiter + bounce handling.
- **Onboarding tour** — anchored, spotlight-cutout product tour. `data-tour` attributes everywhere. Replaces centered-modal tutorial.
- **Admin tier-assignment fixes** — Set Tier dialog covering all 5 tiers including comp; UPSERT subscription endpoint; "no money charged" copy on admin balance adjustments.
- **Newsletter sprints S1-S4 + per-user ingestion** (parallel work that landed during Sprint 8).
- **Side sprint PR #55** — per-user ingestion URLs + admin/superuser ingestion read.

**Migrations applied to PROD at this release:**
- Migration 011 (Sprint 8 — 6 new tables + helper functions + escalation trigger).
- Migration 012 (newsletter editions schema).
- All previous migrations (008-010 via Sprint 10b/Newsletter).

**Critical for Railway deploy:** PROD Railway watches `release/v1.0` (NOT `main`). Release-day step:

```bash
git push origin main:release/v1.0
```

Branch name is misleading — it carries v1.1 but Railway watches it.

**Post-copy fixes during release** (caught + fixed before user traffic):
- `N8N_HUB_WEBHOOK_URL` had `_dev` on PROD (would have routed real chats to DEV n8n hub → DEV Supabase). Fixed.
- `SENDER_NAME=The Writers Workbench (Dev)` would have appeared in real users' From line. Fixed.

**Auth issue surfaced + diagnosed during release:**
- Site URL on both Supabase projects was factory default `http://localhost:3000` → password-reset / magic-link emails embed dead address.
- Admin-reset Eric's + JR's passwords via service-role.
- Fix in Supabase Dashboard pending. See [[hotfixes]].

## v1.1.1

**Tag:** `v1.1.1`
**Released:** 2026-04-28 (same day as v1.1.0)
**Merge commit:** `462a0a9` (PR #57)
**Deploy:** PROD via `release/v1.0` ratchet at 19:13:38 UTC.

Quick hotfix on top of v1.1.0:

- `<PasswordInput>` reusable component with eye-icon show/hide + autoComplete pass-through.
- All 6 password inputs replaced (LoginPage, SignupPage ×2, ResetPasswordPage ×2, Settings → Change Password). autoComplete: `current-password` for login, `new-password` everywhere else.
- `POST /api/admin/users/:id/full` — covers display_name + email + recipient_email + bcc_email + password in one call. Per-field whitelisted updates with per-field result for partial-success toasts.
- `GET /api/admin/users/:id/email-prefs` — populates new fields when EditUserDialog opens.
- AdminPanel `EditUserDialog` rewritten — three fieldsets (Profile / Email delivery / Password). Password section collapsed behind "Reset this user's password" button.

**Lesson:** Playwright `getByLabel('Password')` does substring matching by default. When a toggle button has `aria-label="Show password"`, it matches both. Use `getByLabel('Password', { exact: true })`. Don't change the toggle label — "Show password" / "Hide password" is correct SR experience.

**Tests:** 556/556 unit, all 4 required CI checks green, E2E pass on second push after test selector fix. Squash-merged via admin override (develop branch protection blocks self-approve).

## v1.1.2 (in flight)

**Status:** Coded on `develop`, pending hotfix → main.

**Bug surfaced on PROD:** User opened Admin → Edit User on PROD for JR, set password + email, hit Save. `users_v2.email` and `app_config_v2.recipient_email` rows persisted but password didn't, and `auth.users` had no row for that email.

**Root cause:** `POST /api/admin/users-with-subscription` only inserts into `users_v2`. When admin then opened Edit User and set a password, the route saw `existing.supabase_auth_uid === null` and returned `password: { ok: false, error: 'User has no linked Supabase Auth UUID' }`. Toast said "Saved with 1 issue: ..." — easy to miss given how unobtrusive the partial-failure framing is.

**Fix (committed to develop, pending hotfix → PROD):**

- `POST /admin/users/:id/full` — when password provided AND `supabase_auth_uid IS NULL`, calls `supabase.auth.admin.createUser` + writes UID back. Returns `note: 'Created Supabase Auth account and linked it'`.
- `POST /admin/users-with-subscription` + `CreateUserWithSubscriptionSchema` — accept optional `password` (≥ 8 chars). When supplied, route creates auth user before users_v2 insert + rolls back on failure.
- AdminPanel Create User form — added password + confirm fields with inline validation.
- EditUserDialog toast — surfaces `note` field.

**JR's account on PROD repaired** during the session via service-role:
1. `POST /auth/v1/admin/users` `{email:'racemert@yahoo.com', password:'Wr!ters1', email_confirm:true}` → UID `3657ca48-...`.
2. `PATCH /rest/v1/users_v2?user_id=eq.+17063338699` set supabase_auth_uid.
3. `POST /auth/v1/token?grant_type=password` smoke test → valid access_token. JR can sign in.

**Google OAuth** — separate finding. `/auth/v1/settings` on both PROD + DEV returns `external.google: false`. Provider not configured in Supabase Dashboard. Button hidden behind `VITE_GOOGLE_OAUTH_ENABLED` flag (default false). To enable:
1. Google Cloud → Credentials → OAuth 2.0 Web client.
2. Authorized redirect URIs: `https://faklxfakgzkpkbxfihzh.supabase.co/auth/v1/callback` (PROD) + DEV equivalent.
3. Paste Client ID + Secret into Supabase Auth → Providers → Google → Enable.
4. `VITE_GOOGLE_OAUTH_ENABLED=true` on Railway. Redeploy.

## Hotfix v1.1.x — Story-bible extraction

**Released:** 2026-04-29 (after v1.1.1).
**PR:** [#71](https://github.com/beserericl-hue/Automations/pull/71)
**Merge commit:** `d55baaf` (main HEAD as of 2026-05-09).

See [[hotfixes]].

## Branch state at end of 2026-05-09 session

- `main` HEAD: `d55baaf` (hotfix story-bible-extraction merge).
- `develop` HEAD: `3945761` (PR #75 — EditionEditor genre dropdown).
- `release/v1.0` HEAD: `d55baaf` (advanced post-hotfix).
- Open PRs: only #68 (stale — its work landed via #69; should be closed).

## Release runbook (next time)

When cutting `release/v1.2`:

1. From `develop`, branch `release/v1.2`.
2. Decide which migrations need to apply to PROD Supabase (013, 014, 016, 017 are pending).
3. Apply migrations idempotently via session pooler.
4. Audit Railway env vars per [[env-vars-by-tier]] — CRITICAL: don't blanket-copy DEV→PROD, audit field-by-field. Most-bitten ones: `N8N_HUB_WEBHOOK_URL`, `SENDER_NAME`, `NODE_ENV`, `ALLOWED_ORIGINS`.
5. Run `scripts/promote-dev-to-prod.py --apply` for n8n workflows. Reads workflow-id-map.json. Reverses the DEV→PROD transformations.
6. Promotion log in `writers-workbench/workflows/promotion-log.md`.
7. PR `release/v1.2` → `main`.
8. Merge (admin override OK since develop branch protection blocks self-approve).
9. Tag `v1.2.0` on main.
10. **Push to release/v1.0** so Railway deploys: `git push origin main:release/v1.0`.
11. Verify `/api/health` on PROD reports new SHA + new `checks` shape if S10b-1+ added a check.
12. Smoke test critical paths.
13. Sync develop with main: `git checkout develop && git merge main --ff-only && git push`.

If anything breaks, hotfix-flow: branch off `main`, fix, PR back to main, cherry-pick to develop. See [[hotfix-flow]].
