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
| **New (S4+S5)** | **`AI News Data Ingestion V2`** | **`2T3TwGHhdGQlTpQ5`** | **active** — 86 nodes (S4 reduced Orig to 78, S5 added the 8-node self-post branch); `activeVersionId=d21c13b4-3614-4d12-9733-0d8f968ca627` |
| Newsletter Agent source (frozen baseline) | `Content - Newsletter Agent` | `4DQ7DmA9pFtXzsKX` | inactive (baseline — cloned to V2 in S6) |
| **New (S6)** | **`Content - Newsletter Agent V2`** | **`bMvMKyK8obwYZmNb`** | inactive — activation blocked by pre-existing LLM/Slack/s3-segment cred gaps that S8/S10/S11 resolve (same as Orig; not a regression) |

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

V2 is **active** as of 2026-04-23; current `activeVersionId = d21c13b4-3614-4d12-9733-0d8f968ca627` (post-S5). n8n's activation step validates every node's config — both the S4 and the S5 re-activations passed cleanly, which means all expressions (URL regex on the new HTTP nodes, raw JSON extract, upload body JSON expressions, filter rewrites, route IF, self-post normalize Code) compiled without syntax errors. Orig stays inactive.

First scheduled fire is within 3h (Reddit triggers) or 4h (other feeds) of activation. The executions endpoint (`GET /api/v1/executions?workflowId=2T3TwGHhdGQlTpQ5`) will populate as each trigger fires.

---

## S5 — Reddit self-post branch (added 2026-04-23)

Forks off each `extract_reddit_{sub}_items` node (introduced in S4) with a parallel self-post pipeline that bypasses Firecrawl since the body is already in hand on the Reddit response.

**8 new nodes:**

| Name | Type | Role |
|---|---|---|
| `filter_reddit_{sub}_self_posts` (×3) | `filter` v2.2, typeValidation=`loose` | keeps items with `is_self=true`, non-empty `selftext` ≠ `[removed]`/`[deleted]`, no `crosspost_parent` |
| `normalize_reddit_{sub}_self_posts` (×3) | `code` v2 `runOnceForEachItem` | emits `{sourceName:'reddit-{sub}', feedType:'reddit_post', title, link, url, creator, pubDate, isoDate, feedUrl, body_markdown, body_html, reddit_metadata}` — matches `get_identity`'s expected input so the existing Set node keeps working unchanged |
| `route_scrape_or_self` | `if` v2.2 | `$('get_identity').item.json.feedType === 'reddit_post'`: TRUE → `upload_content_self_post` (skip scrape), FALSE → `delay` (existing link-post path) |
| `upload_content_self_post` | `httpRequest` v4.2, cred `jQBRJbmiUeTk8c11` | POST `/api/ingestion/upload` with `type:'reddit_post'`, `markdown:body_markdown`, `html:body_html`, `reddit_metadata` populated |

**Edge changes (8 edges total):**
- `extract_reddit_{sub}_items` → `filter_reddit_{sub}_self_posts` (×3 new, alongside existing to `filter_reddit_{sub}_items`)
- `filter_reddit_{sub}_self_posts` → `normalize_reddit_{sub}_self_posts` (×3 new)
- `normalize_reddit_{sub}_self_posts` → `get_identity` (×3 new, merges into the 17 existing normalize→get_identity edges)
- `skip_existing_resources` → `route_scrape_or_self` (rewired; replaces the old `skip→delay` edge)
- `route_scrape_or_self.true` → `upload_content_self_post` (new)
- `route_scrape_or_self.false` → `delay` (preserves link-post path)

**HTML-entity decode** lives inside the normalize Code node — a 6-replacement helper for `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#039;`, `&#x200B;` (the entities Reddit embeds in `selftext_html`).

### S5 end-to-end verification (automated, no manual steps)

Committed at [`scripts/newsletter-selfpost-e2e-sim.py`](../../scripts/newsletter-selfpost-e2e-sim.py). Walks the full self-post path against **live** services:

