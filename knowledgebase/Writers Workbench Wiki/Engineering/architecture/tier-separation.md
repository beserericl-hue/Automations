---
name: Tier separation (V1 / DEV / PROD)
description: The three-tier model that isolates production from sprint work across every layer. Most-referenced rule in the codebase.
type: concept
tags: [architecture, governance, tiers]
last_reviewed: 2026-05-09
---

# Tier separation

Established **Sprint 10.a (2026-04-20)**. Codified in `CLAUDE.md` baseline-protection section + `writers-workbench/docs/workflow-governance.md` + `writers-workbench/docs/schema-governance.md`. Enforced by CI (`scripts/check-base-table-immutability.py`).

## Tiers

| Tier | When touched | What it powers |
|------|--------------|----------------|
| **V1 (Orig)** | Never (frozen) | Original 2025 release. Eve baseline agent calls into it. Kept for compatibility with existing recordings + customer 1.0 contracts. |
| **PROD** | Hotfix or release-day promotion | Live customers. The Workbench at `writersworkbench-production.up.railway.app`. Beta/PROD Eve agent. |
| **DEV** | Every sprint | Active development. The Workbench at `writersworkbench-develop.up.railway.app`. DEV Eve agent. |

## Layer-by-layer split

| Layer | V1 | DEV | PROD |
|-------|----|----|------|
| Supabase | (legacy V1 schema in PROD project) | `gvbvwcnmjkdpclcisqrr` | `faklxfakgzkpkbxfihzh` |
| n8n workflow prefix | `… Orig` | `DEV - <name>` | `PROD - <name>` |
| n8n hub webhook | `/webhook/author_request` | `/webhook/author_request_dev` | `/webhook/author_request_v2` |
| n8n worker webhook suffix | none | `-dev` | `-v2` |
| Workbench Railway | n/a |  `writersworkbench-develop.up.railway.app` (bubbly-solace/develop) (NODE_ENV=development) | `writersworkbench-production.up.railway.app` (bubbly-solace/production) (NODE_ENV=production) |
| Eve agent | `agent_6401kjwqy66nfhabj82dvy8pnh2b` | `agent_0001kpr667v6ffctex0a8dt4fk71` | `agent_2801kks580vnf5q80j3bd0n0x45v` |
| Eve forwarding tool | n/a (Eve baseline calls V1 hub directly) | `tool_0801kprf5a14ee9b5ts7b8d2tetf` (`forward_writing_request_dev`) | `tool_2301kksb78ygewvv3q3cm82wcfjs` (`forward_writing_request_v2`) |
| Redis | n/a | `Redis_Dev` | `Redis` |
| Postal mail server | n/a | `writers-workbench-mail-dev` (Development mode — swallowed) | `writers-workbench-mail-prod` (Live) |
| `EMAIL_SECRET`, `INGESTION_SECRET`, `APPROVAL_SECRET` env vars | n/a | unique per tier | unique per tier |

## Hard rules

1. **Never modify a PROD workflow during a sprint.** Sprint work goes on the matching `DEV - <name>` copy.
2. **Never modify the V1 baseline** (V1 hub `RcHfwiB7uM2vFfJ3`, baseline Eve agent, V1 webhook).
3. **Never modify the seven base tables** (`users_v2`, `writing_projects_v2`, `published_content_v2`, `story_bible_v2`, `research_reports_v2`, `genre_config_v2`, `story_arcs_v2`) plus `content_versions_v2` / `outline_versions_v2`. New attributes go in **meta tables**. See [[base-tables]].
4. **Migrations 001-007 are frozen.** Any byte change fails CI.
5. **Migrations ≥008** must not `ALTER`/`DROP`/`RENAME` a base table.
6. **DEV→PROD promotion is the only legal way to move workflow changes to PROD.** Run `scripts/promote-dev-to-prod.py`. See [[promotion-dev-to-prod]].
7. **Hotfixes apply directly to PROD**, but must be mirrored back to DEV the same day. See [[hotfix-flow]].

## What enforces this

| Mechanism | Where | Catches |
|-----------|-------|---------|
| `scripts/check-base-table-immutability.py` | CI `Schema Governance Check` job | `ALTER`/`DROP` on base tables in migrations ≥008; byte changes to migrations 001-007 |
| `writers-workbench/migrations/.baseline-hashes.json` | SHA-256 pins for migrations 001-007 | Drift on frozen migrations |
| `scripts/verify-env-isolation.py` | Manual + pre-release | DEV workflows pointing at PROD Supabase, PROD URLs in DEV; cross-tier `executeWorkflow` refs |
| Branch protection on `main` | GitHub | Requires 4 status checks: TypeScript, Unit Tests, Production Build, Schema Governance |
| `CLAUDE.md` baseline section | Loaded into every Claude Code session | Tells the assistant to refuse PROD edits without explicit authorization |

## What breaks if you ignore this

- **Cross-tier wiring** (DEV workflow pointing at PROD Supabase URL): customer-tier writes accidentally land in DEV; or worse, DEV writes land in PROD. We hit this on the v1.1.0 release when `N8N_HUB_WEBHOOK_URL` was copied from DEV to PROD with the `_dev` path — fixed before any user traffic. See [[hotfixes]].
- **`executeWorkflow` ref pointing across tiers**: PROD hub calls DEV tool, which writes to DEV Supabase using PROD's user_id → orphaned data in DEV. The promotion script re-walks every ref through [[workflow-id-map]] to prevent this.
- **`webhookId` collisions**: cloning a PROD workflow keeps its `webhookId` and the clone fails to activate. `scripts/clone-prod-to-dev.py` regenerates all webhookIds.
- **n8n PUT settings rejection**: n8n REST API only accepts `executionOrder` in the `settings` block. Sending `binaryMode`, `errorWorkflow`, `callerPolicy` etc. returns `400 must NOT have additional properties`. Strip to allowlist.

## Related docs in repo

- [`writers-workbench/docs/workflow-governance.md`](../../../../writers-workbench/docs/workflow-governance.md)
- [`writers-workbench/docs/schema-governance.md`](../../../../writers-workbench/docs/schema-governance.md)
- [`writers-workbench/docs/railway-deployment.md`](../../../../writers-workbench/docs/railway-deployment.md)
- [`scripts/workflow-id-map.json`](../../../../scripts/workflow-id-map.json)
