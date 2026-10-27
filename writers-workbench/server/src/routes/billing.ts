/**
 * Billing (Sprint 9: S9-3, S9-5, S9-6). Every route only STARTS something at Stripe; what the user
 * gets is written by the webhook (routes/stripe-webhook.ts), never here.
 *
 *   GET  /api/billing/status            plan, period, card, upcoming invoice, last 12 invoices
 *   POST /api/billing/checkout          subscribe to a paid tier            → { checkout_url }
 *   POST /api/billing/change            change tier / cycle: an upgrade is charged now (prorated),
 *                                       a downgrade waits for the period end (subscription schedule)
 *   POST /api/billing/cancel            cancel at period end (access continues until then)
 *   POST /api/billing/reactivate        undo a cancel before the period ends
 *   POST /api/billing/portal            Stripe Customer Portal (card, invoices) → { portal_url }
 *   POST /api/billing/credits/checkout  buy a credit pack                   → { checkout_url }
 *   GET  /api/billing/credits/checkout/:sessionId   has that purchase been credited yet?
 *
 * Admins, superusers and the comp tier are managed internally: no Stripe customer is charged for them.
 */
import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { appUrl, getStripeClient, isoFromUnix, paymentsReady, subscriptionPeriod } from '../services/stripe.js';
import { getOrCreateStripeCustomer, existingCustomerId } from '../services/stripe-sync.js';
import { TIER_COLUMNS, isPaidTier, loadTier, priceFor, type TierRow } from '../services/billing.js';
import { logger } from '../lib/logger.js';

export const billingRouter = Router();
billingRouter.use(requireAuth);

const CYCLE = z.enum(['monthly', 'annual']);
const TierChoice = z.object({ tier_id: z.string().uuid(), billing_cycle: CYCLE });
const CreditPack = z.object({ credits: z.number().int().min(5).max(1000) });

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Accounts whose plan is not paid through Stripe. */
export function isManaged(req: Request): boolean {
  if (req.effectiveRole === 'superuser' || req.effectiveRole === 'admin') return true;
  return req.subscriptionTier?.name === 'free_full';
}

