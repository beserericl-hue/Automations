/**
 * Newsletter Flow Fixes Sprint — per-edition logo upload + subscriber CRUD.
 *
 * Mounted under /api/newsletter on the same router prefix as the editions
 * CRUD; routes are prefixed with /editions/:id/logo and /editions/:id/subscribers.
 *
 * Logo upload pattern matches images.ts upload-reference: base64 in JSON
 * body, no multer dependency. Stored in the public `newsletter-logos`
 * bucket created by migration 017; the public URL is written to the
 * edition row's `stamp_url` column so the n8n render-html call (and
 * future cron-based sends) pick it up automatically.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import {
  CreateSubscriberSchema,
  UpdateSubscriberSchema,
  SubscriberIdParamSchema,
  NewsletterEditionIdParamSchema,
} from '../schemas.js';
import { logger } from '../lib/logger.js';

export const editionExtrasRouter = Router();
// Cron-secret variants — n8n calls these from the cadence + send workflows.
export const editionExtrasCronRouter = Router();

const requireIngestionSecret = requireSharedSecret('X-Ingestion-Secret', 'INGESTION_SECRET');

const SUB_COLUMNS = 'id, user_id, edition_id, email, display_name, status, source, subscribed_at, unsubscribed_at, created_at, updated_at';

// ---------------------------------------------------------------------------
// Logo upload — POST /api/newsletter/editions/:id/logo
//   body: { base64: string, filename?: string, content_type?: string }
// Writes the file to bucket `newsletter-logos` at path
//   `<user_id>/<edition_id>/<timestamp>_<original-or-stamp>.<ext>`
// then updates `newsletter_editions_v2.stamp_url` with the public URL and
// returns the stored row.
// ---------------------------------------------------------------------------

const LogoUploadSchema = z.object({
  // Capped at ~6 MB raw before base64 (8 MB encoded). The bucket's free for
  // small PNGs/SVGs and we don't want the body parser to choke on a
  // surprise multi-MB paste.
  base64: z
    .string()
    .min(1, 'base64 is required')
    .max(8 * 1024 * 1024, 'logo too large (max ~6 MB raw)'),
  filename: z.string().max(200).optional().default('logo.png'),
  content_type: z
    .string()
    .max(80)
    .regex(/^image\//, 'content_type must be an image/* MIME type')
    .optional()
    .default('image/png'),
});

editionExtrasRouter.post(
  '/editions/:id/logo',
  requireAuth,
  validateBody(LogoUploadSchema),
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
      return;
    }
    const userId = req.userId!;
    const editionId = params.data.id;
    const body = req.body as z.infer<typeof LogoUploadSchema>;
    const supabase = getSupabaseAdmin();

    // Confirm the edition belongs to the caller before writing to storage
    // (otherwise a malicious caller could fill another user's logo bucket).
    const { data: edition } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!edition) {
      res.status(404).json({ success: false, error: { code: 'EDITION_NOT_FOUND', message: 'Edition not found or not yours' } });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.base64, 'base64');
    } catch {
      res.status(400).json({ success: false, error: { code: 'INVALID_BASE64', message: 'base64 decode failed' } });
      return;
    }
    if (buffer.length === 0) {
      res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'decoded file is empty' } });
      return;
    }

    const ext = (body.filename.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    // user_id can contain a leading + (phone). We strip non-alphanum from
    // the path segment so storage doesn't have to URL-encode every read.
    const safeUid = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const storagePath = `${safeUid}/${editionId}/${ts}_logo.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('newsletter-logos')
      .upload(storagePath, buffer, {
        contentType: body.content_type,
        upsert: true,
      });
    if (uploadErr) {
      logger.error({ uploadErr, userId, editionId }, 'newsletter logo upload failed');
      res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadErr.message } });
      return;
    }

    const { data: urlData } = supabase.storage.from('newsletter-logos').getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    const { data: updated, error: dbErr } = await supabase
      .from('newsletter_editions_v2')
      .update({ stamp_url: publicUrl })
      .eq('id', editionId)
      .eq('user_id', userId)
      .select('id, stamp_url')
      .single();
    if (dbErr) {
      logger.error({ dbErr, editionId, userId }, 'newsletter logo db update failed');
      res.status(500).json({ success: false, error: { code: 'DB_UPDATE_FAILED', message: dbErr.message } });
      return;
    }

    res.status(201).json({ success: true, stamp_url: updated.stamp_url, storage_path: storagePath });
  },
);

// DELETE /api/newsletter/editions/:id/logo — clears stamp_url. Doesn't
// remove from storage (keeps history intact + the bucket is small + email
// clients with cached previews keep working).
editionExtrasRouter.delete('/editions/:id/logo', requireAuth, async (req: Request, res: Response) => {
  const params = NewsletterEditionIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
    return;
  }
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('newsletter_editions_v2')
    .update({ stamp_url: null })
    .eq('id', params.data.id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_UPDATE_FAILED', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Edition not found' } });
    return;
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Subscriber CRUD
// ---------------------------------------------------------------------------

editionExtrasRouter.get('/editions/:id/subscribers', requireAuth, async (req: Request, res: Response) => {
  const params = NewsletterEditionIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
    return;
  }
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('newsletter_subscribers_v2')
    .select(SUB_COLUMNS)
    .eq('user_id', userId)
    .eq('edition_id', params.data.id)
    .order('subscribed_at', { ascending: false });
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }
  res.json({ success: true, subscribers: data ?? [] });
});

editionExtrasRouter.post(
  '/editions/:id/subscribers',
  requireAuth,
  validateBody(CreateSubscriberSchema),
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
      return;
    }
    const userId = req.userId!;
    const editionId = params.data.id;
    const body = req.body as z.infer<typeof CreateSubscriberSchema>;
    const supabase = getSupabaseAdmin();

    // Confirm edition ownership upfront so we surface a 404 instead of a
    // 23503 FK violation from a typo.
    const { data: edition } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!edition) {
      res.status(404).json({ success: false, error: { code: 'EDITION_NOT_FOUND', message: 'Edition not found or not yours' } });
      return;
    }

    const { data, error } = await supabase
      .from('newsletter_subscribers_v2')
      .insert({
        user_id: userId,
        edition_id: editionId,
        email: body.email.toLowerCase().trim(),
        display_name: body.display_name ?? null,
        source: body.source ?? 'manual',
        status: body.status,
      })
      .select(SUB_COLUMNS)
      .single();
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        res.status(409).json({ success: false, error: { code: 'DUPLICATE_EMAIL', message: 'That email is already subscribed to this newsletter' } });
        return;
      }
      logger.error({ error, userId, editionId }, 'subscribers insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_INSERT_FAILED', message: error.message } });
      return;
    }
    res.status(201).json({ success: true, subscriber: data });
  },
);

editionExtrasRouter.put(
  '/subscribers/:id',
  requireAuth,
  validateBody(UpdateSubscriberSchema),
  async (req: Request, res: Response) => {
    const params = SubscriberIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
      return;
    }
    const userId = req.userId!;
    const body = req.body as z.infer<typeof UpdateSubscriberSchema>;
    const supabase = getSupabaseAdmin();

    // Track unsubscribed_at when transitioning to 'unsubscribed'.
    const patch: Record<string, unknown> = { ...body };
    if (body.status === 'unsubscribed') patch.unsubscribed_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('newsletter_subscribers_v2')
      .update(patch)
      .eq('id', params.data.id)
      .eq('user_id', userId)
      .select(SUB_COLUMNS)
      .maybeSingle();
    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_UPDATE_FAILED', message: error.message } });
      return;
    }
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Subscriber not found' } });
      return;
    }
    res.json({ success: true, subscriber: data });
  },
);

editionExtrasRouter.delete('/subscribers/:id', requireAuth, async (req: Request, res: Response) => {
  const params = SubscriberIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    return;
  }
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('newsletter_subscribers_v2')
    .delete()
    .eq('id', params.data.id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_DELETE_FAILED', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Subscriber not found' } });
    return;
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// CSV import — POST /editions/:id/subscribers/import
//   body: { csv: string, default_status?: 'active'|'unsubscribed', source?: string }
// Header detection: first row must contain at least an "email" header.
// Optional headers: "name" or "display_name" (either spelling).
// Other columns are ignored.
// Idempotent: ON CONFLICT DO NOTHING via the existing
//   uq_subscribers_email_per_edition unique index. Returns counts:
//     { inserted, skipped_duplicate, invalid }
// ---------------------------------------------------------------------------

const CsvImportSchema = z.object({
  // 4 MB cap on the raw CSV body — covers ~80k typical rows; keeps memory
  // pressure bounded.
  csv: z.string().min(1).max(4 * 1024 * 1024),
  default_status: z.enum(['active', 'unsubscribed']).optional().default('active'),
  source: z.string().max(60).optional().default('csv-import'),
});

function parseCsvLine(line: string): string[] {
  // Minimal RFC-4180 single-line parser: handles quoted fields with commas
  // and double-quote-escaped quotes inside a field. Doesn't handle embedded
  // newlines (we split the file on \n first, which is fine for email
  // address lists — none of the values legitimately contain newlines).
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

editionExtrasRouter.post(
  '/editions/:id/subscribers/import',
  requireAuth,
  validateBody(CsvImportSchema),
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
      return;
    }
    const userId = req.userId!;
    const editionId = params.data.id;
    const body = req.body as z.infer<typeof CsvImportSchema>;
    const supabase = getSupabaseAdmin();

    // Confirm ownership before parsing (don't waste cycles on someone else's edition).
    const { data: edition } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!edition) {
      res.status(404).json({ success: false, error: { code: 'EDITION_NOT_FOUND', message: 'Edition not found or not yours' } });
      return;
    }

    // Strip BOM and normalize line endings, then split.
    const normalized = body.csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n').filter((l) => l.length > 0);
    if (lines.length < 1) {
      res.status(400).json({ success: false, error: { code: 'EMPTY_CSV', message: 'CSV is empty' } });
      return;
    }

    // Find the email column. If the first row looks like a header, use it;
    // otherwise treat the whole file as a single "email" column.
    const headerCells = parseCsvLine(lines[0]).map((c) => c.toLowerCase());
    let emailIdx = headerCells.indexOf('email');
    let nameIdx = headerCells.indexOf('display_name');
    if (nameIdx === -1) nameIdx = headerCells.indexOf('name');
    let dataLines = lines;
    if (emailIdx !== -1) {
      dataLines = lines.slice(1); // strip header
    } else if (headerCells.length === 1 && /@/.test(headerCells[0])) {
      // Single-column file with no header — assume it's all emails.
      emailIdx = 0;
    } else {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_EMAIL_COLUMN',
          message: 'CSV must have an "email" column header (or be a single-column list of emails).',
        },
      });
      return;
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const rows: Array<{
      user_id: string; edition_id: string; email: string;
      display_name: string | null; source: string; status: 'active' | 'unsubscribed';
    }> = [];
    let invalid = 0;
    const seen = new Set<string>();
    for (const ln of dataLines) {
      const cells = parseCsvLine(ln);
      const email = (cells[emailIdx] ?? '').toLowerCase().trim();
      if (!email || !EMAIL_RE.test(email) || email.length > 254) { invalid++; continue; }
      if (seen.has(email)) continue; // dedupe within the file before hitting the DB
      seen.add(email);
      const display_name = nameIdx >= 0 ? (cells[nameIdx] ?? '').trim() || null : null;
      rows.push({
        user_id: userId,
        edition_id: editionId,
        email,
        display_name,
        source: body.source,
        status: body.default_status,
      });
    }

    if (rows.length === 0) {
      res.json({ success: true, inserted: 0, skipped_duplicate: 0, invalid });
      return;
    }

    // Dedup against existing subscribers in code — the table has no unique constraint matching
    // (user_id, edition_id, email), so a DB upsert with onConflict errors ("no unique or exclusion
    // constraint matching"). Fetch existing emails for this edition and insert only the new ones.
    const { data: existingSubs, error: existErr } = await supabase
      .from('newsletter_subscribers_v2')
      .select('email')
      .eq('edition_id', editionId);
    if (existErr) {
      logger.error({ existErr, editionId, userId }, 'csv import existing-subscriber lookup failed');
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: existErr.message } });
      return;
    }
    const existingEmails = new Set((existingSubs ?? []).map((r) => String(r.email).toLowerCase()));
    const newRows = rows.filter((r) => !existingEmails.has(r.email));

    // Insert in chunks. Postgres rejects very large parameter counts; chunk
    // size of 1000 keeps us comfortably under any common limit.
    const CHUNK = 1000;
    let totalInserted = 0;
    for (let i = 0; i < newRows.length; i += CHUNK) {
      const chunk = newRows.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from('newsletter_subscribers_v2')
        .insert(chunk)
        .select('id');
      if (error) {
        logger.error({ error, editionId, userId, chunk_size: chunk.length }, 'csv import insert failed');
        res.status(500).json({ success: false, error: { code: 'DB_INSERT_FAILED', message: error.message } });
        return;
      }
      totalInserted += (data ?? []).length;
    }

    res.status(201).json({
      success: true,
      inserted: totalInserted,
      skipped_duplicate: rows.length - totalInserted,
      invalid,
    });
  },
);

// ---------------------------------------------------------------------------
// Cron-secret routes — for the n8n send workflow + cadence cron.
// ---------------------------------------------------------------------------

// GET /api/newsletter/cron/editions/:id/subscribers
// Returns active recipients for the edition. Used by the
// share_newsletter_msg_email node to fan out to the subscriber list.
editionExtrasCronRouter.get(
  '/editions/:id/subscribers',
  requireIngestionSecret,
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
      return;
    }
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('newsletter_subscribers_v2')
      .select('id, email, display_name, status')
      .eq('edition_id', params.data.id)
      .eq('status', 'active')
      .limit(5000);
    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
      return;
    }
    res.json({
      success: true,
      subscribers: data ?? [],
      emails: (data ?? []).map((r) => r.email as string),
    });
  },
);

// GET /api/newsletter/cron/editions/due
// Returns editions that are enabled, have cadence != 'none', and are due
// for an auto-generated send. "Due" means: cadence_send_time has elapsed
// since the most-recent newsletter_sends_v2 row for the edition (or
// since edition.created_at if there are no prior sends).
//
// cadence_send_time is free-form ("HH:MM" or "HH:MM dow"). For Phase 1 we
// compute interval days from cadence (daily=1, weekly=7, biweekly=14,
// monthly=30) and compare against the most recent send_date. Time-of-day
// + day-of-week gating is a follow-up.
interface DueEdition {
  edition_id: string;
  user_id: string;
  days_since_last: number;
}

// Shared "which editions are due?" computation, used by both the read-only
// GET /editions/due (n8n cron polls it) and the engine-aware POST /editions/run-due.
async function computeDueEditions(): Promise<DueEdition[]> {
  const supabase = getSupabaseAdmin();
  const { data: editions, error } = await supabase
    .from('newsletter_editions_v2')
    .select('id, user_id, cadence, cadence_send_time, created_at')
    .eq('enabled', true)
    .neq('cadence', 'none');
  if (error) throw new Error(error.message);
  const intervalDays: Record<string, number> = {
    daily: 1, weekly: 7, biweekly: 14, monthly: 30,
  };
  const now = Date.now();
  const due: DueEdition[] = [];
  for (const ed of (editions ?? []) as Array<{ id: string; user_id: string; cadence: string; cadence_send_time: string | null; created_at: string }>) {
    const days = intervalDays[ed.cadence];
    if (!days) continue;
    const { data: lastSend } = await supabase
      .from('newsletter_sends_v2')
      .select('send_date, created_at')
      .eq('edition_id', ed.id)
      .eq('user_id', ed.user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const baseline = lastSend?.created_at ?? ed.created_at;
    const elapsedDays = (now - new Date(baseline).getTime()) / (24 * 60 * 60 * 1000);
    if (elapsedDays >= days) {
      due.push({ edition_id: ed.id, user_id: ed.user_id, days_since_last: Math.floor(elapsedDays) });
    }
  }
  return due;
}

editionExtrasCronRouter.get(
  '/editions/due',
  requireIngestionSecret,
  async (_req: Request, res: Response) => {
    try {
      const due = await computeDueEditions();
      res.json({ success: true, editions: due });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: String((err as Error).message) } });
    }
  },
);

// POST /api/newsletter/cron/editions/run-due
// Backend-aware cadence trigger (F2-9): computes due editions and enqueues a
// generation for each via the active backend — the Writer Engine when
// NEWSLETTER_BACKEND=python, else the n8n compose webhook. A single cron tick
// fans out to whichever backend is configured, so cadence works post-cutover
// without changing the cron. Returns a per-edition enqueue result.
editionExtrasCronRouter.post(
  '/editions/run-due',
  requireIngestionSecret,
  async (_req: Request, res: Response) => {
    let due: DueEdition[];
    try {
      due = await computeDueEditions();
    } catch (err) {
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: String((err as Error).message) } });
      return;
    }

    const backend = (process.env.NEWSLETTER_BACKEND ?? 'n8n').toLowerCase() === 'python' ? 'python' : 'n8n';
    const sendDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const results: Array<{ edition_id: string; enqueued: boolean; execution_id?: string; error?: string }> = [];

    for (const d of due) {
      try {
        if (backend === 'python') {
          const engineUrl = process.env.NEWSLETTER_SERVICE_URL;
          const serviceSecret = process.env.SERVICE_SHARED_SECRET;
          if (!engineUrl || !serviceSecret) {
            results.push({ edition_id: d.edition_id, enqueued: false, error: 'NOT_CONFIGURED' });
            continue;
          }
          const resp = await fetch(`${engineUrl.replace(/\/+$/, '')}/internal/newsletter/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Secret': serviceSecret },
            body: JSON.stringify({ edition_id: d.edition_id, user_id: d.user_id, send_date: sendDate, max_stories: 5 }),
          });
          if (!resp.ok) { results.push({ edition_id: d.edition_id, enqueued: false, error: `engine ${resp.status}` }); continue; }
          const body = await resp.json() as { execution_id?: string };
          results.push({ edition_id: d.edition_id, enqueued: true, execution_id: body.execution_id });
        } else {
          const webhookUrl = process.env.N8N_NEWSLETTER_WEBHOOK_URL;
          const ingestionSecret = process.env.INGESTION_SECRET;
          if (!webhookUrl || !ingestionSecret) {
            results.push({ edition_id: d.edition_id, enqueued: false, error: 'NOT_CONFIGURED' });
            continue;
          }
          const resp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': ingestionSecret },
            body: JSON.stringify({ Date: sendDate, 'Previous Newsletter Content': '', 'Edition Id': d.edition_id }),
          });
          if (!resp.ok) { results.push({ edition_id: d.edition_id, enqueued: false, error: `n8n ${resp.status}` }); continue; }
          const body = await resp.json() as { executionId?: string };
          results.push({ edition_id: d.edition_id, enqueued: true, execution_id: body.executionId });
        }
      } catch (err) {
        logger.error({ err, edition_id: d.edition_id }, 'cadence run-due: enqueue failed');
        results.push({ edition_id: d.edition_id, enqueued: false, error: 'ENQUEUE_FAILED' });
      }
    }

    res.json({ success: true, backend, due: due.length, enqueued: results.filter((r) => r.enqueued).length, results });
  },
);
