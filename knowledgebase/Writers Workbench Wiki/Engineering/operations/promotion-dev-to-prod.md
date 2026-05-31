---
name: Promotion DEV → PROD
description: Release-day runbook. Apply migrations, audit env vars, run promote script, deploy.
type: concept
tags: [operations, promotion, release]
last_reviewed: 2026-05-09
---

# Promotion DEV → PROD

The release-day procedure. Triggered when:
- Feature work merged to `develop`
- `release/vX.Y` branch cut from `develop`
- PR from `release/*` merged to `main`

Promotion happens at the same moment for: schema, n8n workflows, n8n credentials, Railway env vars, ElevenLabs (rare).

## Pre-flight

Before any production change:

1. **Verify DEV is green.**
   ```bash
   curl https://writersworkbench-develop.up.railway.app/api/health
   ```
   Expect `{status:'ok', checks:{supabase:'ok', redis:'ok', postal:'ok'}}`.

2. **Run env-isolation check.**
   ```bash
   python3 scripts/verify-env-isolation.py
   ```
   3 layers must all pass.

3. **Smoke test critical paths on DEV.**
   - Login → Dashboard → write a chapter → see in library.
   - Newsletter generation if part of release.

4. **Inventory pending PROD migrations.**
   ```bash
   ls writers-workbench/migrations/ | sort
   # diff against PROD migrations applied (consult dashboard or pg_dump)
   ```

## Step 1 — Apply DB migrations to PROD

For each pending migration in order:

```bash
PGPASSWORD=<PROD_PASSWORD> /usr/local/opt/postgresql@17/bin/psql \
  "postgresql://postgres.faklxfakgzkpkbxfihzh:...@aws-0-us-west-2.pooler.supabase.com:5432/postgres" \
  -f writers-workbench/migrations/<NNN_topic.sql>
```

Each migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`, etc.) — re-applying is safe.

**Pending as of 2026-05-09:** 013, 014, 016, 017 (newsletter cluster). **UPDATE 2026-05-28:** 013/014/015/016/017 all applied to PROD + verified. See [[newsletter-prod-ship-runbook]] for the newsletter-specific procedure — those 4 workflows have no PROD pair, so the standard `promote-dev-to-prod.py` (UPDATE-in-place) does NOT cover them; they must be created.

After each, verify:
```sql
\dt newsletter_*
SELECT count(*) FROM newsletter_editions_v2;   -- 0 expected if no PROD users on it yet
```

## Step 2 — Audit env vars

**Critical:** never blanket-copy DEV→PROD. Audit field-by-field. See [[env-vars-by-tier]].

Tier-sensitive (DO NOT copy):
- `ALLOWED_ORIGINS` → match service URL
- `NODE_ENV` → `production`
- `SUPABASE_URL` / keys → PROD Supabase
- `VITE_N8N_WEBHOOK_URL` / `N8N_HUB_WEBHOOK_URL` → `_v2` suffix
- `SENDER_NAME` → no `(Dev)` suffix

If new secrets are introduced in this release (`CRON_SECRET`, etc.), set on PROD service before workflow promotion (otherwise n8n calls 503).

## Step 3 — Create PROD-tier n8n credentials

If the release introduces new shared secrets (e.g. for newsletter cluster):

1. In n8n UI: Credentials → Create new → `httpHeaderAuth`.
2. Header name: `X-<Whatever>-Secret`. Value: matches PROD Railway env var.
3. Repeat for each new secret.
4. Note the credential IDs — needed for the `promote-dev-to-prod.py` config (or hardcoded in workflow JSON).

Existing PROD credentials per [[credentials-map]].

## Step 4 — Promote workflows

```bash
# Dry run first
python3 scripts/promote-dev-to-prod.py --dry-run

# If clean
python3 scripts/promote-dev-to-prod.py --apply
```

What the script does for each workflow in [[workflow-id-map]]:

1. Diff `DEV - X` vs `PROD - X`.
2. If different:
   - Deactivate `PROD - X` (returns 403 in n8n 2.x, ignored).
   - Copy DEV's `nodes` + `connections` + `settings.executionOrder` onto PROD id.
   - Substitute Supabase URL/key DEV→PROD (regex replace in Set/Code nodes).
   - Rewrite webhook paths `_dev` → `_v2` and `-dev` → `-v2`.
   - Rewire `executeWorkflow` / `toolWorkflow` refs DEV ids → PROD ids.
   - Rewire credential references (only the per-tier ones — Email/Ingestion/Approval).
   - Reactivate PROD.
3. Append entry to `writers-workbench/workflows/promotion-log.md`.
4. Verify by triggering a smoke op.

PROD workflow ids never change. Downstream `executeWorkflow` references in OTHER PROD workflows still resolve correctly.

## Step 5 — Verify n8n

```bash
# Should see 24 PROD - … workflows all active
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.agileadautomation.com/api/v1/workflows?limit=250" \
  | jq '.data[] | select(.name | startswith("PROD - ")) | {name, id, active}' | head -50