function ready(res: Response): boolean {
  if (paymentsReady()) return true;
  fail(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not available on this server yet.');
  return false;
}

interface SubRow {
  id: string;
  tier_id: string;
  status: string;
  billing_cycle: string;
  current_period_end: string | null;
  trial_end: string | null;
  credits_remaining: number;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  cancel_at_period_end: boolean;
  pending_tier_id: string | null;
  pending_billing_cycle: string | null;
  pending_change_at: string | null;
  payment_failures: number;
}

async function loadSub(userId: string): Promise<SubRow | null> {
  const { data } = await getSupabaseAdmin().from('user_subscriptions').select('*').eq('user_id', userId).maybeSingle();
  return (data as SubRow | null) ?? null;
}

/** Monthly-equivalent price, to tell an upgrade from a downgrade across cycles. */
export function monthlyEquivalent(tier: Pick<TierRow, 'monthly_price_cents' | 'annual_price_cents'>, cycle: 'monthly' | 'annual'): number {
  return cycle === 'annual' ? tier.annual_price_cents / 12 : tier.monthly_price_cents;
}

billingRouter.get('/status', async (req: Request, res: Response) => {
  const userId = req.userId!;
  const sub = await loadSub(userId);
  const tier = sub ? await loadTier(sub.tier_id) : null;
  const pending = sub?.pending_tier_id ? await loadTier(sub.pending_tier_id) : null;
  const base = {
    managed: isManaged(req),
    payments_ready: paymentsReady(),
    tier: tier ? { id: tier.id, name: tier.name, display_name: tier.display_name, monthly_credits: tier.monthly_credits,
      monthly_price_cents: tier.monthly_price_cents, annual_price_cents: tier.annual_price_cents } : null,
    status: sub?.status ?? null,
    stripe_status: sub?.stripe_status ?? null,
    billing_cycle: sub?.billing_cycle ?? null,
    current_period_end: sub?.current_period_end ?? null,
    trial_end: sub?.trial_end ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end ?? false,
    has_stripe_subscription: Boolean(sub?.stripe_subscription_id),
    pending_change: pending ? { tier_id: pending.id, display_name: pending.display_name, billing_cycle: sub?.pending_billing_cycle, at: sub?.pending_change_at } : null,
    payment_failures: sub?.payment_failures ?? 0,
    card: null as null | { brand: string; last4: string; exp: string },
    upcoming: null as null | { amount_due_cents: number; currency: string; date: string | null },
    invoices: [] as Array<{ id: string; number: string | null; date: string | null; amount_paid_cents: number; status: string | null; pdf: string | null; url: string | null }>,
  };
  if (!paymentsReady() || base.managed) return void res.json({ success: true, data: base });
  try {
    const customerId = await existingCustomerId(userId);
    if (customerId) {
      const stripe = getStripeClient();
      const customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
      let pm = !('deleted' in customer) ? (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | string | null) : null;
      if (sub?.stripe_subscription_id) {
        const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['default_payment_method'] });
        pm = (s.default_payment_method as Stripe.PaymentMethod | null) ?? pm;
        if (s.status !== 'canceled' && !s.cancel_at_period_end) {
          try {
            const next = await stripe.invoices.createPreview({ customer: customerId, subscription: s.id });
            base.upcoming = { amount_due_cents: next.amount_due, currency: next.currency, date: isoFromUnix(next.next_payment_attempt ?? next.period_end) };
          } catch { /* no upcoming invoice */ }
        }
      }
      if (pm && typeof pm !== 'string' && pm.card) {
        base.card = { brand: pm.card.brand, last4: pm.card.last4, exp: `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}` };
      }
      const invoices = await stripe.invoices.list({ customer: customerId, limit: 12 });
      base.invoices = invoices.data.map((i) => ({
        id: i.id ?? '', number: i.number, date: isoFromUnix(i.created), amount_paid_cents: i.amount_paid,
        status: i.status, pdf: i.invoice_pdf ?? null, url: i.hosted_invoice_url ?? null,
      }));
    }
  } catch (err) {
    logger.warn({ err, userId }, 'billing/status: Stripe details unavailable');
  }
  res.json({ success: true, data: base });
});

billingRouter.post('/checkout', validateBody(TierChoice), async (req: Request, res: Response) => {
  if (!ready(res)) return;
  if (isManaged(req)) return fail(res, 403, 'MANAGED_ACCOUNT', 'Your plan is managed by an administrator and is never charged.');
  const { tier_id, billing_cycle } = req.body as z.infer<typeof TierChoice>;
  const tier = await loadTier(tier_id);
  if (!tier || !tier.active || !tier.publicly_selectable || !isPaidTier(tier)) return fail(res, 400, 'INVALID_TIER', 'That plan cannot be bought.');
  const price = priceFor(tier, billing_cycle);
  if (!price) return fail(res, 409, 'TIER_NOT_IN_STRIPE', 'That plan is not set up for payment yet.');
  const sub = await loadSub(req.userId!);
  if (sub?.stripe_subscription_id && sub.stripe_status && !['canceled', 'incomplete_expired'].includes(sub.stripe_status)) {
    return fail(res, 409, 'ALREADY_SUBSCRIBED', 'You already have a paid plan. Change it from the billing page.');
  }
  try {
    const customer = await getOrCreateStripeCustomer(req.userId!);
    const session = await getStripeClient().checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: req.userId!,
      line_items: [{ price, quantity: 1 }],
      metadata: { kind: 'subscription', user_id: req.userId!, tier_id: tier.id, billing_cycle },
      subscription_data: { metadata: { user_id: req.userId!, tier_id: tier.id } },
      allow_promotion_codes: true,
      success_url: `${appUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl()}/billing/cancel`,
    });
    logger.info({ userId: req.userId, tier: tier.name, billing_cycle }, 'billing: checkout started');
    res.json({ success: true, data: { checkout_url: session.url } });
  } catch (err) {
    logger.error({ err }, 'billing/checkout failed');
    fail(res, 502, 'STRIPE_ERROR', 'Could not start checkout. Try again shortly.');
  }
});

