# Newsletter Migration — Workflow ID Registry

Running registry of n8n workflow IDs used across the Newsletter Migration sprint. Referenced by the sprint doc at [`sprint-newsletter-migration.md`](../sprint-newsletter-migration.md) and by subsequent stories (S4 wires the ingestion workflow's `executeWorkflow` at the V2 scraper, etc.).

All workflows live on `https://n8n.agileadautomation.com` (hosted n8n, same instance as the rest of the Author Agent). The `.mcp.json` at the repo root currently points at a different instance (`agiletesting.app.n8n.cloud`) and must be updated before MCP n8n tools can talk to these workflows — until then, use the REST API directly with the key in `writers-workbench/.env` (`N8N_API_KEY`).

## Note on Sprint 10.a scope

Sprint 10.a (PROD/DEV tier separation) did **not** touch the newsletter pipeline. The `Orig` IDs in the sprint doc are still the canonical IDs — there is no `PROD - AI News Data Ingestion` or `DEV - Node - Scrape Url`. Those renames only applied to the 24 Writer's Workbench tool/hub workflows. Newsletter workflows stay on their original IDs and are migrated straight to `V2` by this sprint.

## Workflow IDs

| Role | Name | ID | Status (post-S1) |
|---|---|---|---|
| Source (frozen baseline) | `Node - Scrape Url` | `bXBsnU4d6OseXWho` | inactive — **do not modify** per project baseline rule |
| **New (S1)** | **`Node - Scrape Url V2`** | **`BJaUNEt6PPIqbWLa`** | **active** |
| Legacy duplicate | `[OLD] Node - Scrape Url` (was `Node - Scrape Url`) | `glJfsY6KaO0aoX0A` | inactive, renamed to `[OLD]` prefix |
| Broken pointer (to be rewired in S4) | (n/a — referenced by ingestion workflow) | `qVEM2rCD1jlJPeRs` | 404 — ingestion's `scrape_url` executeWorkflow node currently points here |
| Ingestion source (S4) | `AI News Data Ingestion Orig` | `53SlwZMS21gpvz3H` | inactive (baseline — clone to V2 in S4) |
| Newsletter Agent source (S6) | `Content - Newsletter Agent` | `4DQ7DmA9pFtXzsKX` | inactive (baseline — clone to V2 in S6) |

## S1 verification

- V2 workflow `BJaUNEt6PPIqbWLa` created via `POST /api/v1/workflows` with 2 nodes (`workflow_trigger` → `scrape_url`), `settings.executionOrder = v1`.
- Firecrawl credential reference preserved: `oWli4irymtVqSDyC` (name: `Firecrawl`, type: `httpHeaderAuth`).
- Node IDs regenerated (UUID v4) on clone — prevents any future collision if the source workflow is ever re-enabled.
- Activation via `POST /api/v1/workflows/BJaUNEt6PPIqbWLa/activate` returned 200 with `active: true` and a populated `activeVersion` snapshot, which means the Firecrawl credential binding resolved cleanly.
- Duplicate `glJfsY6KaO0aoX0A` renamed via `PUT /api/v1/workflows/glJfsY6KaO0aoX0A` from `Node - Scrape Url` to `[OLD] Node - Scrape Url`. Its Firecrawl node was wired to the broken `BZku8v1a2K12iFGQ` (labeled "OpenAI" — a stale httpHeaderAuth credential), which explains why it was never usable and was left as dead weight.

Live end-to-end scrape verification (real URL in → markdown + rawHtml out) is **deferred to S4's system test**, per the sprint doc — S4 wires the ingestion workflow at this V2 scraper and the first ingestion dry-run exercises it.

## n8n `httpHeaderAuth` credential IDs (DEV tier, created 2026-04-23)

| Credential name | ID | Header |
|---|---|---|
| `DEV Workbench Ingestion Secret` | `jQBRJbmiUeTk8c11` | `X-Ingestion-Secret` |
| `DEV Workbench Approval Secret`  | `ytjKAO1BESVf6Cnz` | `X-Approval-Secret` |
| `DEV Workbench Email Secret`     | `kxrSg24PIR2Npfvw` | `X-Email-Secret` |

Each DEV workflow's HTTP Request nodes that call `/api/{ingestion,approvals,email}/*` must reference these via `"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth", "credentials": {"httpHeaderAuth": {"id": "<cred id>"}}` — same pattern already used by the Firecrawl credential (`oWli4irymtVqSDyC`).

PROD credentials don't exist yet. They'll be created at release promotion using the PROD secret values (currently only in the user's vault). `scripts/clone-prod-to-dev.py` handles credential ID substitution during promotion.

## For S4

The ingestion V2 clone's `scrape_url` executeWorkflow node must point its `workflowId` at `BJaUNEt6PPIqbWLa` (replacing the broken `qVEM2rCD1jlJPeRs`).

The two new HTTP Request nodes this story adds (`search_existing` and `upload_content`) must both reference cred `jQBRJbmiUeTk8c11` (DEV Workbench Ingestion Secret).

URL for DEV Express: `https://writersworkbenchdev-production.up.railway.app` (will be the `WORKBENCH_URL` hardcoded in the workflow JSON; `scripts/clone-prod-to-dev.py` will substitute to `writersworkbench-production.up.railway.app` at promotion).

## MCP config drift

`.mcp.json` at repo root points at `https://agiletesting.app.n8n.cloud`, but this project's n8n lives at `https://n8n.agileadautomation.com`. Until `.mcp.json` is updated, `mcp__n8n-mcp__n8n_get_workflow` and friends return 404 for every newsletter-sprint workflow. Workaround used during S1: direct `curl` against the correct host with the key from `writers-workbench/.env`.
