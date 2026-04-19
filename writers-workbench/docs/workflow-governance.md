# n8n Workflow Governance

**Status:** Active from Sprint 10.a onward (2026-04-19)
**Location of rules:** [`CLAUDE.md`](../../CLAUDE.md) baseline protection section

## Why this exists

Before Sprint 10.a, the project had two workflow tiers:
- **V1 (Orig)** — frozen historical baseline
- **V2** — actively developed, also served to anyone using the system

That model worked while the only user was the developer. Once real customers are on the production Writer's Workbench, modifying V2 workflows mid-sprint risks breaking production. Sprint 10.a introduces a **three-tier model** that mirrors the git `main`/`develop` branching discipline from Sprint 10.

## The three tiers

| Tier | Suffix / naming | Webhook | Consumed by | Modification rule |
|------|----------------|---------|-------------|------------------|
| **V1 (Orig)** | `... Orig` | `/webhook/author_request` | Nothing (frozen) | NEVER modify without explicit user permission |
| **V2 (Prod)** | `... V2` | `/webhook/author_request_v2` | Production Writer's Workbench (`writers-workbench.up.railway.app`) | NEVER modify without explicit user permission. Changes only via the Dev → V2 promotion process below. |
| **Dev** | `... V2 Dev` | `/webhook/author_request_dev` | Development Writer's Workbench (`writers-workbench-dev.up.railway.app`) | Free to modify during sprints. Source of truth for "what V2 will look like next release." |

## The n8n-git parallel

| Workflow tier | Git analogue |
|---------------|-------------|
| V1 (Orig) | tagged old release, archived |
| V2 (Prod) | `main` — immutable, deployed to production, protected |
| Dev | `develop` — active work, deployed to dev environment |

Just as `main` is only updated via PR from `release/*` or `hotfix/*`, **V2 workflows are only updated via the promotion scripts** — not ad-hoc editing in the n8n UI.

## Naming convention

**V1:** `AI News Data Ingestion Orig`, `Content - Newsletter Agent`, `Node - Scrape Url`
**V2:** `The Author Agent_V2`, `Tool - Write Chapter V2`, `Sub - Retrieve Content V2`
**Dev:** `The Author Agent V2 Dev`, `Tool - Write Chapter V2 Dev`, `Sub - Retrieve Content V2 Dev`

The ID map between V2 and Dev lives in `scripts/workflow-id-map.json`.

## Promotion flow (Dev → V2)

Triggered at release time. Release happens when:
- Feature branch merged to `develop`
- `release/vX.Y` branch cut from `develop`
- PR from `release/*` merged to `main`
- Tagged `vX.Y.0`

Workflow changes move at the same moment:

1. **Diff check:** `scripts/diff-dev-vs-v2.sh <workflow-name>` — review what will change
2. **Dry run:** `scripts/promote-dev-to-v2.sh --dry-run <workflow-name>` — confirm expected diff
3. **Promote:** `scripts/promote-dev-to-v2.sh <workflow-name>`
   - Deactivates V2 workflow
   - PUTs Dev's nodes and connections onto the V2 workflow ID (V2 ID stays stable)
   - Reactivates V2
   - Writes an entry to `workflows/promotion-log.md` with date, workflow, git SHA, approver
4. **Verify:** trigger a production test operation, confirm V2 workflow executes cleanly

The V2 workflow ID never changes, so the production hub's `executeWorkflow` tool references don't need updating — only the internal contents of the V2 workflow change.

## Hub promotion

The hub workflow itself (`The Author Agent_V2`) is a special case because it references tool workflow IDs. When a V2 tool workflow's **content** changes (nodes, jsCode, connections), the hub is unaffected because IDs are stable. But if we ever need to change which tool workflows the hub calls, or add a new tool, that's a hub-level change that also promotes Dev → V2 via the same process.

## Hotfixes

Urgent production bugs bypass the full Dev → V2 flow (analogous to git hotfixes to `main`):

1. Fix the V2 workflow directly via the n8n API (`n8n_update_partial_workflow` with deactivate → patch → activate).
2. Mirror the same change into the Dev workflow so it doesn't get overwritten on the next release.
3. Sync the repo JSON for the V2 workflow.
4. Create a hotfix branch in git, commit the repo JSON update, PR to `main`, cherry-pick to `develop`.

We already exercised this pattern in PRs #2 and #4 (cover art binary fix, genre-from-DB fix) before Sprint 10.a's separation was in place. Going forward, the hotfix process documented here applies.

## What if I need to test a change across both tiers?

You don't. If the change is still uncertain, it stays on Dev. Only promote to V2 when the change is confidently shippable. The whole point of the separation is that production users never see in-progress work.

## What breaks if someone ignores this

- **Direct edit of V2 workflow** during a sprint: production users see the mid-sprint state, which may be broken. Fix: revert via V2's n8n version history, re-apply the change on Dev instead.
- **Hub references changed without coordinating**: if someone changes a V2 tool workflow's ID (e.g., deletes and recreates), the hub breaks because its `executeWorkflow` references are invalid. Don't delete-and-recreate V2 workflows — always patch in place.
- **Dev workflow created with wrong workflow ID map entry**: if the ID map is wrong, the promotion script will promote the wrong thing. Re-run `scripts/clone-v2-to-dev.sh --rebuild-map` to regenerate.

## What about V3, V4, etc.?

We don't need them under this model. The three tiers are stable:
- V1 stays historical
- V2 is always current production
- Dev is always current development

When Dev changes become production, they overwrite V2's contents (same ID). The V2 name never increments. Historic V2 states are preserved in n8n's per-workflow version history, not in new V2-suffixed copies.

## Related files

- `scripts/clone-v2-to-dev.sh` — one-time clone of V2 → Dev (run once at start of Sprint 10.a)
- `scripts/diff-dev-vs-v2.sh` — show node-level diff before promotion
- `scripts/promote-dev-to-v2.sh` — apply Dev → V2 at release time
- `scripts/workflow-id-map.json` — V2 ↔ Dev ID mapping
- `workflows/promotion-log.md` — audit trail of all Dev → V2 promotions
- `CLAUDE.md` — baseline protection rules
- `writers-workbench/sprint_document_v2.md` — Sprint 10.a story detail
