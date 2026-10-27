/**
 * Billing for admins and superusers (Sprint 9, S9-7).
 *
 *   GET  /api/admin/billing/revenue          MRR, ARR, subscribers, trials, churn, 12 months of revenue,
 *                                            tier breakdown, trial funnel, failed payments (cached 5 min)
 *   GET  /api/admin/billing/subscribers      every subscription with its payment status and MRR share
 *   POST /api/admin/billing/retry/:userId    retry the user's open invoice now
 *   GET  /api/admin/billing/events           the Stripe event log (stripe_events_v2), newest first
 *   POST /api/superuser/billing/refund       refund a payment; a credit pack's credits come back off
 *   POST /api/superuser/billing/backfill     a Stripe Customer for every user who has none
 */
import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireAuth, requireAdmin, requireSuperuser } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { getStripeClient, paymentsReady } from '../services/stripe.js';
import { backfillStripeCustomers } from '../services/stripe-sync.js';
import { atomicCreditAdd } from '../services/credits.js';
import { logger } from '../lib/logger.js';

export const billingAdminRouter = Router();
billingAdminRouter.use(requireAuth, requireAdmin);
export const billingSuperuserRouter = Router();
billingSuperuserRouter.use(requireAuth, requireSuperuser);

const CACHE_MS = 5 * 60_000;
let revenueCache: { at: number; data: unknown } | null = null;

export function clearRevenueCache(): void {
  revenueCache = null;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** A Stripe price's monthly amount in cents (annual / 12). */
export function monthlyCents(price: Pick<Stripe.Price, 'unit_amount' | 'recurring'> | null | undefined, quantity = 1): number {
  if (!price?.unit_amount || !price.recurring) return 0;
  const { interval, interval_count: n } = price.recurring;
  const perMonth = interval === 'year' ? price.unit_amount / (12 * n) : interval === 'month' ? price.unit_amount / n
    : interval === 'week' ? (price.unit_amount * 52) / (12 * n) : (price.unit_amount * 365) / (12 * n);
  return Math.round(perMonth * quantity);
}

async function allSubscriptions(status: Stripe.SubscriptionListParams.Status): Promise<Stripe.Subscription[]> {
  const out: Stripe.Subscription[] = [];
  for await (const s of getStripeClient().subscriptions.list({ status, limit: 100 })) out.push(s);
  return out;
}

billingAdminRouter.get('/revenue', async (req: Request, res: Response) => {
  if (revenueCache && Date.now() - revenueCache.at < CACHE_MS && req.query.fresh !== '1') {
    return void res.json({ success: true, data: revenueCache.data, cached: true });
  }
  const sb = getSupabaseAdmin();
  const { data: subs } = await sb.from('user_subscriptions').select('user_id, status, tier_id, trial_end, stripe_subscription_id, tier:subscription_tiers(name, display_name)');
  type Sub = { user_id: string; status: string; tier_id: string; trial_end: string | null; stripe_subscription_id: string | null; tier: { name: string; display_name: string } | { name: string; display_name: string }[] | null };
  const rows = (subs ?? []) as Sub[];
  const tierOf = (r: Sub) => (Array.isArray(r.tier) ? r.tier[0] : r.tier);
  const byTier: Record<string, number> = {};
  for (const r of rows) {
    const t = tierOf(r)?.display_name ?? 'unknown';
    byTier[t] = (byTier[t] ?? 0) + 1;
  }
  const trialRows = rows.filter((r) => tierOf(r)?.name === 'trial');
  const now = Date.now();
  const data: Record<string, unknown> = {
    tier_breakdown: byTier,
    trial_funnel: {
      trials_started: trialRows.length + rows.filter((r) => r.stripe_subscription_id).length,
      active_trials: trialRows.filter((r) => r.status === 'active' && (!r.trial_end || Date.parse(r.trial_end) > now)).length,
      converted: rows.filter((r) => r.stripe_subscription_id).length,
      churned: rows.filter((r) => r.stripe_subscription_id && r.status === 'cancelled').length,
    },
    past_due: rows.filter((r) => r.status === 'past_due').map((r) => r.user_id),
    stripe: null,
  };
  if (paymentsReady()) {
    try {
      const stripe = getStripeClient();
      const [active, pastDue, canceled] = await Promise.all([allSubscriptions('active'), allSubscriptions('past_due'), allSubscriptions('canceled')]);
      const mrr = [...active, ...pastDue].reduce((sum, s) => sum + s.items.data.reduce((a, i) => a + monthlyCents(i.price, i.quantity ?? 1), 0), 0);
      const monthAgo = Math.floor(now / 1000) - 30 * 86400;
      const churned30 = canceled.filter((s) => (s.canceled_at ?? 0) >= monthAgo).length;
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() - 11, 1);
      start.setUTCHours(0, 0, 0, 0);
      const months: Record<string, number> = {};
      for (let i = 0; i < 12; i++) {
        const d = new Date(start);
        d.setUTCMonth(start.getUTCMonth() + i);
        months[d.toISOString().slice(0, 7)] = 0;
      }
      // Every successful charge, net of refunds: subscriptions AND one-off payments (credit packs,
      // reader print orders), which have no invoice. Counting invoices only left those out.
      for await (const ch of stripe.charges.list({ created: { gte: Math.floor(start.getTime() / 1000) }, limit: 100 })) {
        if (!ch.paid || ch.status !== 'succeeded') continue;
        const key = new Date(ch.created * 1000).toISOString().slice(0, 7);
        if (key in months) months[key] += ch.amount - (ch.amount_refunded ?? 0);
      }
      const customers = await stripe.customers.list({ limit: 100 });
      data.stripe = {
        mrr_cents: mrr,
        arr_cents: mrr * 12,
        customers: customers.data.length + (customers.has_more ? 1 : 0),
        customers_more: customers.has_more,
        active_subscribers: active.length,
        past_due_subscribers: pastDue.length,
        churn_rate_30d: active.length + churned30 ? churned30 / (active.length + churned30) : 0,
        revenue_by_month_cents: months,
      };
    } catch (err) {
      logger.warn({ err }, 'billing/revenue: Stripe figures unavailable');
      data.stripe = { error: 'Stripe figures are unavailable right now' };
    }
  }
  revenueCache = { at: Date.now(), data };
  res.json({ success: true, data, cached: false });
});

