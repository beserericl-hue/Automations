/**
 * POST /api/email/send — shared outbound mail endpoint.
 *
 * Auth: a shared secret header `X-Email-Secret` matches EMAIL_SECRET.
 * Used by n8n workflows and any internal service that needs to send
 * mail through Postal. NOT exposed to end-user clients — the secret is
 * configured on trusted callers only.
 *
 * Rate limit: 30 sends/min per user_id (in-memory window). Protects
 * against a runaway workflow that would otherwise burn through the
 * Postal mail server quota in seconds.
 */

import { Router, Request, Response } from 'express';
import { validateBody } from '../middleware/validate.js';
import { EmailSendSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';
import { sendEmail } from '../lib/email.js';
import { getEmailRateLimiter, resetEmailRateLimiterForTest } from '../lib/rate-limit.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';

export const emailRouter = Router();

// --------------------------------------------------------------------
// Shared-secret middleware

function requireEmailSecret(req: Request, res: Response, next: () => void): void {
  const expected = process.env.EMAIL_SECRET;
  if (!expected) {
    logger.error('EMAIL_SECRET env var not set — refusing to accept requests');
    res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Email endpoint not configured' } });
    return;
  }
  const provided = req.header('x-email-secret');
  if (!provided || provided !== expected) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-Email-Secret header' } });
    return;
  }
  next();
}

// Per-user rate limiter comes from lib/rate-limit.ts. When REDIS_URL is
// set, it's Redis-backed (shared across Express instances); otherwise
// in-memory for local dev. Config is 30 sends/min/user_id.

// --------------------------------------------------------------------

/**
 * @openapi
 * /email/send:
 *   post:
 *     tags: [Email]
 *     summary: Send an email via Postal
 *     description: |
 *       Accepts a structured email payload (to / subject / html / optional attachments, cc, bcc)
 *       and dispatches it through the configured Postal mail server.
 *       Auth is by shared-secret header `X-Email-Secret`. Rate limited at 30 sends/min per user_id.
 *       When DRY_RUN_EMAIL=true, returns a synthetic message_id without calling Postal.
 *     security:
 *       - emailSecret: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailSendRequest'
 *     responses:
 *       200:
 *         description: Message accepted (either sent or dry-run)
 *       400:
 *         description: Validation error
 *       401:
 *         description: Missing or wrong X-Email-Secret
 *       429:
 *         description: Per-user rate limit exceeded
 *       502:
 *         description: Postal rejected the send
 */
emailRouter.post(
  '/send',
  requireEmailSecret as unknown as (req: Request, res: Response, next: () => void) => void,
  validateBody(EmailSendSchema),
  async (req: Request, res: Response) => {
    const body = req.body as {
      to: string | string[];
      subject: string;
      html: string;
      text?: string;
      cc?: string | string[];
      bcc?: string | string[];
      replyTo?: string;
      from?: string;
      attachments?: Array<{ name: string; contentType: string; data: string }>;
      user_id?: string;
    };

    const rateKey = body.user_id ?? 'anonymous';
    const gate = await getEmailRateLimiter().checkAndIncr(rateKey);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      res
        .status(429)
        .json({ success: false, error: { code: 'RATE_LIMITED', message: `Too many sends for user_id=${rateKey}` } });
      return;
    }

    try {
      const result = await sendEmail({
        to: body.to,
        subject: body.subject,
        html: body.html,
        text: body.text,
        cc: body.cc,
        bcc: body.bcc,
        replyTo: body.replyTo,
        from: body.from,
        attachments: body.attachments,
      });

      if (!result.ok) {
        res.status(502).json({
          success: false,
          error: { code: 'POSTAL_ERROR', message: result.error ?? 'Postal send failed' },
        });
        return;
      }

      res.json({
        success: true,
        message_id: result.messageId,
        mode: result.mode, // "sent" | "dry-run"
      });
    } catch (err) {
      logger.error({ err }, 'email/send threw');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  },
);

