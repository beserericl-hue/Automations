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

// --------------------------------------------------------------------
// Per-user in-memory rate limiter
//
// Sliding 60-second window, max RATE_LIMIT_PER_MIN sends per user_id.
// In-memory is fine for a single Express instance; when we go multi-
// instance this moves to Redis (future S10b follow-up).

const RATE_LIMIT_PER_MIN = 30;
const WINDOW_MS = 60_000;

interface UserWindow {
  count: number;
  windowStart: number;
}
const userWindows = new Map<string, UserWindow>();

// Periodic cleanup so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of userWindows) {
    if (now - w.windowStart > WINDOW_MS * 2) userWindows.delete(k);
  }
}, 5 * 60_000).unref();

function checkRateLimit(userId: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const existing = userWindows.get(userId);
  if (!existing || now - existing.windowStart > WINDOW_MS) {
    userWindows.set(userId, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (existing.count < RATE_LIMIT_PER_MIN) {
    existing.count++;
    return { ok: true };
  }
  const retryAfter = Math.ceil((existing.windowStart + WINDOW_MS - now) / 1000);
  return { ok: false, retryAfter };
}

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
    const gate = checkRateLimit(rateKey);
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
  userWindows.clear();
}
