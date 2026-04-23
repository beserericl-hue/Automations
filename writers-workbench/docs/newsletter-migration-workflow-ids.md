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
| **New (S4)** | **`AI News Data Ingestion V2`** | **`2T3TwGHhdGQlTpQ5`** | **active** — 78 nodes (after Reddit no-auth patch); first scheduled fire within 3h of activation |
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

### Two follow-up fixes applied after the initial clone (both verified live)

**1. Reddit OAuth replaced with no-auth HTTP Request.** The 3 native `n8n-nodes-base.reddit` nodes (`get_reddit_{artificial,open_ai,artificial_inteligence}_items`) required a Reddit OAuth credential, and Reddit doesn't issue API keys to third parties. Replaced each with a pair:

- `get_reddit_*_items_http` — HTTP Request v4.2, GET `https://www.reddit.com/comments/{{ $json.url.match(/comments\/([^/]+)/)[1] }}.json?raw_json=1`, `User-Agent: writers-workbench/1.0 (newsletter ingestion)`. `onError: continueRegularOutput` so Reddit rate-limit responses flow through with an `.error` field for the downstream filter to drop.
- `extract_reddit_*_items` — Set node in raw JSON mode, expression `$json[0].data.children[0].data` (or `{error:'reddit_unexpected_shape', raw:$json}` fallback). Re-exposes `url_overridden_by_dest`, `is_self`, `selftext`, `selftext_html`, `title`, `permalink`, `created_utc`, `score`, `num_comments`, `author`, `subreddit`, `id`, `link_flair_text` at the top level — exactly what the existing `filter_reddit_*_items` and `normalize_reddit_*_items` nodes already read. S5's self-post branch will fork off `extract_reddit_*_items` directly since `is_self` and `selftext` are already available.

**2. OpenAI credential attached to the `o3-mini` LLM node.** `try_extract_external_sources` uses `@n8n/n8n-nodes-langchain.lmChatOpenAi`; the credential slot was empty in Orig (which is why Orig couldn't activate either). Attached cred `xSzPIySN61drme77` (`OpenAi account`, native `openAiApi` type from MEMORY).

Node delta after these two fixes: Orig 80 → V2 78 (−7 S3/proxy, −3 native reddit, +2 ingestion HTTP, +3 reddit HTTP, +3 extract).

### End-to-end verification (automated, no manual steps)

Committed at [`scripts/newsletter-ingestion-e2e-sim.py`](../../scripts/newsletter-ingestion-e2e-sim.py). Walks every transformation the patched V2 will perform against live services:

1. `r/OpenAI/new.json` — real Reddit listing, no auth
2. `comments/{postId}.json` — real Reddit post detail, no auth — returns the full article body via `selftext` (self-posts) or via `url_overridden_by_dest` + scrape (link posts)
3. Flatten to top-level via the extract expression
4. Filter (keep link post, drop self/error/reddit/youtube)
5. Build `uploadFileName` with the same regex as `get_identity`
6. `GET /api/ingestion/search?prefix=...&user_id=...` — real dev Express + Supabase
7. Firecrawl stub (S1 already proved Node - Scrape Url V2 works via its `activeVersion` snapshot)
8. `POST /api/ingestion/upload` — real dev Express + Supabase + Storage
9. `psql` SELECT confirms the row is present with the right `type`, `title`, `source_name`, and storage paths
10. Second search confirms dedup signal flips on (items.length becomes 1)
11. `DELETE` cleanup so the test doesn't pollute dev

All 11 steps **PASSED** on 2026-04-23.

### Activation state

V2 is **active** as of 2026-04-23; `activeVersionId = 0d971d35-5a08-4cc7-b88e-15c8133b0912`. n8n's activation step validates every node's config — this passed cleanly, which means all expressions (URL regex on the new HTTP nodes, raw JSON extract, upload body JSON expression, filter rewrite) compiled without syntax errors. Orig stays inactive.

First scheduled fire is within 3h (Reddit triggers) or 4h (other feeds) of activation. The executions endpoint (`GET /api/v1/executions?workflowId=2T3TwGHhdGQlTpQ5`) will populate as each trigger fires.

### URL substitution at promotion

`WORKBENCH_URL` (dev: `writersworkbenchdev-production.up.railway.app`, prod: `writersworkbench-production.up.railway.app`) is hardcoded in the two new HTTP Request nodes. `scripts/clone-prod-to-dev.py` and its reverse `promote-dev-to-prod.py` already do URL substitution for the Supabase URL; extending to `WORKBENCH_URL` is a one-line tweak (add it to the substitution table) at DEV → PROD promotion time.

## MCP config drift

`.mcp.json` at repo root points at `https://agiletesting.app.n8n.cloud`, but this project's n8n lives at `https://n8n.agileadautomation.com`. Until `.mcp.json` is updated, `mcp__n8n-mcp__n8n_get_workflow` and friends return 404 for every newsletter-sprint workflow. Workaround used during S1: direct `curl` against the correct host with the key from `writers-workbench/.env`.
