import { Router, Request, Response } from 'express';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { IngestionSearchQuerySchema, IngestionUploadSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';

export const ingestionRouter = Router();

const BUCKET = 'newsletter-ingestion';
const MAX_SEARCH_RESULTS = 500;

// Defensive guard mirroring the Zod schema. Applied on the route's path
// param too (after URL decoding) — Zod only sees the body.
function isUnsafeKey(key: string): boolean {
  if (!key) return true;
  if (key.length > 512) return true;
  if (key.includes('\0')) return true;
  if (key.startsWith('/')) return true;
  if (key.includes('..')) return true;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return true;
  return false;
}

const requireIngestionSecret = requireSharedSecret('X-Ingestion-Secret', 'INGESTION_SECRET');

/**
 * @openapi
 * /ingestion/upload:
 *   post:
 *     tags: [Ingestion]
 *     summary: Upload a scraped source item (n8n -> Express)
 *     description: |
 *       Uploads the markdown + html blob pair for one ingested item and
 *       upserts its metadata row in `content_ingestion_v2`. Replaces the
 *       old S3 / EC2 proxy path. Called from the AI News Data Ingestion
 *       V2 workflow. Protected by X-Ingestion-Secret shared header.
 *     parameters:
 *       - in: header
 *         name: X-Ingestion-Secret
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, user_id, type, source_name, markdown, html]
 *             properties:
 *               key:          { type: string, description: "date-prefixed path, no extension, no ..  e.g. 2026-04-21/meta-engineer.techcrunch" }
 *               user_id:      { type: string }
 *               type:         { type: string, enum: [article, reddit_post, tweet, newsletter] }
 *               title:        { type: string, nullable: true }
 *               authors:      { type: string, nullable: true }
 *               source_name:  { type: string }
 *               source_url:   { type: string, nullable: true }
 *               external_source_urls: { type: array, items: { type: string } }
 *               image_urls:   { type: array, items: { type: string } }
 *               reddit_metadata:       { type: object, nullable: true }
 *               published_timestamp:   { type: string, format: date-time, nullable: true }
 *               feed_url:     { type: string, nullable: true }
 *               markdown:     { type: string }
 *               html:         { type: string }
 *     responses:
 *       200: { description: Uploaded and row upserted }
 *       400: { description: Validation / path-traversal / FK violation }
 *       401: { description: Missing or invalid X-Ingestion-Secret }
 *       500: { description: Upload to storage succeeded but DB insert failed and cleanup also failed }
 */
ingestionRouter.post(
  '/upload',
  requireIngestionSecret,
  validateBody(IngestionUploadSchema),
  async (req: Request, res: Response) => {
    const body = req.body as import('zod').infer<typeof IngestionUploadSchema>;
    const {
      key, user_id, type, title, authors, source_name, source_url,
      external_source_urls, image_urls, reddit_metadata,
      published_timestamp, feed_url, markdown, html,
    } = body;

    // Belt + braces: Zod already enforced this, but double-check before touching storage.
    if (isUnsafeKey(key)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_KEY', message: 'key failed safety validation' },
      });
      return;
    }

    const supabase = getSupabaseAdmin();
    const storagePathMd = `${key}.md`;
    const storagePathHtml = `${key}.html`;

    // Upload both blobs. Run in parallel; we need both anyway.
    // Supabase bucket allowed_mime_types is a strict string match — the bucket
    // allowlist is ['text/markdown','text/html','text/plain'], so the Content-Type
    // here must match exactly. Appending '; charset=utf-8' rejects the upload.
    const [mdResult, htmlResult] = await Promise.all([
      supabase.storage.from(BUCKET).upload(storagePathMd, Buffer.from(markdown, 'utf-8'), {
        contentType: 'text/markdown',
        upsert: true,
      }),
      supabase.storage.from(BUCKET).upload(storagePathHtml, Buffer.from(html, 'utf-8'), {
        contentType: 'text/html',
        upsert: true,
      }),
    ]);

    if (mdResult.error || htmlResult.error) {
      const err = mdResult.error || htmlResult.error;
      logger.error({ err, key }, 'ingestion upload: storage upload failed');
      // Best-effort cleanup: if one succeeded and the other failed, drop the
      // orphan so the bucket doesn't accumulate half-items.
      const succeeded: string[] = [];
      if (!mdResult.error) succeeded.push(storagePathMd);
      if (!htmlResult.error) succeeded.push(storagePathHtml);
      if (succeeded.length > 0) {
        await supabase.storage.from(BUCKET).remove(succeeded).catch(() => {});
      }
      res.status(500).json({
        success: false,
        error: { code: 'STORAGE_UPLOAD_FAILED', message: err?.message || 'Storage upload failed' },
      });
      return;
    }

    // Upsert the metadata row.
    const { error: dbError } = await supabase
      .from('content_ingestion_v2')
      .upsert({
        key,
        user_id,
        type,
        title: title ?? null,
        authors: authors ?? null,
        source_name,
        source_url: source_url ?? null,
        external_source_urls: external_source_urls ?? [],
        image_urls: image_urls ?? [],
        reddit_metadata: reddit_metadata ?? null,
        published_timestamp: published_timestamp ?? null,
        feed_url: feed_url ?? null,
        storage_path_md: storagePathMd,
        storage_path_html: storagePathHtml,
        deleted_at: null,
      }, { onConflict: 'key' });

    if (dbError) {
      logger.error({ dbError, key }, 'ingestion upload: row upsert failed');
      // Clean up the blobs we just uploaded — otherwise the bucket
      // gets content we can't reach via the metadata table.
      await supabase.storage.from(BUCKET).remove([storagePathMd, storagePathHtml]).catch(() => {});

      // Surface FK violation as 400 so the caller can distinguish client
      // error from server breakage.
      const code = (dbError as { code?: string }).code;
      if (code === '23503') {
        res.status(400).json({
          success: false,
          error: { code: 'FK_VIOLATION', message: 'user_id does not exist in users_v2' },
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: { code: 'DB_INSERT_FAILED', message: dbError.message },
      });
      return;
    }

    res.json({ success: true, key });
  },
);

