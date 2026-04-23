/**
 * Newsletter-sends backend (S11).
 *
 * The newsletter agent's final step after approvals succeed is to POST a
 * finished newsletter to /api/newsletter-sends/save. We upsert it into
 * newsletter_sends_v2 with status='scheduled' and scheduled_send_at set to
 * either the caller's value or now()+24h by default. A future calendar
 * sprint picks up status='scheduled' rows and flips them to 'sending' /
 * 'sent'; for THIS sprint nothing actively delivers to subscribers — rows
 * just accumulate.
 *
 * GET /api/newsletter-sends/scheduled is a read-only view for that future
 * calendar cron to enumerate rows due soon. Admin-restricted for now; the
 * calendar sprint can widen it to a service-role bearer or its own shared
 * secret.
 */
import { Router, Request, Response } from 'express';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { NewsletterSendSaveSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';

export const newsletterSendsRouter = Router();

const requireIngestionSecret = requireSharedSecret('X-Ingestion-Secret', 'INGESTION_SECRET');

/**
 * @openapi
 * /newsletter-sends/save:
 *   post:
 *     tags: [Newsletter]
 *     summary: Park a finished newsletter for the future calendar cron (n8n -> server)
 *     description: |
 *       Upserts a row in newsletter_sends_v2 with status='scheduled'. The
 *       unique index on (user_id, send_date) where status != 'cancelled'
 *       means a re-run for the same date replaces the previous draft.
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
 *             required: [user_id, send_date, subject, html_body]
 *             properties:
 *               user_id:           { type: string }
 *               send_date:         { type: string, format: date }
 *               subject:           { type: string }
 *               preheader:         { type: string, nullable: true }
 *               html_body:         { type: string }
 *               markdown_body:     { type: string, nullable: true }
 *               scheduled_send_at: { type: string, format: date-time, nullable: true }
 *               metadata:          { type: object, nullable: true }
 *     responses:
 *       200: { description: Upserted — returns {success, id, scheduled_send_at, status} }
 *       400: { description: Validation or FK failure }
 *       401: { description: Missing or invalid X-Ingestion-Secret }
 *       500: { description: DB error }
 */
newsletterSendsRouter.post(
  '/save',
  requireIngestionSecret,
  validateBody(NewsletterSendSaveSchema),
  async (req: Request, res: Response) => {
    const body = req.body as import('zod').infer<typeof NewsletterSendSaveSchema>;

    const scheduledAt =
      body.scheduled_send_at
      ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const supabase = getSupabaseAdmin();

    // Table has a PARTIAL unique index on (user_id, send_date) WHERE status !=
    // 'cancelled' (migration 009 — allows multiple cancelled rows per date).
    // Partial indexes don't work with Supabase's ON CONFLICT upsert. Do an
    // explicit find-then-update-or-insert instead.
    const rowShape = {
      user_id: body.user_id,
      send_date: body.send_date,
      subject: body.subject,
      preheader: body.preheader ?? null,
      html_body: body.html_body,
      markdown_body: body.markdown_body ?? null,
      scheduled_send_at: scheduledAt,
      status: 'scheduled',
      metadata: body.metadata ?? {},
    };

    const { data: existing, error: lookupErr } = await supabase
      .from('newsletter_sends_v2')
      .select('id')
      .eq('user_id', body.user_id)
      .eq('send_date', body.send_date)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (lookupErr) {
      logger.error({ lookupErr }, 'newsletter-sends save: lookup failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: lookupErr.message },
      });
      return;
    }

    const writeResult = existing
      ? await supabase
          .from('newsletter_sends_v2')
          .update(rowShape)
          .eq('id', (existing as { id: string }).id)
          .select('id, scheduled_send_at, status')
          .maybeSingle()
      : await supabase
          .from('newsletter_sends_v2')
          .insert(rowShape)
          .select('id, scheduled_send_at, status')
          .maybeSingle();

    const { data, error } = writeResult;
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') {
        res.status(400).json({
          success: false,
          error: { code: 'FK_VIOLATION', message: 'user_id does not exist in users_v2' },
        });
        return;
      }
      logger.error({ error }, 'newsletter-sends save: write failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_UPSERT_FAILED', message: error.message },
      });
      return;
    }

    res.json({ success: true, ...(data ?? {}) });
  },
);

/**
 * @openapi
 * /newsletter-sends/scheduled:
 *   get:
 *     tags: [Newsletter]
 *     summary: Rows the future calendar cron will release
 *     description: |
 *       Returns scheduled newsletters with scheduled_send_at within the
 *       next 7 days. Admin-only for now. The calendar sprint will flip
 *       these rows to status='sending' and then 'sent'.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "{ success, items: [...] }" }
 *       401: { description: Missing or invalid auth token }
 *       403: { description: Not an admin }
 */
newsletterSendsRouter.get(
  '/scheduled',
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('newsletter_sends_v2')
      .select('id, user_id, send_date, subject, preheader, scheduled_send_at, status, created_at')
      .eq('status', 'scheduled')
      .lte('scheduled_send_at', cutoff)
      .order('scheduled_send_at', { ascending: true });

    if (error) {
      logger.error({ error }, 'newsletter-sends scheduled query failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: error.message },
      });
      return;
    }

    res.json({ success: true, items: data ?? [] });
  },
);