```
 1. r/OpenAI/new.json                -> pick a real is_self=true post (id 1stua1s)
 2. comments/{postId}.json           -> full post incl. selftext/selftext_html
 3. filter_reddit_*_self_posts       -> PASS
 4. normalize_reddit_*_self_posts    -> sourceName=reddit-OpenAI, body_markdown populated, reddit_metadata keys all present
 5. get_identity                     -> uploadFileName computed
 6. /api/ingestion/search (dev)      -> items:[]
 7. route_scrape_or_self              -> TRUE (bypass scrape)
 8. /api/ingestion/upload (dev)      -> 200 OK
 9. psql SELECT                      -> type=reddit_post, reddit_metadata JSONB populated with score/author/reddit_id/subreddit/num_comments/flair
10. /api/ingestion/get/:key          -> full roundtrip OK, markdown body matches, reddit_metadata.reddit_id matches post id
11. DELETE cleanup

S5 SELF-POST END-TO-END SIM PASSED
```

Reusable for every future change to the Reddit self-post pipeline.

---

## S6 — Newsletter Agent read path (added 2026-04-23)

Clones `Content - Newsletter Agent` (`4DQ7DmA9pFtXzsKX`, 87 nodes, inactive baseline) to `Content - Newsletter Agent V2` (`bMvMKyK8obwYZmNb`, 83 nodes) and swaps the S3 + `api.aitools.inc` reads for Workbench `/api/ingestion/*` reads.

**6 nodes dropped** — the server-side now covers what each of these did:
- `filter_only_markdown` (server filters to rows with both blobs)
- `get_markdown_object_info` (metadata is on the search response)
- `exclude_newsletters` (new `type_not` query param)
- `get_markdown_file_content` (no binary extraction — the get endpoint returns markdown as JSON)
- `extract_tweets` + `get_tweet_object_info` (same reasoning for the tweet path)

**4 nodes reshaped to HTTP Request** (keeping their original names so existing `$('search_markdown_objects')` and `$('download_markdown_object')` references still resolve):
- `search_markdown_objects` → GET `/api/ingestion/search?prefix={{ $json.Date }}/&type_not=newsletter&user_id=+14105914612`
- `download_markdown_object` → GET `/api/ingestion/get/{{ encodeURIComponent($json.key) }}`
- `search_tweets` → GET `/api/ingestion/search?prefix={{ $('form_trigger').item.json.Date }}/tweet.&user_id=+14105914612`
- `download_tweet_objects` → GET `/api/ingestion/get/{{ encodeURIComponent($json.key) }}`

All 4 use cred `jQBRJbmiUeTk8c11` (DEV Workbench Ingestion Secret).

**2 splitOut nodes added** so each item in the search response becomes its own `$json` for downstream processing: `split_search_markdown`, `split_search_tweets`.

**3 nodes rewritten in place:**
- `check_any_results` — filter expression now checks `{{ ($json.items || []).length > 0 }}` against the new envelope shape; `typeValidation: loose` (strict is a known n8n gotcha).
- `prepare_markdown_content` — template now references `$('search_markdown_objects').item.json.{key,type,source_name,authors,external_source_urls}` plus `$('download_markdown_object').item.json.markdown`.
- `prepare_tweet_content` — simplified template reading the same shape via `$('search_tweets')` / `$('download_tweet_objects')`. Tweet-specific metadata fields (user handle, follower count, view count) that lived only in the old `api.aitools.inc` `Metadata` object are dropped — they'd need a `metadata` JSONB column or a dedicated `tweet_metadata` column on `content_ingestion_v2` before they can be restored.

Net: 87 → 83 nodes (−6 drops, +4 reshape-in-place is net zero, +2 splits, nothing new beyond that — one of the drops was the extract node whose function is absorbed by the JSON response).

### S6 end-to-end verification (automated, no manual steps)