```

## Step 6 — Promote ElevenLabs (rare)

Eve agents typically don't change per-release. If they do (system prompt update, voice change):

1. Edit `agent_2801kks580vnf5q80j3bd0n0x45v` (PROD Eve) via ElevenLabs Dashboard.
2. Update voice settings + system prompt + tool list.
3. Mirror change to DEV agent (`agent_0001kpr667v6ffctex0a8dt4fk71`) so they don't drift.

NEVER modify `agent_6401kjwqy66nfhabj82dvy8pnh2b` (V1 Baseline) — frozen.

## Step 7 — Cut release + deploy

```bash
# In a fresh worktree
git checkout main
git merge release/v1.2 --no-ff
git tag v1.2.0
git push origin main v1.2.0

# Advance Railway deploy ref
git push origin main:release/v1.0
```

Railway watches `release/v1.0`; the push triggers PROD deploy (~3 min).

## Step 8 — Verify deploy

```bash
curl https://writersworkbench-production.up.railway.app/api/health | jq
```

Expect:
```json
{
  "status":"ok",
  "version":"<new-sha>",
  "deployed_at":"<recent-iso>",
  "environment":"production",
  "checks":{"supabase":"ok","redis":"ok","postal":"ok"},
  "active_sessions":<n>
}
```

If new check added in release (e.g. `checks.stripe` for Sprint 9), verify it appears.

## Step 9 — Smoke test PROD

Critical paths:
1. Login as Eric (`+14105914612`).
2. Dashboard renders.
3. Open *The Invisible Wall*.
4. Open Story Bible tab → 43 entries visible.
5. Open chapter 7 → AnnotationsPanel shows (drift / genre eval).
6. ChatDrawer → "list my outlines" → result.
7. Newsletter (if newsletter cluster promoted) → My Newsletters → editions list.
8. Settings → theme toggle.
9. Sign out + sign in.

Document any anomalies for follow-up.

## Step 10 — Sync develop with main

```bash
git checkout develop
git merge main --ff-only
git push origin develop
```

Brings any post-merge fixes (branch back-ports) into develop.

## Step 11 — Update SESSION_CONTEXT + this wiki

Append a session entry to `writers-workbench/SESSION_CONTEXT.md` documenting:
- Migration numbers applied
- Workflow IDs promoted
- Env vars added/changed
- Smoke results
- Known issues

Update [[releases-and-tags]] with the tag + commit + scope.

## Step 12 — Notify

If user-facing changes: post in user channel + send announcement email.

## Rollback

If something breaks post-deploy:

1. **Workbench code:**
   - Roll back Railway deploy: `git push origin main:release/v1.0 --force` to a prior SHA. (Force push acceptable here because the branch is a deploy ref, not a code ref.)
   - Or trigger a new deploy from a prior commit on `main` (less invasive).

2. **n8n workflows:**
   - n8n keeps version history per workflow. UI: Workflow → Versions → restore prior.
   - Or re-run `promote-dev-to-prod.py` from a known-good DEV state.

3. **Database migrations:**
   - DDL changes are not reversible automatically. If you must roll back:
     - For new tables: `DROP TABLE …` (but this loses data).
     - For altered tables: write a new migration that compensates.
   - Better: mark the migration disabled (rename the file with a note) + re-deploy code that doesn't depend on it.

4. **Env vars:**
   - Just edit Railway dashboard + redeploy.

## Known release-day gotchas

- **Cross-tier wiring** (`N8N_HUB_WEBHOOK_URL=…_dev` on PROD) — caught at v1.1.0. Audit env vars field-by-field.
- **`SENDER_NAME=… (Dev)`** copied to PROD — cosmetic. Audit display strings too.
- **Auth Site URL factory default** `localhost:3000` — fix in Supabase Dashboard. Pending as of 2026-05-09.
- **`pg_dump` version mismatch** — PG17 server, PG15 client fails. Use `postgresql@17` brew cask.
- **Direct `db.<ref>.supabase.co`** is IPv6-only on new projects. Use session-pooler URI.
- **n8n PUT rejects most settings keys** — only `executionOrder` accepted.
- **n8n 2.x activeVersion** is a snapshot — refresh + Publish in UI after PUT, or `deactivate → PUT → activate`.
- **`workflowId` collisions** when cloning — `clone-prod-to-dev.py` regenerates.
- **Schema editor changes don't appear in `migrations/`** — `pg_dump --schema-only` drift check before any clone.
