---
name: Governance
description: CLAUDE.md tier rules + schema governance + branch protection. What's enforced where.
type: concept
tags: [operations, governance, ops]
last_reviewed: 2026-05-09
---

# Governance

Three layers of rules:

1. **CLAUDE.md** — loaded into every Claude Code session. The assistant reads it first.
2. **CI checks** — automated enforcement on every PR.
3. **Branch protection** — GitHub-side gate.

## CLAUDE.md baseline protection

Three tiers:
- **Tier 1 — Historical baseline (V1).** ElevenLabs baseline agent + V1 webhook + V1 workflows. Frozen.
- **Tier 2 — PROD workflows.** 24 active `PROD - <name>` workflows. Touched only via release-day promotion or hotfix.
- **Tier 3 — PROD Supabase.** Project `faklxfakgzkpkbxfihzh.supabase.co`. Schema changes via numbered migrations only.

Where DEV work happens:
- **DEV Supabase** project `gvbvwcnmjkdpclcisqrr.supabase.co`.
- **DEV hub** `DEV - The Author Agent` (`FLA6xIDEvejihQLP`).
- **DEV tool workflows** — one `DEV - <name>` per PROD workflow.
- All consumed by DEV Workbench at `writersworkbench-develop.up.railway.app`.

If a subagent or automated process needs to touch ANY PROD resource, **stop and ask the user first.**

## Tier-specific Railway env vars

Some env vars are tier-specific and easy to miss when configuring a Railway service. Getting them wrong produces confusing failures.

- `ALLOWED_ORIGINS` — must be the service's own public URL.
- `NODE_ENV` — `production` on prod, `development` on dev.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — match URL to keys; mismatch → auth fails.
- `VITE_N8N_WEBHOOK_URL` / `N8N_HUB_WEBHOOK_URL` — `_dev` for DEV; `_v2` for PROD. Mismatch causes cross-tier writes.

See [[env-vars-by-tier]] for the full table.

## Git branching

- `main` = stable release baseline. Production Railway deploys from `release/v1.0` (which Railway watches; advance via `git push origin main:release/v1.0`).
- `develop` = active integration branch. Dev Railway deploys from here.
- Feature work: `feature/<name>` from `develop`, PR to `develop`.
- Hotfix: `hotfix/<name>` from `main`, PR to `main`, cherry-pick to `develop`.
- Release: `release/vX.Y` from `develop`, PR to `main`, tag `vX.Y.0`, merge `main` back to `develop` to sync.

**Never bypass branch protection with admin override unless explicitly authorized by user.**

## Workflow governance

`writers-workbench/docs/workflow-governance.md`. Summary:

- V1 (`Orig`) and PROD (`PROD - …`) workflows are frozen baselines during sprints.
- `DEV - <name>` workflows are the only ones modified during sprints.
- Promotion DEV → PROD via `scripts/promote-dev-to-prod.py` at release time.
- Hotfixes apply directly to PROD, then mirror back to DEV.
- DEV Workbench → `/webhook/author_request_dev`; production → `/webhook/author_request_v2`.

## Schema governance

`writers-workbench/docs/schema-governance.md`. Summary:

- 9 base tables immutable in migrations ≥008.
- Migrations 001-007 frozen (SHA-256 pinned in `.baseline-hashes.json`).
- New attributes go in **meta tables** (sibling tables with FK).
- CI enforces via `scripts/check-base-table-immutability.py`.

See [[base-tables]].

## Branch protection on `main`

4 required status checks:
- TypeScript & Lint
- Unit Tests
- Production Build
- Schema Governance Check

E2E is informational, not required (Issue #3).

PR author cannot self-approve. Admin override is the documented escape hatch (used for stacked-PR chains and self-authored hotfixes — PRs #40, #50, #51 are precedents).

## Branch protection on `develop`

1 approving review. Same self-approve restriction. Admin override permitted.

## What gets enforced where

| Concern | Mechanism | Cost of miss |
|---------|-----------|--------------|
| `ALTER` on base table in migration ≥008 | Schema Governance Check (CI) | CI fails; PR can't merge |
| Byte change to migration 001-007 | Schema Governance Check (CI) | CI fails |
| TypeScript drift | TypeScript & Lint (CI) | CI fails |
| Test failure | Unit Tests (CI) | CI fails |
| Production build failure | Production Build (CI) | CI fails |
| Cross-tier wiring (workflow points at wrong DB) | `verify-env-isolation.py` (manual + pre-release) | Production data lands in DEV or vice versa |
| PROD workflow edit during sprint | Discipline only (no automation) | Real users see in-progress code |
| V1 workflow edit | Discipline only (no automation) | V1 customers see broken behavior |
| PR self-approve | GitHub branch protection | Author can't merge |
| Direct push to main | GitHub branch protection | Push rejected |
| Schema change without migration | Discipline + `pg_dump --schema-only` drift check | Real schema diverges from repo |

## Audit trail

- **`workflows/promotion-log.md`** — one line per promotion run. Newest at bottom.
- **`writers-workbench/migrations/`** — every schema change.
- **`writers-workbench/SESSION_CONTEXT.md`** — chronological log of working sessions. Detailed.
- **`impersonation_log` table** — every superuser impersonation action.
- **`credit_transactions` table** — every credit movement.
- **`email_bounces_v2`** — every bounce.
- **`job_queue_v2`** — every BullMQ job.
- **`outline_versions_v2`** — every outline change.
- **`content_versions_v2`** — manual + annotation-apply snapshots.

## Decision log

When non-obvious decisions are made (e.g. "switch from LLM-based drift scanner to deterministic regex"), they're captured:
- **In the SESSION_CONTEXT entry** for the session that made the decision.
- **In code comments** at the change point ("// scanner_algorithm: 'deterministic-regex-v4' — see Sprint 12 S12-12").
- **In this wiki** under the relevant page.

Don't lose decision rationale — three places means it survives even if one disappears.

## When to invoke `/save-obsidian` (this wiki)

After a working session that produced:
- A new architectural pattern.
- A non-obvious decision worth preserving.
- A cross-cutting bug fix.
- A sprint completion.

Skill at [`.claude/skills/save-obsidian/SKILL.md`](../../../../.claude/skills/save-obsidian/SKILL.md).

## When to invoke `/challenge-obsidian` (this wiki)

Before committing to a strategic recommendation, framework choice, or synthesis. Skill at [`.claude/skills/challenge-obsidian/SKILL.md`](../../../../.claude/skills/challenge-obsidian/SKILL.md).

## Repo-level constraints

- `.mcp.json` is **gitignored** in this repo (carries the n8n API key as secret). MCP config is local-only.
- `.claude/` is also gitignored — skills + settings are local-only.
- Customer-facing PDFs (`*.pdf`) gitignored except for select pinned docs.
- Local MCP server source (`elevenlabs-mcp/`) gitignored.

## Common governance gotchas

- **Subagent changes a PROD workflow without asking** — that's a violation. Subagents must pass through user-confirmation for PROD touches.
- **Migration 001-007 byte change** — even reformatting fails CI. If you really need to change one, write a compensating migration.
- **PROD-Supabase schema change without a migration** — drift accumulates. Use `pg_dump --schema-only` before/after to detect.
- **n8n PUT settings rejection** — strip allowlist (only `executionOrder`).
- **Self-approve attempt on develop** — admin override is documented escape hatch; use sparingly.