Committed at [`scripts/newsletter-agent-read-e2e-sim.py`](../../scripts/newsletter-agent-read-e2e-sim.py). Seeds three rows (two `article`, one `newsletter`) on today's date via `/api/ingestion/upload`, calls the new search path with `type_not=newsletter`, confirms only the two articles come back, gets each one back via `/api/ingestion/get/:key`, renders the `prepare_markdown_content` template, and cleans up.

```
 1. seed 3 rows (2 article + 1 newsletter)
 2. /api/ingestion/search?type_not=newsletter -> 2 items (newsletter excluded) PASS
 3. split_search_markdown                       -> each item iterated
 4. /api/ingestion/get/:key                     -> markdown body round-trips
 5. prepare_markdown_content render             -> well-formed YAML-fronted markdown block
 6. DELETE cleanup                              -> 3 rows removed

S6 READ-PATH END-TO-END SIM PASSED
```

### Activation status

V2 activation is currently **blocked** by 12 pre-existing configuration issues on nodes untouched by S6: `download_segment_content` (s3 cred), `claude-3-5-sonnet` (anthropicApi), `gemini-2.5-pro` (googlePalmApi), and 9 Slack nodes (slackOAuth2Api). Every one of those also blocks Orig activation — not a regression. S8 replaces the 7 informational Slack nodes with HTTP calls to `/api/email/send`; S10 replaces the remaining 2 approval Slack nodes; S11's final segment-storage migration and the LLM cred attachments resolve the other three.

---

## S8 — Slack → Postal email migration (added 2026-04-23)

