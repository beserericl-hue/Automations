// Sprint 8 (S8-5): cron endpoints for trial expiration, credit reset, and
// trial warning emails. Secured by an `X-Cron-Secret` shared header (matches
// the pattern from S11/S9 — see middleware/shared-secret.ts).
//
// These endpoints are designed to be hit by an external scheduler (Railway
// cron, GitHub Actions, n8n, etc.) on a daily cadence. They are safe to
// run multiple times per day — every operation is idempotent.

import { Router, Request, Response } from 'express';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { sendEmail } from '../lib/email.js';

export const cronRouter = Router();

// Every cron route is gated by X-Cron-Secret. CRON_SECRET must be set on the
// service for any of these to be reachable; if unset, the middleware returns 503.
cronRouter.use(requireSharedSecret('X-Cron-Secret', 'CRON_SECRET'));

/**
 * @openapi
 * /cron/trial-check:
 *   post:
 *     tags: [Cron]
 *     summary: Expire trials whose trial_end is in the past
 *     description: |
 *       Scans `user_subscriptions` for trial-tier rows with trial_end < now()
 *       and status='active'. Sets status='expired' on each row and
 *       account_status='suspended' on the matching user_account_meta_v2 row.
 *     security:
 *       - cronSecret: []
 */
cronRouter.post('/trial-check', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const now = new Date();

  // Find tier IDs with trial_days > 0 (these are trial-eligible tiers)
  const { data: trialTiers } = await supabase
    .from('subscription_tiers')
    .select('id')
    .gt('trial_days', 0);
  const trialTierIds = (trialTiers ?? []).map((t) => t.id);

  if (trialTierIds.length === 0) {
    res.json({ success: true, data: { expired: 0, message: 'No trial tiers configured' } });
    return;
  }

  const { data: expired, error } = await supabase
    .from('user_subscriptions')
    .update({ status: 'expired' })
    .in('tier_id', trialTierIds)
    .eq('status', 'active')
    .lt('trial_end', now.toISOString())
    .select('id, user_id');

  if (error) {
    logger.error({ err: error }, 'cron/trial-check: update failed');
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  // Suspend each user
  const userIds = (expired ?? []).map((r) => r.user_id);
  if (userIds.length > 0) {
    await supabase.from('user_account_meta_v2').upsert(
      userIds.map((uid) => ({ user_id: uid, account_status: 'suspended' })),
      { onConflict: 'user_id' },
    );
  }

  logger.info({ count: userIds.length }, 'cron/trial-check: expired trials');
  res.json({ success: true, data: { expired: userIds.length, user_ids: userIds } });
});

/**
 * @openapi
 * /cron/credit-reset:
 *   post:
 *     tags: [Cron]
 *     summary: Reset credits for subscriptions whose period has ended
 *     security:
 *       - cronSecret: []
 */
cronRouter.post('/credit-reset', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const now = new Date();

  const { data: dueSubs, error } = await supabase
    .from('user_subscriptions')
    .select('id, user_id, tier_id, billing_cycle, current_period_end, tier:subscription_tiers!inner(monthly_credits)')
    .eq('status', 'active')
    .not('current_period_end', 'is', null)
    .lt('current_period_end', now.toISOString());

  if (error) {
    logger.error({ err: error }, 'cron/credit-reset: query failed');
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  type Row = {
    id: string;
    user_id: string;
    tier_id: string;
    billing_cycle: string;
    current_period_end: string | null;
    tier: { monthly_credits: number } | { monthly_credits: number }[] | null;
  };

  let resetCount = 0;
  for (const row of (dueSubs ?? []) as Row[]) {
    const tier = Array.isArray(row.tier) ? row.tier[0] : row.tier;
    if (!tier) continue;
    const periodStart = new Date();
    const periodEndDate = new Date(periodStart.getTime() + (row.billing_cycle === 'annual' ? 365 : 30) * 24 * 3600 * 1000);

    const { error: updErr } = await supabase
      .from('user_subscriptions')
      .update({
        credits_remaining: tier.monthly_credits,
        credits_used_this_period: 0,
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEndDate.toISOString(),
      })
      .eq('id', row.id);

    if (updErr) continue;

    await supabase.from('credit_transactions').insert({
      user_id: row.user_id,
      amount: tier.monthly_credits,
      balance_after: tier.monthly_credits,
      transaction_type: 'monthly_reset',
      description: 'Monthly credit allowance refreshed',
    });
    resetCount++;
  }

  logger.info({ count: resetCount }, 'cron/credit-reset: refilled subscriptions');
  res.json({ success: true, data: { reset: resetCount } });
});

/**
 * @openapi
 * /cron/trial-warnings:
 *   post:
 *     tags: [Cron]
 *     summary: Identify trials nearing expiry and record warnings
 *     description: |
 *       Returns lists of subscriptions whose trial_end is 7 / 3 / 1 days away
 *       and which have not yet received the corresponding warning. The caller
 *       is expected to hand these off to the email job; this route then
 *       records the warning into `trial_warnings_sent` so it isn't re-sent.
 *     security:
 *       - cronSecret: []
 */