billingAdminRouter.get('/subscribers', async (_req: Request, res: Response) => {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('user_subscriptions')
    .select('user_id, status, billing_cycle, stripe_subscription_id, stripe_status, stripe_price_id, current_period_end, cancel_at_period_end, payment_failures, tier:subscription_tiers(display_name, monthly_price_cents, annual_price_cents)')
    .order('updated_at', { ascending: false }).limit(500);
  const out = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const tier = (Array.isArray(r.tier) ? r.tier[0] : r.tier) as { display_name: string; monthly_price_cents: number; annual_price_cents: number } | null;
    const paid = Boolean(r.stripe_subscription_id) && ['active', 'past_due'].includes(String(r.status));
    out.push({
      user_id: r.user_id,
      tier: tier?.display_name ?? null,
      payment_status: r.stripe_subscription_id ? (r.cancel_at_period_end ? 'cancelling' : String(r.stripe_status ?? r.status)) : 'not billed',
      status: r.status,
      billing_cycle: r.billing_cycle,
      current_period_end: r.current_period_end,
      payment_failures: r.payment_failures ?? 0,
      mrr_cents: paid && tier ? (r.billing_cycle === 'annual' ? Math.round(tier.annual_price_cents / 12) : tier.monthly_price_cents) : 0,
    });
  }
  res.json({ success: true, data: out });
});