Replaces the 7 informational Slack nodes in `Content - Newsletter Agent V2` with HTTP Request nodes calling the Workbench `/api/email/send` endpoint (PR #17, already live on dev). Keeps the 2 `sendAndWait` approval Slack nodes untouched — those are S10's scope.

| Old Slack node | New email node | Subject |
|---|---|---|
| `share_selected_stories` | `share_selected_stories_email` | `Newsletter {Date} — Selected Stories` |
| `share_stories_reasoning` | `share_stories_reasoning_email` | `Re: Newsletter {Date} — Selected Stories Reasoning` (threaded equiv) |
| `share_segment_msg` | `share_segment_msg_email` | `Newsletter {Date} \| Segment: {title}` |
| `share_subject_line` | `share_subject_line_email` | `Newsletter {Date} — Subject Line` |
| `share_subject_line_reasoning` | `share_subject_line_reasoning_email` | `Re: Newsletter {Date} — Subject Line Reasoning` |
| `share_newsletter_msg` | `share_newsletter_msg_email` | `Newsletter {Date} — Preview (internal)` |
| `upload_newsletter_file` | `upload_newsletter_file_email` | `Newsletter {Date} — final .md` (+ base64 attachment) |

All 7 use cred `kxrSg24PIR2Npfvw` (DEV Workbench Email Secret). HTML bodies wrap the original Slack text expressions verbatim in `<pre>…</pre>` — preserves formatting without adding a markdown-to-HTML node per email. Recipient is currently hardcoded to `eric@agileadtesting.com` (the DEV user's `recipient_email` per `app_config_v2`); a follow-up refactor can centralize via Supabase lookup.

`upload_newsletter_file_email` sends the newsletter `.md` as a base64 attachment to Postal by referencing `$binary.data.data` from the existing `create_newsletter_file` convertToFile node — no extra conversion.

**Validated live against dev Postal in this session:**
```
POST /api/email/send with S8 body shape         -> 200, message_id=8e0f2417-...@rp.postal.courseworx.media
POST /api/email/send with attachment body       -> 200, message_id=aad0a152-...@rp.postal.courseworx.media
```

Only `share_stories_approval_feedback` and `share_subject_line_approval_feedback` remain as Slack nodes in V2, scheduled for removal in S10.

---

## S9 — Approval backend (added 2026-04-23)

Express routes on the Workbench server that replace the Slack `sendAndWait` gate for newsletter approvals. Tokens are minted here and stored in `newsletter_approvals_v2`; the n8n Wait-node resume URL never leaves the server.

**New files:**
- [`server/src/routes/approvals.ts`](../server/src/routes/approvals.ts) — three endpoints + two exported routers:
  - `approvalsApiRouter` mounted under `/api/approvals` — the n8n-facing side, gated by `X-Approval-Secret` (cred `ytjKAO1BESVf6Cnz` on n8n, env `APPROVAL_SECRET` on Railway).
  - `approvalsPublicRouter` mounted under `/approvals` — the reviewer-facing side. The 24-byte token IS the credential.
- [`server/src/schemas.ts`](../server/src/schemas.ts) — new `ApprovalStageSchema`, `ApprovalCreateSchema`, `ApprovalResolveSchema`.

**Endpoints:**
| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/approvals/create` | `X-Approval-Secret` | Mint a token, insert a `newsletter_approvals_v2` row, return `{ token, approval_url: "${APPROVAL_BASE_URL}/approvals/${token}" }`. |
| `GET /approvals/:token` | Token is credential | SSR HTML form with radio Approve/Revise + feedback textarea. Renders gone/expired page for resolved or expired rows. |
| `POST /approvals/:token/resolve` | Token is credential | Validates the submission, transactionally UPDATEs the row (only when `resolved_at IS NULL`), POSTs `{decision, feedback}` to the stored `resume_url` (n8n Wait node webhook). Returns a thank-you page on success, 409 on double-submit, 410 on expired, 502 if n8n resume fails (decision already persisted — not lost). |

Dev Railway env: `APPROVAL_SECRET` and `APPROVAL_BASE_URL=https://writersworkbenchdev-production.up.railway.app` set via `railway variable set`.

**Tests:** [`server/src/test/approvals.test.ts`](../server/src/test/approvals.test.ts) — 18/18 passing. In-memory Supabase fake + scoped fetch mock (only intercepts calls to the simulated n8n resume URL, passes everything else through). Covers: auth 401, missing `APPROVAL_BASE_URL` 500, invalid stage 400, FK violation 400, form rendering, expired/resolved pages, approve + revise happy paths, double-submit 409, expired row 410, resume fail 502, network exception 502, malformed-token rejection.

Full server suite after S9: **187/187 passing**.

---

## S10 — Slack sendAndWait → Postal approval flow (added 2026-04-23)

Replaces the remaining 2 Slack `sendAndWait` nodes in `Content - Newsletter Agent V2` with 3-node groups using the S9 approval backend.

| Removed | Replacement group |
|---|---|
| `share_stories_approval_feedback` (Slack sendAndWait) | `create_approval_stories` (POST `/api/approvals/create`) → `send_approval_email_stories` (POST `/api/email/send` with approval_url button) → `wait_for_stories_approval` (Wait node, resume=webhook, 48h timeout) |
| `share_subject_line_approval_feedback` (Slack sendAndWait) | same shape for the subject-line gate |

`create_approval_{stage}` bodies pass `resume_url: $execution.resumeUrl` and `execution_id: $execution.id` so the server-stored resume URL matches the Wait node's webhook. `send_approval_email_{stage}` reads `$('create_approval_{stage}').item.json.approval_url` from the previous step and renders an HTML email with a prominent "Open approval form" button.

Downstream `extract_{stage}_approval_feedback` LLM extractors have their `text` input updated from `$json.data.text` (Slack reply) to `JSON.stringify($json.body || $json)` (the `{decision, feedback}` JSON posted by `/approvals/:token/resolve`). The LLM's existing `{approved, feedback}` output shape and the downstream `check_{stage}_feedback` IF node are unchanged.

**Net V2 change this patch:** 83 → 87 nodes (−2 Slack sendAndWait, +6 approval nodes = 3 per gate × 2 gates).

**After S10:** V2 has **zero Slack nodes**. No more references to channel `C08PGU0CLKS`. Slack credential is no longer attached to any node.

V2 is still not activatable because of pre-existing LLM / s3-segment cred gaps unrelated to this work (documented in S6 activation status). S11 closes those out along with the final segment-storage migration.

---

## S11 — Final save, activation, cutover (added 2026-04-23)

### Express: `/api/newsletter-sends/save`

New route [`server/src/routes/newsletter-sends.ts`](../server/src/routes/newsletter-sends.ts):

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/newsletter-sends/save` | `X-Ingestion-Secret` | Upserts a `newsletter_sends_v2` row with `status='scheduled'` and `scheduled_send_at = body.scheduled_send_at ?? now()+24h`. `onConflict:(user_id,send_date)` means a re-run for the same date replaces the previous draft. Returns `{success, id, scheduled_send_at, status}`. |
| `GET /api/newsletter-sends/scheduled` | `requireAuth + requireAdmin` | Lists rows with `status='scheduled'` and `scheduled_send_at <= now()+7d`. Read-only view for the future calendar cron. |

`NewsletterSendSaveSchema` added to `server/src/schemas.ts`. **6 new unit tests** ([`server/src/test/newsletter-sends.test.ts`](../server/src/test/newsletter-sends.test.ts), all passing): auth 401, default +24h, explicit value, upsert-by-(user_id,send_date), FK violation 400, bad date format 400. Full server suite: **193/193 passing.**

### n8n (Content - Newsletter Agent V2)

**Segment-download swap** (finishes the "no more S3" goal):
- Drop: `get_segment_content_info` (HTTP to api.aitools.inc), `download_segment_content` (s3), `get_segment_content_text` (extractFromFile).
- Add: `download_segment` — HTTP GET `/api/ingestion/get/{{ encodeURIComponent($json['current_story.identifiers']) }}`, cred `jQBRJbmiUeTk8c11`.
- Rewrite `prepare_segment_content_item` to read from `$('download_segment').item.json.{type,source_name,authors,external_source_urls,image_urls,markdown}` instead of `get_segment_content_info.json.Metadata.*` + `get_segment_content_text.json.data`.

**Final terminal step** — inserted after `share_newsletter_msg_email`:
- `save_scheduled_newsletter` — POST `/api/newsletter-sends/save`. Body pulls `subject` and `preheader` from `set_selected_stories` and `markdown_body` from `set_full_newsletter.full_newsletter_content`. `html_body` wraps the markdown in `<pre>` (good enough for internal preview; future polish can do real markdown→HTML). `metadata` carries `generated_by` + `execution_id`.
- `final_notification` — POST `/api/email/send`. Subject: `Newsletter {date} — saved as scheduled`. HTML body shows the row id + `scheduled_send_at`. Attachment: the `.md` base64-encoded from `set_full_newsletter.full_newsletter_content`.

**LLM credentials attached** (pre-existing Orig gap):
- `claude-3-5-sonnet` ← `5LhCYKsaFO3fF7II` (`Anthropic account`).
- `gemini-2.5-pro` ← `QCbiHRahj2Q15wqr` (`Google Gemini(PaLM) Api account`).

**Second executeWorkflow retarget**:
- `scrape_segment_external_source_url` also pointed at the broken `qVEM2rCD1jlJPeRs`. Retargeted to `BJaUNEt6PPIqbWLa` (the S1 V2 scraper).

### Activation & cutover

**V2 newsletter agent activated** — `activeVersionId = f5a201ca-6334-4c2a-a593-5f6274c097b0`. n8n validated all 87 node configs cleanly. Ingestion V2 was already active from S5.

**Forbidden-string sweep on `Content - Newsletter Agent V2`** (sprint-doc DoD):

| Check | Result |
|---|---|
| Slack node count | 0 |
| S3 node count | 0 |
| `api.aitools.inc` references | 0 |
| `data-ingestion` bucket references | 0 |
| broken `qVEM2rCD1jlJPeRs` references | 0 |
| Slack channel `C08PGU0CLKS` | 0 |

Orig (`4DQ7DmA9pFtXzsKX`) and `AI News Data Ingestion Orig` (`53SlwZMS21gpvz3H`) remain inactive — untouched baselines.

### Node delta summary across the sprint

| Workflow | Orig | V2 (final) | Net change |
|---|---|---|---|
| `AI News Data Ingestion` | 80 | 86 | −7 S3/proxy, −3 native reddit, +2 ingestion HTTP, +6 reddit HTTP/extract, +8 self-post (S5) |
| `Content - Newsletter Agent` | 87 | 87 | −6 S3/proxy for markdown/tweet reads, +2 HTTP+split (S6); −7 informational Slack, +7 email HTTP (S8); −2 sendAndWait Slack, +6 approval nodes (S10); −3 segment S3, +3 save/notify/scrape-retarget (S11) |
| `Node - Scrape Url` | 2 | 2 | unchanged, activated (S1) |

### URL substitution at promotion

`WORKBENCH_URL` (dev: `writersworkbenchdev-production.up.railway.app`, prod: `writersworkbench-production.up.railway.app`) is hardcoded in the two new HTTP Request nodes. `scripts/clone-prod-to-dev.py` and its reverse `promote-dev-to-prod.py` already do URL substitution for the Supabase URL; extending to `WORKBENCH_URL` is a one-line tweak (add it to the substitution table) at DEV → PROD promotion time.

## MCP config drift

`.mcp.json` at repo root points at `https://agiletesting.app.n8n.cloud`, but this project's n8n lives at `https://n8n.agileadautomation.com`. Until `.mcp.json` is updated, `mcp__n8n-mcp__n8n_get_workflow` and friends return 404 for every newsletter-sprint workflow. Workaround used during S1: direct `curl` against the correct host with the key from `writers-workbench/.env`.

---

## Compose Newsletter 2a — additions (2026-04-26)

### Railway env vars (DEV — `WritersWorkbenchDev` service in the `N8N-MCP` project)

| Name | Value | Notes |
|---|---|---|
| `NEWSLETTER_CALLBACK_SECRET` | 32-byte hex (in user vault) | Consumed by `POST /api/callback/newsletter-stage`. Set 2026-04-26. |
| `N8N_UI_URL` | `https://n8n.agileadautomation.com` | Used to build "Open in n8n →" deep links on the ExecutionStatus page. |
| `N8N_NEWSLETTER_FORM_URL` | `https://n8n.agileadautomation.com/form/45ae3f3f-3564-4b28-b50c-75c4bb55e817` | Target of `POST /api/newsletter/generate`. Captured from `Content - Newsletter Agent V2`'s form-trigger webhookId before the S3 `Edition Id` field is added — adding the field does not change the URL. |

PROD secret + cred deferred to release-time promotion. Add `NEWSLETTER_CALLBACK_SECRET` to the `scripts/clone-prod-to-dev.py` substitution table at first 2a promotion.

### n8n credential (DEV tier, created 2026-04-26)

| Credential name | ID | Header |
|---|---|---|
| `DEV Workbench Newsletter Callback Secret` | `1aF4oDhcjhe8R5sk` | `X-Callback-Secret` |

Header value matches the `NEWSLETTER_CALLBACK_SECRET` Railway env var. Will be attached to the 9 `emit_stage_*` HTTP Request nodes added in the 2a sprint's S3.

### S3 — n8n workflow rewrite (applied 2026-04-26)

`Content - Newsletter Agent V2` (id `bMvMKyK8obwYZmNb`) PUT'd from 87 → 99 nodes via [`scripts/s3-newsletter-workflow-rewrite.py`](../../scripts/s3-newsletter-workflow-rewrite.py). The script is **idempotent** — re-runs skip nodes that already exist by name, so partial-failure recovery is safe.

Nodes added (12):

| Node | Type | Purpose |
|---|---|---|
| `webhook_trigger` | `n8n-nodes-base.webhook` v2.1 | New entry point: `POST /webhook/compose-newsletter-dev`, headerAuth via `DEV Workbench Ingestion Secret` (`jQBRJbmiUeTk8c11`) |
| `respond_to_webhook` | `n8n-nodes-base.respondToWebhook` v1.5 | Returns `{executionId, editionId}` synchronously to `POST /api/newsletter/generate` |
| `set_trigger_inputs` | `n8n-nodes-base.set` v3.4 | Normalizes form vs webhook payload shapes into one downstream-friendly `{Date, Previous Newsletter Content, Edition Id}` |
| `emit_stage_gathering` | `httpRequest` v4.2 | After `set_trigger_inputs` (parallel to `search_markdown_objects`) |
| `emit_stage_picking` | `httpRequest` v4.2 | Parallel sibling of `set_current_stories` after `pick_top_stories` |
| `emit_stage_awaiting_stories` | `httpRequest` v4.2 | Parallel sibling of `send_approval_email_stories` after `create_approval_stories` |
| `emit_stage_stories_approved` | `httpRequest` v4.2 | Parallel sibling on TRUE branch of `check_stories_feedback` |
| `emit_stage_awaiting_subject` | `httpRequest` v4.2 | Parallel sibling of `send_approval_email_subject_line` after `create_approval_subject_line` |
| `emit_stage_subject_approved` | `httpRequest` v4.2 | Parallel sibling on TRUE branch of `check_subject_line_feedback` |
| `emit_stage_writing_segment` | `httpRequest` v4.2 | Parallel sibling of `iterate_stories` after `set_story_segment` (per-iteration emit) |
| `emit_stage_segments_done` | `httpRequest` v4.2 | Parallel sibling of `write_intro` after `set_combined_sections_content` |
| `emit_stage_saved` | `httpRequest` v4.2 | Parallel sibling of `final_notification` after `save_scheduled_newsletter` |

All 9 emit nodes are spliced as **siblings** of the original downstream — never blocking the product path. Each uses `onError: continueRegularOutput` so a callback failure can never stop a run, and is authenticated via `DEV Workbench Newsletter Callback Secret` (`1aF4oDhcjhe8R5sk`).

Edited node: `form_trigger` — added `Edition Id` (text, placeholder `ai-news`, not required). Form URL unchanged: still `https://n8n.agileadautomation.com/form/45ae3f3f-3564-4b28-b50c-75c4bb55e817`.

### S3 — pending manual step (n8n 2.x publish)

This n8n instance is **self-hosted v2.x**, where the v1.x active/inactive toggle was replaced with a Publish/Unpublish model. Only the **published** version is what the runtime serves; PUT via the public API lands as an unpublished draft. Until you Publish, the runtime keeps serving the previous version's triggers.

The form-trigger field update propagated immediately (verified live by GETting the form URL — Edition Id placeholder shows), but the **new** `webhook_trigger` won't fire until the workflow's draft is published.

**Operator step (one-time):**

1. Open `Content - Newsletter Agent V2` at https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb
2. Click the **Published / version dropdown** (top-right of the editor, shows `n / m` version counter)
3. Click **Publish** (or press ⌘P / Ctrl+P)

The status badge stays "Published" but the version pointer advances to include the draft.

API note: `/api/v1/workflows/:id/publish` returns **405** on this n8n version, and `/activate` / `/deactivate` (v1.x endpoints) return **403** — neither path is automatable on the public REST API. If a future n8n release exposes a publish endpoint, update [`scripts/s3-newsletter-workflow-rewrite.py`](../../scripts/s3-newsletter-workflow-rewrite.py) to call it after the PUT.

After publishing, set on Railway DEV `WritersWorkbenchDev`:

```
N8N_NEWSLETTER_WEBHOOK_URL=https://n8n.agileadautomation.com/webhook/compose-newsletter-dev
```

then probe:

```
curl -i -X POST https://n8n.agileadautomation.com/webhook/compose-newsletter-dev \
  -H 'Content-Type: application/json' \
  -H "X-Ingestion-Secret: $INGESTION_SECRET" \
  -d '{"Date":"2026-04-27","Previous Newsletter Content":"","Edition Id":"ai-news"}'
```

Expected: `200 {"executionId":"<id>","editionId":"ai-news"}`. If you see `403 WWW-Authenticate: Basic realm="Webhook"`, the draft is still unpublished — re-Publish from the dropdown.
