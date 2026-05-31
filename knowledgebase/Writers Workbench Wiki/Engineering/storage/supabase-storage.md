---
name: Supabase Storage
description: All buckets across DEV and PROD, content layout, RLS policies, and client/server access patterns.
type: concept
tags: [storage, supabase]
last_reviewed: 2026-05-09
---

# Supabase Storage

Each Supabase project has its own Storage instance (which is itself backed by Cloudflare R2 internally). Six buckets in the system as of 2026-05-09; DEV has all six, PROD has four.

## Buckets

| Bucket | Public? | DEV | PROD | Purpose | Path convention |
|--------|---------|-----|------|---------|----------------|
| `author-content` | private | yes | yes | Legacy V1 attachment store; misc content | `<user_id>/<filename>` |
| `cover-images` | private | yes | yes | Generated cover art (Sprint 4) | `<user_id>/<HHMMSS>-<title>.png` |
| `social-images` | private | yes | yes | Generated social-post images (Sprint 4) | `<user_id>/<post_id>-<HHMMSS>.png` |
| `writing-samples` | private | yes | yes | User-uploaded reference style samples (Sprint 4) | `<user_id>/<filename>` |
| `newsletter-ingestion` | private | yes | partial (bucket exists from migration 009 but not yet wired to PROD ingestion endpoints) | Markdown + HTML pairs from scraping (Newsletter S2) | `<YYYY-MM-DD>/<user_id>/<source>/<slug>.{md,html}` |
| `newsletter-logos` | public-read, authenticated-write | yes | NO (migration 017 not applied) | Per-edition logos (Newsletter Flow Fixes PR #70) | `<user_id>/<edition_id>.png` |

## Access patterns

### Client (browser)

Reads via signed URL or public URL (only `newsletter-logos` is public). Write via authenticated upload using anon key + JWT — RLS enforces own-folder.

```ts
// client uploading a writing sample
const { data, error } = await supabase.storage
  .from('writing-samples')
  .upload(`${userId}/${filename}`, file, { upsert: true });
```

### Server (service role)

Bypasses RLS. Used for:
- Newsletter ingestion `POST /api/ingestion/upload` — uploads markdown + HTML pair.
- Newsletter logo upload via admin path.
- KDP `.docx` export via `/api/export/:contentId`.

### n8n

Uses HTTP Request nodes with `apikey: <SUPABASE_SERVICE_ROLE_KEY>` header + path. Important: include `x-upsert: true` header to avoid "Duplicate" errors on re-runs.

```yaml
# n8n HTTP Request node config
url: =https://faklxfakgzkpkbxfihzh.supabase.co/storage/v1/object/cover-images/{{$json.user_id}}/{{HHmmss}}-cover.png
method: POST
headers:
  apikey: <service_role_key>
  authorization: Bearer <service_role_key>
  content-type: image/png
  x-upsert: 'true'
binary: true
```

Filenames include `HHMMSS` so multiple runs the same day don't overwrite.

## RLS policies (Storage)

`newsletter-logos` (public-read, owner-write):

```sql
CREATE POLICY "Public read newsletter-logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'newsletter-logos');

CREATE POLICY "Owner upload newsletter-logos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'newsletter-logos'
    AND (storage.foldername(name))[1] = get_current_user_id()
  );
```

`cover-images`, `social-images`, `writing-samples`, `author-content` (private):

```sql
CREATE POLICY "Owner read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = '<bucket>'
    AND (storage.foldername(name))[1] = get_current_user_id()
  );

CREATE POLICY "Owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (... same condition ...);
```

`newsletter-ingestion` (service-role only):

```sql
CREATE POLICY "Service role only"
  ON storage.objects FOR ALL
  USING (bucket_id = 'newsletter-ingestion' AND auth.role() = 'service_role');
```

In Phase 2 (planned), this opens up to authenticated read for the IngestionBrowser UI.

## Bucket size + retention

No automated retention policy yet. `clone-supabase-data.sh` does NOT clone storage objects — `scripts/migrate-storage.py` does, via Supabase Storage REST API (5-way concurrency, idempotent).

Size monitoring lives in `/api/admin/storage` (Sprint 6) and the Admin Panel storage tab. Per-bucket counts + bytes.

## Deletion behavior

Deleting a `published_content_v2` row does NOT delete the cover image. `cover_image_path` becomes a dangling reference. To clean up, manual sweep or an offline job (none scheduled).

Deleting a `users_v2` row cascades the DB rows but **does not** delete their storage objects — those persist in their bucket folder. Account-deletion endpoint (`/api/account`) does a best-effort sweep; failures are logged but don't block the delete.

## Content layout examples

```
cover-images/
├── +14105914612/
│   ├── 153022-the-invisible-wall-cover.png
│   ├── 161555-the-familiar-cover.png
│   └── 094510-revised-cover.png
└── +17063338699/
    └── 120030-test-cover.png

newsletter-ingestion/
├── 2026-04-23/
│   ├── +14105914612/
│   │   ├── techcrunch-ai-news.md
│   │   └── techcrunch-ai-news.html
│   └── +17063338699/
│       └── ...
└── 2026-04-24/
    └── ...

newsletter-logos/
├── +14105914612/
│   ├── 0c4c1234-edition.png
│   └── 7e89abcd-edition.png
└── ...
```

## Storage decision (planned Sprint 14)

User has flagged: **why are we using R2 when Supabase Storage already exists?** S14-0 is a written decision among:
- **Option A** — stay on Supabase Storage. Simplest. (Note: it's R2 underneath anyway.)
- **Option B** — Railway native object storage. Same vendor as compute.
- **Option C** — Cloudflare R2 directly. Cheapest at scale.

Sprint 14's S14-1..5 only execute if the decision picks B or C. See [[planned-sprints]].

## Common gotchas

- **`x-upsert: 'true'`** header is required in n8n HTTP Request nodes when you might re-run a workflow on the same day; without it, duplicate uploads return 409.
- **Filename collision** — embed timestamp `HHmmss` to allow multiple runs/day.
- **`storage.foldername(name)[1]`** in RLS policies expects the first path segment to be the user_id. Don't change to `(storage.foldername(name))[2]` without auditing all callers.
- **Public buckets** are accessible via `<project>.supabase.co/storage/v1/object/public/<bucket>/<path>`. Anyone with the URL can read. Only `newsletter-logos` is public — protects nothing else.
- **Service role can read any bucket** including private ones — code review for over-broad fetches.
