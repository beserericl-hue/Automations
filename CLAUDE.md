# Project Rules

## BASELINE PROTECTION — MANDATORY, NO EXCEPTIONS

**NEVER modify baseline/production resources without explicit user permission.** This includes:

### Tier 1 — Historical baseline (V1, frozen)

- **ElevenLabs baseline agent** (`Writing Assistant`, agent ID: `agent_6401kjwqy66nfhabj82dvy8pnh2b`) — DO NOT change its tools, webhook URL, prompt, or any configuration
- **n8n V1 workflows** (original workflow IDs listed in MEMORY.md) — DO NOT update, deactivate, or delete any original workflow
- **n8n V1 webhook** (`/webhook/author_request`) — DO NOT modify or redirect

### Tier 2 — Production baseline (V2, frozen once customers are on system)

As of Sprint 10.a (2026-04-19), **V2 workflows are also production baseline** and under the same protection rule as V1. Live users of the production Writer's Workbench (`writers-workbench.up.railway.app`) depend on them.

- **V2 hub**: `The Author Agent_V2` (workflow ID `roMDypuMXHv6ugaZ`, webhook `/webhook/author_request_v2`)
- **V2 tool workflows** (24 workflows listed in MEMORY.md under "V2 Workflow IDs")
- **V2 Writing Assistant agent** (ElevenLabs Beta agent `agent_2801kks580vnf5q80j3bd0n0x45v`) — while named "Beta", this is currently the production Eve

**Do NOT modify any V2 workflow directly.** All development work goes on **Dev workflows** (see below). Changes flow Dev → V2 only via the controlled promotion process described in `docs/workflow-governance.md`.

### Tier 3 — Production Supabase

- **Supabase production tables** — DO NOT drop, alter, or delete data without permission
- Applies to V2 Supabase project `faklxfakgzkpkbxfihzh.supabase.co`
- Schema changes go through numbered migration files in `writers-workbench/migrations/`, reviewed before applying
- **Base tables are immutable** — the seven base tables (`users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `genre_config_v2`, `story_arcs_v2`) plus `content_versions_v2` / `outline_versions_v2` may not be `ALTER`-ed, `DROP`-ed, or renamed in any migration numbered 008+. Migrations 001–007 are frozen. New per-feature attributes live in meta tables with FKs. Enforced by CI (`scripts/check-base-table-immutability.py`). Full rules: [writers-workbench/docs/schema-governance.md](writers-workbench/docs/schema-governance.md)

### Where development work happens

All active workflow development goes on **Dev workflows** on the n8n instance:

- **Dev hub**: `The Author Agent V2 Dev` (webhook `/webhook/author_request_dev`)
- **Dev tool workflows**: each V2 workflow has a `- Dev` suffixed counterpart (mapping in `scripts/workflow-id-map.json`)
- Dev workflows are consumed by the development Writer's Workbench at `writers-workbench-dev.up.railway.app`

### If a subagent or automated process needs to touch ANY baseline resource, STOP and ask the user first.

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
- V1 and V2 workflows are immutable baselines
- Dev workflows are the only ones that get modified during sprints
- Promotion Dev → V2 happens at release time via `scripts/promote-dev-to-v2.sh`
- The dev Writer's Workbench talks to `/webhook/author_request_dev`; production talks to `/webhook/author_request_v2`
