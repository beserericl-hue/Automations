# Newsletter Migration — Workflow ID Registry

Running registry of n8n workflow IDs used across the Newsletter Migration sprint. Referenced by the sprint doc at [`sprint-newsletter-migration.md`](../sprint-newsletter-migration.md) and by subsequent stories (S4 wires the ingestion workflow's `executeWorkflow` at the V2 scraper, etc.).

All workflows live on `https://n8n.agileadautomation.com` (hosted n8n, same instance as the rest of the Author Agent). The `.mcp.json` at the repo root currently points at a different instance (`agiletesting.app.n8n.cloud`) and must be updated before MCP n8n tools can talk to these workflows — until then, use the REST API directly with the key in `writers-workbench/.env` (`N8N_API_KEY`).

## Note on Sprint 10.a scope

Sprint 10.a (PROD/DEV tier separation) did **not** touch the newsletter pipeline. The `Orig` IDs in the sprint doc are still the canonical IDs — there is no `PROD - AI News Data Ingestion` or `DEV - Node - Scrape Url`. Those renames only applied to the 24 Writer's Workbench tool/hub workflows. Newsletter workflows stay on their original IDs and are migrated straight to `V2` by this sprint.

## Workflow IDs

| Role | Name | ID | Status |
|---|---|---|---|
| Source (frozen baseline) | `Node - Scrape Url` | `bXBsnU4d6OseXWho` | inactive — **do not modify** per project baseline rule |
| **New (S1)** | **`Node - Scrape Url V2`** | **`BJaUNEt6PPIqbWLa`** | **active** |
| Legacy duplicate | `[OLD] Node - Scrape Url` (was `Node - Scrape Url`) | `glJfsY6KaO0aoX0A` | inactive, renamed to `[OLD]` prefix |
| Broken pointer (rewired away in S4) | (n/a — was referenced by ingestion workflow) | `qVEM2rCD1jlJPeRs` | 404; no longer referenced after S4 |
| Ingestion source (frozen baseline) | `AI News Data Ingestion Orig` | `53SlwZMS21gpvz3H` | inactive (baseline — cloned to V2 in S4) |
| **New (S4)** | **`AI News Data Ingestion V2`** | **`2T3TwGHhdGQlTpQ5`** | **inactive** — awaiting manual spot-check + first-feed activation |
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

## S4 verification

`AI News Data Ingestion V2` (`2T3TwGHhdGQlTpQ5`) was built by cloning Orig (80 nodes) with six structural transformations:

1. **7 S3/proxy nodes dropped** — `upload_temp_markdown`, `copy_markdown`, `delete_temp_markdown`, `upload_temp_html`, `copy_html`, `delete_temp_html`, `search_existing_resource`. None of the `s3` resource operations against the `data-ingestion` bucket or `api.aitools.inc` proxy calls remain.
2. **`search_existing` added** — HTTP Request v4.2, GET `https://writersworkbenchdev-production.up.railway.app/api/ingestion/search?prefix={{$json.uploadFileName}}&user_id=+14105914612`, cred `jQBRJbmiUeTk8c11`. Same position as the old `search_existing_resource`.
3. **`upload_content` added** — HTTP Request v4.2, POST `https://writersworkbenchdev-production.up.railway.app/api/ingestion/upload`, cred `jQBRJbmiUeTk8c11`. Body is a single JSON expression that assembles `{key, user_id, type, title, authors, source_name, source_url, external_source_urls, image_urls, reddit_metadata?, published_timestamp, feed_url, markdown, html}` from the earlier nodes. `type` maps `feedType` to one of the four allowed ingestion types; anything unrecognized falls back to `article`.
4. **Edges rewired**:
   - `get_identity → search_existing → skip_existing_resources`
   - `try_extract_external_sources → upload_content`
5. **`skip_existing_resources` filter rewritten** — now checks `{{ ($json.items || []).length === 0 }}` against the new search response shape. Type validation flipped from `strict` to `loose` (MEMORY.md: Filter node with `strict typeValidation` discards everything).
6. **`scrape_url` executeWorkflow retargeted** — `workflowId.value` = `BJaUNEt6PPIqbWLa`, `workflowId.cachedResultName` = `Node - Scrape Url V2`. The broken `qVEM2rCD1jlJPeRs` pointer is gone.

Net: 80 → 75 nodes (−7 S3/proxy, +2 HTTP Request). All node UUIDs regenerated so the workflow can coexist with Orig without collisions.

### Before activating

V2 is **inactive on purpose** so the user can eyeball the workflow in the n8n UI before flipping it on. Checklist for first activation (per sprint doc S4):

- Open `AI News Data Ingestion V2` in n8n → Workflow view → confirm the graph looks sane around `get_identity`, `search_existing`, `skip_existing_resources`, `try_extract_external_sources`, `upload_content`.
- Open `upload_content` and look at the JSON body expression — the `external_source_urls` branch assumes `try_extract_external_sources` emits `$json.output.external_source_urls` as a comma-separated string. If the LLM output shape is different, the first live run will show empty arrays (not an error) and we fix forward.
- Limit active feeds to one RSS + one Reddit for the first pass to avoid burst traffic.
- Run manually once; verify `content_ingestion_v2` row in DEV Supabase + `.md`/`.html` blobs in the `newsletter-ingestion` bucket.
- Then activate.

### URL substitution at promotion

`WORKBENCH_URL` (dev: `writersworkbenchdev-production.up.railway.app`, prod: `writersworkbench-production.up.railway.app`) is hardcoded in the two new HTTP Request nodes. `scripts/clone-prod-to-dev.py` and its reverse `promote-dev-to-prod.py` already do URL substitution for the Supabase URL; extending to `WORKBENCH_URL` is a one-line tweak (add it to the substitution table) at DEV → PROD promotion time.

## MCP config drift

`.mcp.json` at repo root points at `https://agiletesting.app.n8n.cloud`, but this project's n8n lives at `https://n8n.agileadautomation.com`. Until `.mcp.json` is updated, `mcp__n8n-mcp__n8n_get_workflow` and friends return 404 for every newsletter-sprint workflow. Workaround used during S1: direct `curl` against the correct host with the key from `writers-workbench/.env`.
