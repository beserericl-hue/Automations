---
name: Ingestion routes
description: Newsletter ingestion shared-secret API. n8n cron calls these to upload + dedupe scraped articles.
type: concept
tags: [backend, ingestion, newsletter, sprint-newsletter]
last_reviewed: 2026-05-09
---

# Ingestion routes

[`server/src/routes/ingestion.ts`](../../../../writers-workbench/server/src/routes/ingestion.ts). Sprint Newsletter S3.

All routes gated by `requireSecret('X-Ingestion-Secret', 'INGESTION_SECRET')`. The cron workflow's n8n credential `jQBRJbmiUeTk8c11` carries the DEV value; PROD will get its own at promotion.

## Endpoints

### `POST /upload`

Accepts a markdown + HTML pair plus metadata, stores both blobs in `newsletter-ingestion` bucket, INSERTs/UPSERTs `content_ingestion_v2` row.

```ts
Request body (Zod IngestionUploadSchema):
{
  user_id: string,                  // E.164
  key: string,                      // e.g. "2026-04-23/+14105914612/techcrunch-ai-news"  (no .md/.html suffix; server appends)
  source_id: string,                // FK to newsletter_feed_sources_v2 (id)
  source_name: string,              // human-readable
  title: string,
  url: string,
  published_at: string,             // ISO
  markdown: string,                 // body
  html: string,                     // body
  metadata?: object,                // arbitrary
}
```

Server flow:
1. Validate key regex: rejects `..`, leading `/`, null bytes, `.md` / `.html` suffixes (server appends).
2. Upload `<key>.md` to `newsletter-ingestion` bucket via service-role.
3. Upload `<key>.html`.
4. UPSERT into `content_ingestion_v2`:
   ```sql
   INSERT INTO content_ingestion_v2 (key, user_id, source_id, source_name, title, url, published_at, ingested_at, metadata)
   VALUES (...)
   ON CONFLICT (key) DO UPDATE SET ingested_at = now(), metadata = EXCLUDED.metadata
   ```
5. On partial failure (e.g. blob up but DB insert down), best-effort delete the blobs.
6. FK violation → 400 `FK_VIOLATION` (caller misbehaving — tells client error from server breakage).

Response: `{success: true, key, content_id}`.

### `GET /search`

Metadata listing by key prefix.

```
GET /search?prefix=2026-04-23/&user_id=%2B14105914612&type_not=approval
```

`type_not` filter excludes ingested approvals from listing (newsletter approvals share the same bucket). Capped at 500 rows.

Response: `{success: true, items: [...]}`.

### `GET /get/:key`

Metadata + both blobs for a specific key. URL-decode the param.

Response: `{success: true, item: {...metadata}, markdown, html}`.

404 if metadata row missing. 500 `BLOB_MISSING` if metadata exists but the storage object is gone (e.g. bucket wipe).

### `GET /mine/days`

Authenticated (user JWT, NOT shared secret). Returns list of dates with content for the current user. Used by IngestionBrowser sidebar.

```
GET /mine/days
→ {success: true, days: [{date: '2026-04-23', count: 17}, ...]}
```

## Path-traversal guard

Belt-and-braces:

1. **Zod regex** (compile time):
   ```ts
   const KEY_REGEX = /^[a-zA-Z0-9_\-\/\+\.]+$/;
   const IngestionKeySchema = z.string().regex(KEY_REGEX).refine(s => !s.includes('..') && !s.startsWith('/') && !s.endsWith('.md') && !s.endsWith('.html'));
   ```
2. **Runtime check** in the route handler after URL decoding:
   ```ts
   const decoded = decodeURIComponent(req.params.key);
   if (decoded.includes('..') || decoded.startsWith('/')) return res.status(400);
   ```

Either alone catches the test cases. Both means a future schema relaxation can't silently open a hole.

## Operational decision (n8n config path)

**Finding (Newsletter S3):** n8n Community edition does not allow `$env.*` references in expressions. So `WORKBENCH_URL`, `INGESTION_SECRET`, etc. cannot ship as n8n env vars.

**Decision:** per-tier n8n `httpHeaderAuth` credentials for shared secrets; URLs and identity values **hardcoded in workflow JSON** and substituted by `scripts/clone-prod-to-dev.py` during release promotion.

| Credential | DEV | PROD |
|------------|-----|------|
| Workbench Ingestion Secret | `jQBRJbmiUeTk8c11` | (created at promotion) |
| Workbench Email Secret | `kxrSg24PIR2Npfvw` | (created at promotion) |
| Workbench Approval Secret | `ytjKAO1BESVf6Cnz` | (created at promotion) |

## Storage layout

```
newsletter-ingestion/
├── 2026-04-23/
│   ├── +14105914612/
│   │   ├── techcrunch-ai-news.md
│   │   └── techcrunch-ai-news.html
│   ├── +14105914612/
│   │   └── ...
│   └── +17063338699/
│       └── ...
└── 2026-04-24/
    └── ...
```

Date prefix scoped per user_id. Service-role-only on the bucket; clients can't enumerate other users' content.

## Tests

`server/src/test/ingestion.test.ts` — 17 tests, all passing. In-memory Supabase fake mocks Storage + table builder chain. Covers:
- Happy path upload + search + get.
- Path traversal `../` rejection.
- Suffix `.md` / `.html` rejection.
- FK violation → 400.
- Blob missing → 500 BLOB_MISSING.
- Rate limit (none on ingestion side — cron is trusted).

## Common gotchas

- **URL-encode `+`** in user_id query params. PostgREST treats `+` as space (real bug from `hotfix-backfill-story-bible-prod.py`). Use `encodeURIComponent`.
- **Service-role required** for bucket access — anon key can't read `newsletter-ingestion`.
- **Idempotency:** UPSERT on `(key)` means re-running the cron on the same key updates `ingested_at` instead of erroring.
- **`type_not=approval`** filter is required when listing dailies — without it, approval blobs show up alongside articles.
- **`X-Ingestion-Secret`** must be present + correct. 401 otherwise. 503 if env var unset (distinguishes config error).
- **Path traversal guard runs AFTER URL decode** — Zod alone isn't enough because `%2e%2e` slips through.
