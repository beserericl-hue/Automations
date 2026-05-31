---
name: Workflow tiers
description: Tier model for n8n workflows — V1 / DEV / PROD. Naming, webhooks, isolation rules.
type: concept
tags: [workflows, n8n, tiers, governance]
last_reviewed: 2026-05-09
---

# Workflow tiers

Single n8n instance at `https://n8n.agileadautomation.com`. Three tiers identified by name prefix.

| Tier | Naming | Webhook suffix | Database it writes to | Workbench that calls it |
|------|--------|----------------|----------------------|-------------------------|
| V1 (Orig) | `<Workflow> Orig` (e.g. `AI News Data Ingestion Orig`) | none — `/webhook/author_request` | PROD Supabase (legacy V1 schema, intermixed) | (none — frozen; baseline Eve agent calls V1 hub directly) |
| PROD | `PROD - <Workflow>` | `_v2` (hub: `/webhook/author_request_v2`); workers `-v2` | PROD Supabase `faklxfakgzkpkbxfihzh` | `writersworkbench-production.up.railway.app` |
| DEV | `DEV - <Workflow>` | `_dev` (hub: `/webhook/author_request_dev`); workers `-dev` | DEV Supabase `gvbvwcnmjkdpclcisqrr` | `writersworkbench-develop.up.railway.app` |

## Counts (verified 2026-04-21)

- 24 `PROD - <name>` workflows.
- 24 `DEV - <name>` workflows (cloned from PROD at Sprint 10.a).
- ~20 V1 (`Orig`) workflows still active (rarely fired — only when the baseline Eve calls them).
- + Newsletter cluster: 3 DEV-only workflows (cron + cadence + agent already existed in V1).

## n8n-git parallel

| Workflow tier | Git analogue | Modification rule |
|---------------|--------------|-------------------|
| V1 (Orig) | tagged old release, archived | Never modify |
| PROD | `main` — production, branch-protected | Touched only by hotfix or release-day promotion |
| DEV | `develop` — active sprint work | Free to modify; source of truth for "what PROD will look like next release" |

## Isolation invariants

Every PROD workflow:
- Reads/writes only PROD Supabase URL/key (in Set/Code nodes).
- Calls only PROD sibling sub-workflows via `executeWorkflow` (per [[workflow-id-map]]).
- Has webhook paths ending `_v2` or `-v2`.

Every DEV workflow:
- Reads/writes only DEV Supabase URL/key.
- Calls only DEV sibling sub-workflows.
- Has webhook paths ending `_dev` or `-dev`.

Cross-tier wiring (e.g. PROD hub calling DEV sibling) is the most common promotion bug. `scripts/verify-env-isolation.py` detects it.

## Promotion (DEV → PROD)

Triggered at release time. Run via `scripts/promote-dev-to-prod.py`:

1. **Diff** — node-by-node diff between `DEV - X` and `PROD - X` for each workflow in [[workflow-id-map]].
2. **Promote** for each that differs:
   - Deactivate PROD workflow.
   - Copy DEV's `nodes` + `connections` + `settings` onto the PROD id.
   - **Substitute** Supabase URL/key DEV→PROD; webhook paths `_dev` → `_v2`; `executeWorkflow` refs DEV ids → PROD ids (via reverse id map).
   - Reactivate PROD.
3. **Log** — append entry to `writers-workbench/workflows/promotion-log.md` with date, workflow, change summary.
4. **Verify** — trigger one production test op; confirm clean PROD execution.

PROD workflow ids never change, so `executeWorkflow` references downstream don't need to be repointed — only internal contents change.

See [[promotion-dev-to-prod]] for the full release runbook.

## Hotfixes

Urgent prod bugs bypass the full promotion (analogous to git hotfix to `main`):

1. Fix `PROD - <name>` directly via REST API (`deactivate → PUT → activate`).
2. **Mirror** the same change into `DEV - <name>` so they don't drift.
3. Sync the repo JSON if you keep workflow JSON checked in (e.g. `writers-workbench/n8n-workflows/`).
4. Branch `hotfix/<name>` from `main`, commit, PR to `main`, cherry-pick to `develop`.

PRs #2 and #4 (cover art binary fix, genre-from-DB) used this pattern before Sprint 10.a's separation existed. PR #71 (story-bible extraction) used it post-separation.

## n8n REST API gotchas

- **`PUT /api/v1/workflows/{id}`** rejects most `settings` keys. Only `executionOrder` is accepted on this version. Strip everything else.
- **`activeVersion` is a snapshot at activation time.** After updating workflow JSON via PUT, the runtime keeps the old version until you `deactivate → PUT → activate` cycle. n8n 2.x adds a UI requirement: after PUT, refresh the workflow tab and click **Publish** (⌘P) so the runtime picks up the change. See `feedback_n8n_2x_publish_flow.md` in memory.
- **`POST /api/v1/workflows/{id}/deactivate`** returns 403 on already-active workflows in n8n 2.x. Toggle in the UI, or PUT-in-place (which works anyway).
- **`webhookId` is globally unique per instance.** Cloning a PROD workflow and reusing its webhookId fails activation with "webhook conflict". `clone-prod-to-dev.py` regenerates all webhookIds (including on chatTrigger / gmail / wait nodes — anything that carries one).
- **PUT also rejects** `staticData`, `pinData`, `activeVersionId`, `versionCounter`, `triggerCount`, `shared`, `tags`, `activeVersion`, `meta`, `description`, `isArchived`, `active`. Only send `name`/`nodes`/`connections`/`settings.executionOrder`.
- **Cloudflare 524** times out long hub responses at ~100s. Async (queued) operations are unaffected; sync hub calls that take >90s get a client-side 524 while the tool keeps running server-side.

## What V1 workflows are still active

V1 hub (`RcHfwiB7uM2vFfJ3` `/webhook/author_request`) and its tool tree are still active so the baseline Eve agent (`agent_6401kjwqy66nfhabj82dvy8pnh2b`) keeps working for any user still on a V1 contract. **DO NOT modify these.** See [[v1-frozen]].

## What lives outside the strict 24/24

- **Story-bible backfill workflow** (`hXkfrkuiWbJtJlEl`, DEV only) — created during the 2026-04-29 hotfix as a one-shot driver. Standalone webhook workflow not in the 24 promoted set. PROD equivalent doesn't exist (manual backfill via service-role REST + Anthropic API instead — `scripts/hotfix-backfill-story-bible-prod.py`).
- **Newsletter cluster** (3 DEV-only workflows) — not in PROD yet; promotion pending. See [[newsletter-workflows]].
- **AI News Data Ingestion Orig** (`53SlwZMS21gpvz3H`) — V1 newsletter ingestion. Still active. Will be deactivated once the new multi-user cron is verified end-to-end.
