# n8n Workflow Governance

**Status:** Active from Sprint 10.a onward (2026-04-20)
**Location of rules:** [`CLAUDE.md`](../../CLAUDE.md) baseline protection section

## Why this exists

Before Sprint 10.a, the project had two workflow tiers:
- **V1 (Orig)** — frozen historical baseline
- **V2** — actively developed, also served to anyone using the system

That model worked while the only user was the developer. Once real customers are on the production Writer's Workbench, modifying the live workflows mid-sprint risks breaking production. Sprint 10.a introduces a **three-tier model** that mirrors the git `main`/`develop` branching discipline from Sprint 10.

## The three tiers

| Tier | Name prefix | Database | Webhook | Consumed by | Modification rule |
|------|-------------|----------|---------|-------------|------------------|
| **V1 (Orig)** | `... Orig` | PROD | `/webhook/author_request` | Nothing (frozen) | NEVER modify without explicit user permission |
| **PROD** | `PROD - <name>` | PROD Supabase (`faklxfakgzkpkbxfihzh`) | `/webhook/author_request_v2` | Production Writer's Workbench (`writersworkbench-production.up.railway.app`) | Touched only by hotfixes or Dev→Prod promotion. No ad-hoc sprint edits. |
| **DEV** | `DEV - <name>` | DEV Supabase (`gvbvwcnmjkdpclcisqrr`) | `/webhook/author_request_dev` | Dev Writer's Workbench (`writersworkbenchdev-production.up.railway.app`) | Free to modify during sprints. Source of truth for "what PROD will look like next release." |

## The n8n-git parallel

| Workflow tier | Git analogue |
|---------------|-------------|
| V1 (Orig) | tagged old release, archived |
| PROD | `main` — immutable, deployed to production, protected |
| DEV | `develop` — active work, deployed to dev environment |

Just as `main` is only updated via PR from `release/*` or `hotfix/*`, **PROD workflows are only updated via the promotion scripts or a hotfix** — not ad-hoc editing in the n8n UI.

## Naming convention

**V1:** `AI News Data Ingestion Orig`, `Content - Newsletter Agent`, `Node - Scrape Url`
**PROD:** `PROD - The Author Agent`, `PROD - Tool - Write Chapter`, `PROD - Sub - Retrieve Content`
**DEV:** `DEV - The Author Agent`, `DEV - Tool - Write Chapter`, `DEV - Sub - Retrieve Content`

The ID map between PROD and DEV lives in `scripts/workflow-id-map.json`.

Within each tier, webhook paths are suffixed accordingly (`_v2` on PROD hub, `_dev` on DEV hub; worker webhooks end in `-v2` / `-dev`).

## What to modify during a sprint

**Only `DEV - <name>` workflows.** PROD workflows are untouchable outside release time (see promotion flow below) or a hotfix.

Corollary: the DEV Writer's Workbench (`writersworkbenchdev-production.up.railway.app`) hits the DEV hub webhook, which calls DEV tool workflows, which write to the DEV database. Production reads and writes stay on PROD — completely isolated tiers, even though they share the same n8n instance.

## Promotion flow (Dev → Prod)

Triggered at release time. Release happens when:
- Feature branch merged to `develop`
- `release/vX.Y` branch cut from `develop`
- PR from `release/*` merged to `main`
- Tagged `vX.Y.0`

Workflow changes move at the same moment:

1. **Diff check:** review what will change — node-by-node diff between the matching `DEV - X` and `PROD - X` workflows.
2. **Promote:** for each workflow that differs:
   - Deactivate PROD workflow
   - Copy DEV's `nodes` + `connections` + `settings` onto the PROD workflow id
   - **Swap Supabase URL/key back to PROD values** (`faklxfakgzkpkbxfihzh` + the PROD secret key)
   - **Rewrite webhook paths back to `_v2`** (from `_dev`)
   - **Rewire any `executeWorkflow` refs that still point at DEV siblings back to their PROD siblings** (via the id map, reversed)
   - Reactivate PROD
3. **Log:** append an entry to `workflows/promotion-log.md` (date, workflow, git SHA, approver).
4. **Verify:** trigger a production test operation, confirm PROD workflow executes cleanly.

PROD workflow ids never change, so nothing downstream needs to be repointed — only the *internal contents* change.

## Hotfixes

Urgent production bugs bypass the full Dev → Prod flow (analogous to git hotfixes to `main`):

1. Fix the `PROD - <name>` workflow directly via the n8n API (`deactivate → PUT → activate`).
2. Mirror the same change into the matching `DEV - <name>` workflow so they don't drift.
3. Sync the repo JSON for the PROD workflow.
4. Create a hotfix branch in git, commit the repo JSON update, PR to `main`, merge, cherry-pick to `develop`.

We already exercised this pattern in PRs #2 and #4 (cover art binary fix, genre-from-DB fix) before Sprint 10.a's separation was in place.

## What if I need to test a change across both tiers?

You don't. If the change is still uncertain, it stays on DEV. Only promote to PROD when the change is confidently shippable. The whole point of the separation is that production users never see in-progress work.

## What breaks if someone ignores this

- **Direct edit of a PROD workflow during a sprint:** production users see the mid-sprint state, which may be broken. Fix: revert via PROD's n8n version history, re-apply the change on DEV instead.
- **PROD workflow id changed (deleted + recreated):** the hub's `executeWorkflow` references become invalid. Never delete-and-recreate PROD workflows — always patch in place.
- **DEV workflow created without adding to the id map:** the promotion script will miss it at release time. Run `scripts/clone-prod-to-dev.py` — it's idempotent and will fill in any missing entries.

## What about V3, V4, etc.?

Not needed under this model. The tiers are stable:
- V1 (Orig) stays historical
- PROD is always current production
- DEV is always current development

When DEV changes become production, they overwrite PROD's contents (same ids). Historic PROD states are preserved in n8n's per-workflow version history.

## Related files

- [`scripts/clone-prod-to-dev.py`](../../scripts/clone-prod-to-dev.py) — one-time clone + idempotent re-runs. Creates DEV copies, rewrites Supabase creds to DEV, rewrites webhook paths to `_dev`, rewires `executeWorkflow` refs between DEV siblings, saves id map.
- `scripts/workflow-id-map.json` — PROD ↔ DEV id mapping (authoritative).
- `scripts/promote-dev-to-prod.sh` — apply DEV → PROD at release time (to be built in a future sprint).
- `workflows/promotion-log.md` — audit trail of all DEV → PROD promotions.
- [`CLAUDE.md`](../../CLAUDE.md) — baseline protection rules.
- `writers-workbench/sprint_document_v2.md` — Sprint 10.a story detail.