billingRouter.post('/change', validateBody(TierChoice), async (req: Request, res: Response) => {
  if (!ready(res)) return;
  if (isManaged(req)) return fail(res, 403, 'MANAGED_ACCOUNT', 'Your plan is managed by an administrator.');
  const { tier_id, billing_cycle } = req.body as z.infer<typeof TierChoice>;
  const sub = await loadSub(req.userId!);
  if (!sub?.stripe_subscription_id) return fail(res, 409, 'NO_SUBSCRIPTION', 'Subscribe first; there is no paid plan to change.');
  const [current, next] = await Promise.all([loadTier(sub.tier_id), loadTier(tier_id)]);
  if (!current || !next || !next.active || !next.publicly_selectable || !isPaidTier(next)) return fail(res, 400, 'INVALID_TIER', 'That plan cannot be chosen.');
  const price = priceFor(next, billing_cycle);
  if (!price) return fail(res, 409, 'TIER_NOT_IN_STRIPE', 'That plan is not set up for payment yet.');
  const currentCycle = (sub.billing_cycle === 'annual' ? 'annual' : 'monthly') as 'monthly' | 'annual';
  if (next.id === current.id && billing_cycle === currentCycle) return fail(res, 409, 'SAME_PLAN', 'You are already on that plan.');
  const stripe = getStripeClient();
  try {
    const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const item = s.items.data[0];
    const upgrade = monthlyEquivalent(next, billing_cycle) > monthlyEquivalent(current, currentCycle);
    if (upgrade) {
      // Charged now for the rest of the period; the webhook switches the tier and its credits.
      await stripe.subscriptions.update(s.id, {
        items: [{ id: item.id, price }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        cancel_at_period_end: false,
        metadata: { user_id: req.userId!, tier_id: next.id },
      });
      return void res.json({ success: true, data: { change: 'upgrade', effective: 'now' } });
    }
    // Downgrade: the current plan runs to the period end, then the schedule switches the price.
    const period = subscriptionPeriod(s);
    const scheduleId = typeof s.schedule === 'string' ? s.schedule : s.schedule?.id;
    const schedule = scheduleId
      ? await stripe.subscriptionSchedules.retrieve(scheduleId)
      : await stripe.subscriptionSchedules.create({ from_subscription: s.id });
    const phase = schedule.phases[0];
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      phases: [
        { items: [{ price: item.price.id, quantity: 1 }], start_date: phase.start_date, end_date: phase.end_date },
        { items: [{ price, quantity: 1 }], proration_behavior: 'none', metadata: { user_id: req.userId!, tier_id: next.id } },
      ],
    });
    await getSupabaseAdmin().from('user_subscriptions').update({
      pending_tier_id: next.id, pending_billing_cycle: billing_cycle, pending_change_at: period.end,
    }).eq('id', sub.id);
    res.json({ success: true, data: { change: 'downgrade', effective: period.end } });
  } catch (err) {
    const message = (err as { message?: string })?.message ?? 'Stripe error';
    logger.error({ err }, 'billing/change failed');
    fail(res, 402, 'CHANGE_FAILED', /card|payment/i.test(message) ? 'The card was declined for the upgrade charge.' : 'Could not change the plan.');
  }
});