cronRouter.post('/trial-warnings', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const thresholds: Array<{ key: '7d' | '3d' | '1d'; days: number }> = [
    { key: '7d', days: 7 },
    { key: '3d', days: 3 },
    { key: '1d', days: 1 },
  ];

  interface DueRow {
    id: string;
    user_id: string;
    trial_end: string | null;
    trial_warnings_sent: string[] | null;
  }

  const result: Record<string, Array<{ user_id: string; trial_end: string; emailed: boolean; email_error?: string }>> = {};

  for (const { key, days } of thresholds) {
    const lower = new Date(now.getTime() + (days - 1) * 24 * 3600 * 1000);
    const upper = new Date(now.getTime() + days * 24 * 3600 * 1000);

    const { data: rows } = await supabase
      .from('user_subscriptions')
      .select('id, user_id, trial_end, trial_warnings_sent')
      .eq('status', 'active')
      .gte('trial_end', lower.toISOString())
      .lt('trial_end', upper.toISOString());

    const due = ((rows ?? []) as DueRow[]).filter((r) => {
      const sent = r.trial_warnings_sent ?? [];
      return !sent.includes(key);
    });

    // Resolve recipient emails in one round-trip
    const userIds = due.map((r) => r.user_id);
    const emailMap = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users_v2')
        .select('user_id, email, display_name')
        .in('user_id', userIds);
      for (const u of (users ?? []) as Array<{ user_id: string; email: string | null; display_name: string | null }>) {
        emailMap.set(u.user_id, u.email);
      }
    }

    const dueResult: Array<{ user_id: string; trial_end: string; emailed: boolean; email_error?: string }> = [];

    for (const r of due) {
      const trialEnd = r.trial_end ?? new Date().toISOString();
      const recipient = emailMap.get(r.user_id);
      let emailed = false;
      let email_error: string | undefined;

      if (!recipient) {
        email_error = 'no email on file';
      } else {
        try {
          const send = await sendEmail({
            to: recipient,
            subject: trialWarningSubject(key, days),
            html: trialWarningHtml(key, days, trialEnd),
            text: trialWarningText(key, days, trialEnd),
          });
          if (!send.ok) {
            email_error = send.error ?? 'send failed';
          } else {
            emailed = true;
          }
        } catch (err) {
          email_error = err instanceof Error ? err.message : 'send threw';
          logger.error({ err, user_id: r.user_id, key }, 'trial-warnings: send failed');
        }
      }

      // Mark warning sent regardless of email outcome — we don't want to
      // spam someone every cron tick if their address bounces. The audit
      // trail is in `email_bounces_v2` (Postal webhooks) and in this
      // response payload.
      const sent = (r.trial_warnings_sent ?? []).slice();
      sent.push(key);
      await supabase
        .from('user_subscriptions')
        .update({ trial_warnings_sent: sent })
        .eq('id', r.id);

      dueResult.push({ user_id: r.user_id, trial_end: trialEnd, emailed, email_error });
    }

    result[key] = dueResult;
  }

  res.json({ success: true, data: result });
});

// ---------- Email templates (S8-5) ----------

function trialWarningSubject(key: '7d' | '3d' | '1d', days: number): string {
  if (key === '1d') return 'Your Writers Workbench trial ends tomorrow';
  return `${days} day${days === 1 ? '' : 's'} left in your Writers Workbench trial`;
}

function trialWarningHtml(key: '7d' | '3d' | '1d', days: number, trialEnd: string): string {
  const endDate = new Date(trialEnd).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const urgency = key === '1d'
    ? `<p style="color:#b91c1c;font-weight:bold;">Your trial ends tomorrow (${endDate}).</p>`
    : `<p>Your trial expires on <strong>${endDate}</strong> — ${days} day${days === 1 ? '' : 's'} from now.</p>`;
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
<h1 style="font-size: 22px; margin-bottom: 8px;">Don't lose your work</h1>
${urgency}
<p>If you don't upgrade before the trial ends, your account will be locked and you won't be able to create new content. Your existing projects, chapters, and outlines stay safe — they'll come back as soon as you upgrade.</p>
<p style="margin-top: 24px;">
  <a href="https://writersworkbench-production.up.railway.app/credits" style="background:#2563eb;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Upgrade now</a>
</p>
<p style="font-size: 12px; color: #6b7280; margin-top: 32px;">
  Questions? Just reply to this email.
</p>
</body></html>`;
}

function trialWarningText(key: '7d' | '3d' | '1d', days: number, trialEnd: string): string {
  const endDate = new Date(trialEnd).toLocaleDateString();
  if (key === '1d') {
    return `Your Writers Workbench trial ends tomorrow (${endDate}).\n\nUpgrade now to keep creating: https://writersworkbench-production.up.railway.app/credits\n\nYour projects, chapters, and outlines remain safe — they'll come back as soon as you upgrade.\n`;
  }
  return `Your Writers Workbench trial ends in ${days} day${days === 1 ? '' : 's'} (on ${endDate}).\n\nUpgrade now to keep creating: https://writersworkbench-production.up.railway.app/credits\n\nIf you don't upgrade before then, your account will be locked. Your projects stay safe and come back when you upgrade.\n`;
}