billingAdminRouter.post('/retry/:userId', async (req: Request, res: Response) => {
  if (!paymentsReady()) return fail(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured.');
  const { data: sub } = await getSupabaseAdmin().from('user_subscriptions').select('stripe_subscription_id').eq('user_id', String(req.params.userId)).maybeSingle();
  if (!sub?.stripe_subscription_id) return fail(res, 404, 'NO_SUBSCRIPTION', 'That user has no paid plan.');
  try {
    const stripe = getStripeClient();
    const open = await stripe.invoices.list({ subscription: sub.stripe_subscription_id, status: 'open', limit: 1 });
    const invoice = open.data[0];
    if (!invoice?.id) return fail(res, 409, 'NOTHING_DUE', 'There is no unpaid invoice to retry.');
    const paid = await stripe.invoices.pay(invoice.id);
    logger.info({ admin: req.userId, userId: req.params.userId, invoice: invoice.id, status: paid.status }, 'billing: payment retried');
    res.json({ success: true, data: { invoice: invoice.id, status: paid.status } });
  } catch (err) {
    fail(res, 402, 'RETRY_FAILED', (err as { message?: string })?.message ?? 'The retry failed.');
  }
});

billingAdminRouter.get('/events', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { data, error } = await getSupabaseAdmin().from('stripe_events_v2')
    .select('id, event_type, livemode, status, error, object_id, user_id, received_at, processed_at')
    .order('received_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) return fail(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: data ?? [] });
});

const RefundSchema = z.object({
  stripe_payment_intent_id: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  amount_cents: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(300),
});

billingSuperuserRouter.post('/refund', validateBody(RefundSchema), async (req: Request, res: Response) => {
  if (!paymentsReady()) return fail(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured.');
  const { stripe_payment_intent_id: pi, amount_cents, reason } = req.body as z.infer<typeof RefundSchema>;
  try {
    const stripe = getStripeClient();
    const intent = await stripe.paymentIntents.retrieve(pi);
    const refund = await stripe.refunds.create({
      payment_intent: pi, ...(amount_cents ? { amount: amount_cents } : {}), reason: 'requested_by_customer',
      metadata: { by: req.userId!, reason },
    });
    let creditsRemoved = 0;
    const sb = getSupabaseAdmin();
    const { data: purchase } = await sb.from('credit_transactions').select('user_id, amount, metadata')
      .eq('stripe_payment_intent_id', pi).eq('transaction_type', 'purchase').maybeSingle();
    if (purchase) {
      // A credit pack refund takes back the same share of its credits, never more than the user has.
      const share = refund.amount / Math.max(1, intent.amount);
      const wanted = Math.round(Number(purchase.amount) * share);
      const { data: sub } = await sb.from('user_subscriptions').select('credits_remaining').eq('user_id', purchase.user_id).maybeSingle();
      creditsRemoved = Math.min(wanted, Math.max(0, Number(sub?.credits_remaining ?? 0)));
      let balance: number | null | undefined = Number(sub?.credits_remaining ?? 0);
      if (creditsRemoved > 0) balance = await atomicCreditAdd(String(purchase.user_id), -creditsRemoved);
      await sb.from('credit_transactions').insert({
        user_id: purchase.user_id, amount: -creditsRemoved, balance_after: typeof balance === 'number' ? balance : null,
        transaction_type: 'refund', description: `Refund of $${(refund.amount / 100).toFixed(2)}: ${reason}`,
        reference_id: refund.id, stripe_payment_intent_id: pi, metadata: { refund_id: refund.id, by: req.userId },
      });
    }
    await sb.from('print_orders_v2').update({ last_event: `Refunded $${(refund.amount / 100).toFixed(2)}` }).eq('stripe_payment_intent_id', pi);
    clearRevenueCache();
    logger.info({ by: req.userId, pi, refund: refund.id, creditsRemoved }, 'billing: refund issued');
    res.json({ success: true, data: { refund_id: refund.id, amount_cents: refund.amount, status: refund.status, credits_removed: creditsRemoved } });
  } catch (err) {
    fail(res, 402, 'REFUND_FAILED', (err as { message?: string })?.message ?? 'The refund failed.');
  }
});

billingSuperuserRouter.post('/backfill', async (_req: Request, res: Response) => {
  if (!paymentsReady()) return fail(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured.');
  res.json({ success: true, data: await backfillStripeCustomers() });
});

