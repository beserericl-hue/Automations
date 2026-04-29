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