async function setCancel(req: Request, res: Response, cancel: boolean): Promise<void> {
  if (!ready(res)) return;
  const sub = await loadSub(req.userId!);
  if (!sub?.stripe_subscription_id) return fail(res, 409, 'NO_SUBSCRIPTION', 'There is no paid plan to change.');
  try {
    const stripe = getStripeClient();
    // A pending downgrade is a subscription schedule, and Stripe refuses cancel_at_period_end on a
    // subscription a schedule controls. Cancelling drops the pending downgrade.
    const current = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const scheduleId = typeof current.schedule === 'string' ? current.schedule : current.schedule?.id;
    if (cancel && scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
    const s = await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: cancel });
    const end = subscriptionPeriod(s).end;
    await getSupabaseAdmin().from('user_subscriptions').update({
      cancel_at_period_end: cancel, auto_renew: !cancel,
      ...(cancel && scheduleId ? { pending_tier_id: null, pending_billing_cycle: null, pending_change_at: null } : {}),
    }).eq('id', sub.id);
    res.json({ success: true, data: { cancel_at_period_end: cancel, access_until: end } });
  } catch (err) {
    logger.error({ err }, 'billing: cancel/reactivate failed');
    fail(res, 502, 'STRIPE_ERROR', 'Could not update the subscription.');
  }
}
billingRouter.post('/cancel', (req, res) => setCancel(req, res, true));
billingRouter.post('/reactivate', (req, res) => setCancel(req, res, false));

billingRouter.post('/portal', async (req: Request, res: Response) => {
  if (!ready(res)) return;
  if (isManaged(req)) return fail(res, 403, 'MANAGED_ACCOUNT', 'Your plan is managed by an administrator.');
  try {
    const customer = await getOrCreateStripeCustomer(req.userId!);
    const portal = await getStripeClient().billingPortal.sessions.create({ customer, return_url: `${appUrl()}/billing` });
    res.json({ success: true, data: { portal_url: portal.url } });
  } catch (err) {
    logger.error({ err }, 'billing/portal failed');
    fail(res, 502, 'STRIPE_ERROR', 'Could not open billing management.');
  }
});

billingRouter.post('/credits/checkout', validateBody(CreditPack), async (req: Request, res: Response) => {
  if (!ready(res)) return;
  const { credits } = req.body as z.infer<typeof CreditPack>;
  const tier = req.subscriptionTier as (TierRow | null | undefined);
  const unit = Number(tier?.credit_purchase_price_cents ?? 0);
  if (!tier || unit <= 0) return fail(res, 409, 'NO_SUBSCRIPTION', 'Credits can be bought on any plan; you have none yet.');
  try {
    const customer = await getOrCreateStripeCustomer(req.userId!);
    const session = await getStripeClient().checkout.sessions.create({
      mode: 'payment',
      customer,
      client_reference_id: req.userId!,
      line_items: [{ quantity: credits, price_data: { currency: 'usd', unit_amount: unit, product_data: { name: 'Writers Workbench credit' } } }],
      metadata: { kind: 'credits', user_id: req.userId!, credits: String(credits) },
      payment_intent_data: { metadata: { kind: 'credits', user_id: req.userId!, credits: String(credits) } },
      success_url: `${appUrl()}/credits?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl()}/credits?purchase=cancelled`,
    });
    res.json({ success: true, data: { checkout_url: session.url, total_cents: unit * credits } });
  } catch (err) {
    logger.error({ err }, 'billing/credits/checkout failed');
    fail(res, 502, 'STRIPE_ERROR', 'Could not start the purchase.');
  }
});

billingRouter.get('/credits/checkout/:sessionId', async (req: Request, res: Response) => {
  if (!ready(res)) return;
  try {
    const session = await getStripeClient().checkout.sessions.retrieve(String(req.params.sessionId));
    if (session.metadata?.user_id !== req.userId) return fail(res, 404, 'NOT_FOUND', 'Purchase not found');
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    let credited = false;
    if (pi) {
      const { data } = await getSupabaseAdmin().from('credit_transactions').select('id').eq('stripe_payment_intent_id', pi).limit(1);
      credited = Boolean(data && data.length);
    }
    res.json({ success: true, data: { payment_status: session.payment_status, credited, credits: Number(session.metadata?.credits ?? 0) } });
  } catch {
    fail(res, 404, 'NOT_FOUND', 'Purchase not found');
  }
});

/** All tiers a user may buy, with their Stripe readiness (for the pricing cards). */
export async function purchasableTiers(): Promise<TierRow[]> {
  const { data } = await getSupabaseAdmin().from('subscription_tiers').select(TIER_COLUMNS).eq('active', true).eq('publicly_selectable', true).order('sort_order');
  return (data ?? []) as unknown as TierRow[];
}
