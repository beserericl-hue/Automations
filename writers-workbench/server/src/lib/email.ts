/**
 * Postal email client.
 *
 * Thin wrapper over Postal's HTTP API so the rest of the codebase can
 * call sendEmail({...}) without knowing which provider is underneath.
 * If Postal is replaced later (SES, Resend, self-hosted swap) only this
 * module changes.
 *
 * Env vars it reads:
 *   POSTAL_API_URL   — e.g. https://postal-admin.courseworx.media/api/v1
 *   POSTAL_API_KEY   — mail server API credential from Postal admin UI
 *   SENDER_EMAIL     — default From address, e.g. eve@courseworx.media
 *   SENDER_NAME      — default From display name
 *   REPLY_TO_EMAIL   — default Reply-To
 *   DRY_RUN_EMAIL    — "true" to short-circuit; logs the payload and
 *                      returns a fake message id without calling Postal
 */

import { logger } from './logger.js';

export interface Attachment {
  name: string;
  contentType: string;
  /** base64-encoded content */
  data: string;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  bcc?: string | string[];
  cc?: string | string[];
  replyTo?: string;
  from?: string;
  attachments?: Attachment[];
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  mode: 'sent' | 'dry-run' | 'error';
  error?: string;
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveFrom(from?: string): string {
  if (from) return from;
  const email = process.env.SENDER_EMAIL;
  const name = process.env.SENDER_NAME;
  if (!email) throw new Error('SENDER_EMAIL env var is required');
  return name ? `${name} <${email}>` : email;
}

/**
 * Sends one email via the Postal HTTP API. Returns a structured result
 * rather than throwing so callers can decide how to surface failures.
 * Fatal configuration issues (missing env vars) do still throw.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const dryRun = process.env.DRY_RUN_EMAIL === 'true';

  if (dryRun) {
    logger.info(
      {
        to: input.to,
        subject: input.subject,
        from: input.from ?? process.env.SENDER_EMAIL,
      },
      'email: DRY_RUN_EMAIL=true — not calling Postal',
    );
    return {
      ok: true,
      messageId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      mode: 'dry-run',
    };
  }

  const baseUrl = process.env.POSTAL_API_URL;
  const apiKey = process.env.POSTAL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('POSTAL_API_URL and POSTAL_API_KEY env vars are required when DRY_RUN_EMAIL is not set');
  }

  const body = {
    to: toArray(input.to),
    cc: toArray(input.cc),
    bcc: toArray(input.bcc),
    from: resolveFrom(input.from),
    reply_to: input.replyTo ?? process.env.REPLY_TO_EMAIL,
    subject: input.subject,
    html_body: input.html,
    plain_body: input.text,
    attachments: (input.attachments ?? []).map((a) => ({
      name: a.name,
      content_type: a.contentType,
      data: a.data,
    })),
  };

  const url = `${baseUrl.replace(/\/+$/, '')}/send/message`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Server-API-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const errMsg = `Postal HTTP ${res.status}`;
      logger.error({ status: res.status, body: parsed }, 'email: Postal rejected send');
      return { ok: false, mode: 'error', error: errMsg };
    }

    // Postal response: { status: 'success'|'error', data: {...} }
    const typed = parsed as { status?: string; data?: { message_id?: string; message?: unknown }; message?: string };
    if (typed.status === 'error') {
      logger.error({ body: parsed }, 'email: Postal status=error');
      return { ok: false, mode: 'error', error: typed.message ?? 'Postal returned status=error' };
    }

    return { ok: true, messageId: typed.data?.message_id, mode: 'sent' };
  } catch (err) {
    logger.error({ err }, 'email: send failed');
    return { ok: false, mode: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lightweight reachability probe for /api/health. Returns ok if we can
 * hit the Postal API URL, error otherwise. Does not actually send mail.
 */
export async function postalReachable(): Promise<boolean> {
  const baseUrl = process.env.POSTAL_API_URL;
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    // Hit the origin, not the API path — avoids needing a valid API key for healthcheck
    const res = await fetch(`${u.protocol}//${u.host}/`, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}