/**
 * @openapi
 * /ingestion/search:
 *   get:
 *     tags: [Ingestion]
 *     summary: List ingested items by key prefix (n8n -> Express)
 *     description: |
 *       Returns metadata rows (no body blobs) whose `key` starts with
 *       `prefix`. Drives the newsletter agent's date-prefix search
 *       ('2026-04-21/'). Protected by X-Ingestion-Secret shared header.
 *     parameters:
 *       - in: header
 *         name: X-Ingestion-Secret
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: prefix
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: type_not
 *         required: false
 *         schema: { type: string, enum: [article, reddit_post, tweet, newsletter] }
 *     responses:
 *       200: { description: Array of metadata rows (capped at 500) }
 *       400: { description: Validation failure }
 *       401: { description: Missing or invalid X-Ingestion-Secret }
 */
ingestionRouter.get('/search', requireIngestionSecret, async (req: Request, res: Response) => {
  const parsed = IngestionSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', fields } });
    return;
  }

  const { prefix, user_id, type_not } = parsed.data;

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('content_ingestion_v2')
    .select('id, key, user_id, type, title, authors, source_name, source_url, external_source_urls, image_urls, reddit_metadata, published_timestamp, feed_url, storage_path_md, storage_path_html, created_at, updated_at')
    .eq('user_id', user_id)
    .is('deleted_at', null)
    .like('key', `${prefix}%`)
    .order('created_at', { ascending: false })
    .limit(MAX_SEARCH_RESULTS);

  if (type_not) {
    query = query.neq('type', type_not);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ error, prefix, user_id }, 'ingestion search failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }

  res.json({ success: true, items: data || [] });
});

/**
 * @openapi
 * /ingestion/get/{key}:
 *   get:
 *     tags: [Ingestion]
 *     summary: Fetch one ingested item with its body blobs (n8n -> Express)
 *     description: |
 *       URL-decode the :key path param, look up the metadata row, download
 *       both markdown and html from Supabase Storage, and return a single
 *       envelope. Protected by X-Ingestion-Secret shared header.
 *     parameters:
 *       - in: header
 *         name: X-Ingestion-Secret
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *         description: URL-encoded key (e.g. 2026-04-21%2Fsome-slug.source)
 *     responses:
 *       200: { description: "Metadata + { markdown, html } envelope" }
 *       400: { description: Path traversal or invalid key }
 *       401: { description: Missing or invalid X-Ingestion-Secret }
 *       404: { description: No row with that key }
 *       500: { description: Row exists but blobs are missing from storage }
 */
ingestionRouter.get('/get/:key(*)', requireIngestionSecret, async (req: Request, res: Response) => {
  // :key(*) can be string or string[] in Express types; collapse to a single string.
  const rawParam = req.params.key as unknown;
  const rawKey: string = Array.isArray(rawParam) ? rawParam.join('/') : String(rawParam ?? '');
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    res.status(400).json({ success: false, error: { code: 'INVALID_KEY', message: 'key is not URL-decodable' } });
    return;
  }

  if (isUnsafeKey(key)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_KEY', message: 'key failed safety validation' } });
    return;
  }

  const supabase = getSupabaseAdmin();
  const { data: row, error: dbError } = await supabase
    .from('content_ingestion_v2')
    .select('id, key, user_id, type, title, authors, source_name, source_url, external_source_urls, image_urls, reddit_metadata, published_timestamp, feed_url, storage_path_md, storage_path_html, created_at, updated_at')
    .eq('key', key)
    .is('deleted_at', null)
    .maybeSingle();

  if (dbError) {
    logger.error({ dbError, key }, 'ingestion get: row lookup failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: dbError.message } });
    return;
  }

  if (!row) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No ingestion row for key: ${key}` } });
    return;
  }

  // Pull both blobs in parallel.
  const [mdRes, htmlRes] = await Promise.all([
    supabase.storage.from(BUCKET).download(row.storage_path_md),
    supabase.storage.from(BUCKET).download(row.storage_path_html),
  ]);

  if (mdRes.error || !mdRes.data || htmlRes.error || !htmlRes.data) {
    // Row exists but blob is gone — this is a real corruption signal, not a 404.
    logger.error(
      { key, mdErr: mdRes.error, htmlErr: htmlRes.error },
      'ingestion get: blob missing from storage for existing row',
    );
    res.status(500).json({
      success: false,
      error: {
        code: 'BLOB_MISSING',
        message: `Row ${key} exists but blob is missing from storage`,
      },
    });
    return;
  }

  const [markdown, html] = await Promise.all([
    mdRes.data.text(),
    htmlRes.data.text(),
  ]);

  res.json({ success: true, ...row, markdown, html });
});