export function __resetRateLimiterForTest(): void {
  resetEmailRateLimiterForTest();
}

// --------------------------------------------------------------------
// POST /email/webhook/postal — receive bounce/complaint events
//
// Postal sends HTTP POST with JSON body like:
//   { event: 'MessageBounced', timestamp: '...', payload: { message, bounce } }
// We persist every event we recognize into email_bounces_v2 so the
// admin UI can show a bounce feed and (future) auto-disable recipients.
//
// Auth: shared secret header `X-Postal-Webhook-Secret` matches
// POSTAL_WEBHOOK_SECRET. Postal also signs payloads with the server's
// RSA key — signature verification is a future add (needs Postal's
// public signing key deployed alongside the Workbench).

const KNOWN_EVENT_TYPES = new Set([
  'MessageBounced',
  'MessageHeld',
  'SpamComplaint',
  'MessageDeliveryFailed',
  'MessageDSNReceived',
  'MessageLinkClicked',
  'MessageLoaded',
]);

/**
 * @openapi
 * /email/webhook/postal:
 *   post:
 *     tags: [Email]
 *     summary: Receive Postal bounce / complaint webhooks
 *     description: |
 *       Called by the Postal server when a delivery event (bounce, hold,
 *       complaint, link-click, open) happens. We persist events of
 *       recognized types into email_bounces_v2 for admin visibility.
 *       Auth is by shared secret header X-Postal-Webhook-Secret.
 *     security:
 *       - postalWebhookSecret: []
 *     responses:
 *       200:
 *         description: Event accepted (persisted or deduplicated)
 *       401:
 *         description: Missing or wrong X-Postal-Webhook-Secret
 */
emailRouter.post('/webhook/postal', async (req: Request, res: Response) => {
  const expected = process.env.POSTAL_WEBHOOK_SECRET;
  if (!expected) {
    logger.error('POSTAL_WEBHOOK_SECRET not set — rejecting webhook');
    res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Webhook not configured' } });
    return;
  }
  const provided = req.header('x-postal-webhook-secret');
  if (!provided || provided !== expected) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }

  const body = req.body as {
    event?: string;
    uuid?: string;
    timestamp?: number;
    payload?: {
      message?: { id?: number; token?: string; to?: string; from?: string; subject?: string };
      bounce?: { reason?: string; bounce_type?: string };
      [k: string]: unknown;
    };
  };

  const eventType = body.event;
  if (!eventType || !KNOWN_EVENT_TYPES.has(eventType)) {
    // Accept but don't persist — Postal retries on non-2xx
    logger.info({ eventType }, 'email/webhook: ignoring unknown/irrelevant event');
    res.json({ success: true, ignored: true });
    return;
  }

  const msg = body.payload?.message ?? {};
  const bounce = body.payload?.bounce ?? {};

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('email_bounces_v2').insert({
      postal_message_id: msg.token ?? (msg.id != null ? String(msg.id) : null),
      postal_event_id: body.uuid ?? null,
      event_type: eventType,
      to_address: msg.to ?? 'unknown',
      from_address: msg.from ?? null,
      subject: msg.subject ?? null,
      bounce_type: (bounce as { bounce_type?: string }).bounce_type ?? null,
      bounce_reason: (bounce as { reason?: string }).reason ?? null,
      raw_payload: body,
      occurred_at: body.timestamp ? new Date(body.timestamp * 1000).toISOString() : new Date().toISOString(),
    });

    if (error) {
      // Duplicate event_id → unique-constraint violation. Treat as success
      // (Postal will retry; we want idempotent acceptance).
      if (error.code === '23505') {
        res.json({ success: true, deduped: true });
        return;
      }
      logger.error({ err: error, eventType, to: msg.to }, 'email/webhook: insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    logger.info({ eventType, to: msg.to }, 'email/webhook: recorded bounce event');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'email/webhook threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL' } });
  }
});
