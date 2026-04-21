# Project Rules

## BASELINE PROTECTION — MANDATORY, NO EXCEPTIONS

**NEVER modify baseline/production resources without explicit user permission.** This includes:

### Tier 1 — Historical baseline (V1, frozen)

- **ElevenLabs baseline agent** (`Writing Assistant`, agent ID: `agent_6401kjwqy66nfhabj82dvy8pnh2b`) — DO NOT change its tools, webhook URL, prompt, or any configuration
- **n8n V1 workflows** (original workflow IDs listed in MEMORY.md) — DO NOT update, deactivate, or delete any original workflow
- **n8n V1 webhook** (`/webhook/author_request`) — DO NOT modify or redirect

### Tier 2 — PROD workflows (frozen except at release or hotfix)

As of Sprint 10.a (2026-04-20), the 24 active **PROD - &lt;name&gt;** n8n workflows are the production tier. Live users of the production Writer's Workbench (`writersworkbench-production.up.railway.app`) depend on them.

- **PROD hub**: `PROD - The Author Agent` (workflow id `roMDypuMXHv6ugaZ`, webhook `/webhook/author_request_v2`)
- **PROD tool workflows**: 23 others — see [`scripts/workflow-id-map.json`](scripts/workflow-id-map.json) (keys column)
- **PROD ElevenLabs agent** (`agent_2801kks580vnf5q80j3bd0n0x45v`) — currently the production Eve

**Do NOT edit PROD workflows during a sprint.** All sprint work goes on matching `DEV - &lt;name&gt;` copies (see below). Changes flow DEV → PROD only via the promotion process described in `writers-workbench/docs/workflow-governance.md`. Hotfixes may be applied directly to PROD (with the same change mirrored back to DEV so they don't drift).

### Tier 3 — PROD Supabase

- **PROD Supabase** = project `faklxfakgzkpkbxfihzh.supabase.co` (labeled "Writers Assistant PROD" in dashboard)
- DO NOT drop, alter, or delete data without permission
- Schema changes go through numbered migration files in `writers-workbench/migrations/`, reviewed before applying
- **Base tables are immutable** — the seven base tables (`users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `genre_config_v2`, `story_arcs_v2`) plus `content_versions_v2` / `outline_versions_v2` may not be `ALTER`-ed, `DROP`-ed, or renamed in any migration numbered 008+. Migrations 001–007 are frozen. New per-feature attributes live in meta tables with FKs. Enforced by CI (`scripts/check-base-table-immutability.py`). Full rules: [writers-workbench/docs/schema-governance.md](writers-workbench/docs/schema-governance.md)

### Where development work happens (DEV tier)

- **DEV Supabase**: project `gvbvwcnmjkdpclcisqrr.supabase.co` (labeled "Writers Assistant DEV") — populated as a clone of PROD for realistic test data; not a replacement for PROD
- **DEV hub**: `DEV - The Author Agent` (webhook `/webhook/author_request_dev`)
- **DEV tool workflows**: one `DEV - &lt;name&gt;` per PROD workflow (mapping in [`scripts/workflow-id-map.json`](scripts/workflow-id-map.json))
- DEV workflows are consumed by the dev Writer's Workbench at `writersworkbenchdev-production.up.railway.app`
- DEV copies point at DEV Supabase; their `executeWorkflow` refs point only at sibling DEV workflows (never into PROD)

### If a subagent or automated process needs to touch ANY PROD resource, STOP and ask the user first.

### Railway env vars that must match the tier

Some env vars are tier-specific and easy to miss when configuring a Railway service. Getting them wrong produces confusing failures.

- `ALLOWED_ORIGINS` — must be the service's own public URL. On the dev service use `https://writersworkbenchdev-production.up.railway.app`; on prod use `https://writersworkbench-production.up.railway.app`. The client bundles reference JS and CSS with `crossorigin`, which makes the browser send an `Origin` header on same-origin requests; if that origin isn't whitelisted the server rejects every asset with CORS 500 and the page appears blank. (We hit this during Sprint 10.a smoke testing.)
- `NODE_ENV` — `production` on prod, `development` on dev. The `/api/health` `environment` field is derived from this; if both services report the same value you cannot tell deploys apart.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — the dev service hits DEV Supabase, prod hits PROD. Keys must match their URL or auth fails with misleading errors.
- `VITE_N8N_WEBHOOK_URL` / `N8N_BRAINSTORM_WEBHOOK_URL` — dev uses `_dev` webhook suffix (calls DEV hub + DEV tool workflows); prod uses `_v2` (calls PROD hub + PROD tool workflows). Mismatch causes dev writes to land in PROD Supabase via the wrong tier.

## Git Branching

- `main` = stable release baseline. Production Railway deploys from here. Only updated via PR from `release/*` or `hotfix/*` — direct push is blocked by branch protection.
- `develop` = active integration branch. Dev Railway deploys from here. All feature work commits here (or via PR from `feature/*`).
- Feature work: branch `feature/<name>` from `develop`, PR to `develop`.
- Hotfix: branch `hotfix/<name>` from `main`, PR to `main`, cherry-pick the merge commit to `develop`.
- Release: branch `release/vX.Y` from `develop`, PR to `main`, tag `vX.Y.0` on merge, merge `main` back into `develop` to sync.
- Full guide: [CONTRIBUTING.md](CONTRIBUTING.md)

**Never bypass branch protection with admin override unless explicitly authorized by the user.**

## Workflow Governance (Sprint 10.a)

Full rules: [writers-workbench/docs/workflow-governance.md](writers-workbench/docs/workflow-governance.md)

Summary:
- V1 (`... Orig`) and PROD (`PROD - ...`) workflows are frozen baselines during sprints.
- `DEV - <name>` workflows are the only ones modified during sprints. DEV hits the DEV database; PROD hits the PROD database; the two tiers are isolated.
- Promotion DEV → PROD happens at release time via `scripts/promote-dev-to-prod.sh` (to be added in a future sprint).
- Hotfixes may be applied directly to PROD, then mirrored back to DEV.
- Dev Workbench → `/webhook/author_request_dev`; production → `/webhook/author_request_v2`.
