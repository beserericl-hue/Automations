/**
 * Billing state: how a Stripe subscription, invoice or payment becomes the user's tier, credits and
 * access (Sprint 9, S9-4 / S9-6 / S9-8). Shared by the webhook, the sync cron and the billing routes,
 * so there is one mapping from Stripe to the database, not three that can drift.
 *
 * Rules:
 *   - Access follows Stripe: active / trialing → active; past_due / unpaid → past_due;
 *     canceled / incomplete_expired → cancelled. A cancelled subscription keeps access until its
 *     paid period ends; the sync cron suspends the account after that.
 *   - Credits are granted once per paid invoice (credit_transactions.reference_id = invoice id), so a
 *     webhook retry or the cron replaying a period never grants twice.
 *   - An account an admin LOCKED is never unlocked or re-suspended here; billing only moves
 *     active ↔ suspended.
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from './supabase-admin.js';
import { getStripeClient, invoiceSubscriptionId, subscriptionPeriod } from './stripe.js';
import { findUserByStripeCustomerId } from './stripe-sync.js';
import { logger } from '../lib/logger.js';
import { atomicCreditAdd } from './credits.js';

export interface TierRow {
  id: string;
  name: string;
  display_name: string;
  monthly_credits: number;
  monthly_price_cents: number;
  annual_price_cents: number;
  credit_purchase_price_cents: number;
  stripe_product_id: string | null;
  stripe_price_monthly_id: string | null;
  stripe_price_annual_id: string | null;
  publicly_selectable: boolean;
  active: boolean;
  trial_days: number;
  features: Record<string, unknown>;
}

export const TIER_COLUMNS =
  'id, name, display_name, monthly_credits, monthly_price_cents, annual_price_cents, credit_purchase_price_cents, ' +
  'stripe_product_id, stripe_price_monthly_id, stripe_price_annual_id, publicly_selectable, active, trial_days, features';

/** Failed charges in a row before the account is suspended (S9-4). */
export const MAX_PAYMENT_FAILURES = 3;

export function isPaidTier(t: Pick<TierRow, 'monthly_price_cents' | 'annual_price_cents'>): boolean {
  return (t.monthly_price_cents ?? 0) > 0 || (t.annual_price_cents ?? 0) > 0;
}

export async function loadTier(tierId: string): Promise<TierRow | null> {
  const { data } = await getSupabaseAdmin().from('subscription_tiers').select(TIER_COLUMNS).eq('id', tierId).maybeSingle();
  return (data as unknown as TierRow | null) ?? null;
}

/** The tier and billing cycle a Stripe Price belongs to. */
export async function tierForPrice(priceId: string): Promise<{ tier: TierRow; cycle: 'monthly' | 'annual' } | null> {
  const sb = getSupabaseAdmin();
  for (const [col, cycle] of [['stripe_price_monthly_id', 'monthly'], ['stripe_price_annual_id', 'annual']] as const) {
    const { data } = await sb.from('subscription_tiers').select(TIER_COLUMNS).eq(col, priceId).maybeSingle();
    if (data) return { tier: data as unknown as TierRow, cycle };
  }
  return null;
}

export function priceFor(tier: TierRow, cycle: 'monthly' | 'annual'): string | null {
  return cycle === 'annual' ? tier.stripe_price_annual_id : tier.stripe_price_monthly_id;
}

export function localStatus(stripeStatus: Stripe.Subscription.Status): 'active' | 'past_due' | 'cancelled' | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return null; // incomplete / paused: no change until Stripe settles it
  }
}

/** active ↔ suspended for billing reasons. Leaves an admin lock alone. */
export async function setBillingAccess(userId: string, access: 'active' | 'suspended', reason: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('user_account_meta_v2').select('account_status').eq('user_id', userId).maybeSingle();
  const current = (data?.account_status as string | undefined) ?? 'active';
  if (current === 'locked' || current === access) return;
  if (current === 'pending' && access === 'suspended') return;
  const { error } = await sb.from('user_account_meta_v2').upsert(
    { user_id: userId, account_status: access, locked_reason: access === 'suspended' ? reason : null, locked_at: access === 'suspended' ? new Date().toISOString() : null, locked_by: access === 'suspended' ? 'billing' : null },
    { onConflict: 'user_id' },
  );
  if (error) logger.error({ error, userId }, 'billing: could not change account access');
  else logger.info({ userId, access, reason }, 'billing: account access changed');
}

async function userForCustomer(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): Promise<string | null> {
  if (!customer) return null;
  const id = typeof customer === 'string' ? customer : customer.id;
  const found = await findUserByStripeCustomerId(id);
  if (found) return found;
  // A customer made by hand in the Stripe dashboard still carries our user id if it was copied.
  if (typeof customer !== 'string' && 'metadata' in customer && customer.metadata?.user_id) return customer.metadata.user_id;
  return null;
}

/**
 * Write a Stripe subscription onto the user's user_subscriptions row (tier, cycle, period, status).
 * Returns the user id and tier, or null when the subscription belongs to no known user / price.
 */
export async function applyStripeSubscription(sub: Stripe.Subscription): Promise<{ userId: string; tier: TierRow; previousTierId: string | null } | null> {
  const userId = (sub.metadata?.user_id as string | undefined) || (await userForCustomer(sub.customer));
  if (!userId) {
    logger.warn({ subscription: sub.id }, 'billing: subscription for an unknown customer');
    return null;
  }
  const priceId = sub.items.data[0]?.price?.id;
  const match = priceId ? await tierForPrice(priceId) : null;
  if (!match) {
    logger.warn({ subscription: sub.id, priceId }, 'billing: subscription price is not one of our tiers');
    return null;
  }
  const sb = getSupabaseAdmin();
  const { data: existing } = await sb.from('user_subscriptions').select('id, tier_id, status').eq('user_id', userId).maybeSingle();
  const period = subscriptionPeriod(sub);
  const status = localStatus(sub.status);
  const patch: Record<string, unknown> = {
    user_id: userId,
    tier_id: match.tier.id,
    billing_cycle: match.cycle,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    stripe_status: sub.status,
    current_period_start: period.start,
    current_period_end: period.end,
    stripe_current_period_end: period.end,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    auto_renew: !sub.cancel_at_period_end,
    trial_start: null,
    trial_end: null,
  };
  if (status) patch.status = status;
  if (status === 'active') patch.payment_failures = 0;
  const { error } = await sb.from('user_subscriptions').upsert(patch, { onConflict: 'user_id' });
  if (error) throw new Error(`billing: could not save the subscription: ${error.message}`);
  if (status === 'active') await setBillingAccess(userId, 'active', 'subscription active');
  return { userId, tier: match.tier, previousTierId: (existing?.tier_id as string | undefined) ?? null };
}

/**
 * The tier's monthly allowance, once per paid invoice. `atLeast` keeps a mid-period upgrade from
 * lowering a balance (an upgrade gives max(current, new allowance)).
 */
export async function grantPeriodCredits(
  userId: string,
  tier: TierRow,
  referenceId: string,
  description: string,
  mode: 'reset' | 'atLeast' = 'reset',
): Promise<{ granted: boolean; balance: number | null }> {
  const sb = getSupabaseAdmin();
  const { data: sub } = await sb.from('user_subscriptions').select('id, credits_remaining').eq('user_id', userId).maybeSingle();
  if (!sub) return { granted: false, balance: null };
  const current = Number(sub.credits_remaining ?? 0);
  const balance = mode === 'atLeast' ? Math.max(current, tier.monthly_credits) : tier.monthly_credits;
  // The ledger row FIRST: the unique (user, type, reference) index lets exactly one of two
  // concurrent deliveries through; the other stops here and changes nothing.
  const { error: txErr } = await sb.from('credit_transactions').insert({
    user_id: userId,
    amount: balance - (mode === 'reset' ? 0 : current),
    balance_after: balance,
    transaction_type: 'monthly_reset',
    description,
    reference_id: referenceId,
    metadata: { tier: tier.name },
  });
  if (txErr) {
    if (/duplicate|unique/i.test(txErr.message)) return { granted: false, balance: null };
    throw new Error(`billing: credit grant not recorded: ${txErr.message}`);
  }
  const { error } = await sb.from('user_subscriptions')
    .update({ credits_remaining: balance, ...(mode === 'reset' ? { credits_used_this_period: 0 } : {}) })
    .eq('id', sub.id);
  if (error) throw new Error(`billing: credit grant failed: ${error.message}`);
  return { granted: true, balance };
}

/** invoice.paid: a subscription period was paid for. */
export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<string | null> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null; // a one-off invoice, not a subscription period
  const sub = await getStripeClient().subscriptions.retrieve(subId);
  const applied = await applyStripeSubscription(sub);
  if (!applied) return null;
  await grantPeriodCredits(
    applied.userId,
    applied.tier,
    invoice.id ?? `invoice-${subId}-${invoice.period_start}`,
    `${applied.tier.display_name}: credits for the period paid`,
  );
  return applied.userId;
}

/** invoice.payment_failed: past_due, a counted failure, an email, and suspension after the third. */
export async function handleInvoiceFailed(invoice: Stripe.Invoice, notify: (userId: string, failures: number) => Promise<void>): Promise<string | null> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;
  const sub = await getStripeClient().subscriptions.retrieve(subId);
  const applied = await applyStripeSubscription(sub);
  if (!applied) return null;
  const sb = getSupabaseAdmin();
  const { data: row } = await sb.from('user_subscriptions').select('payment_failures').eq('user_id', applied.userId).maybeSingle();
  const failures = Number(row?.payment_failures ?? 0) + 1;
  await sb.from('user_subscriptions').update({ status: 'past_due', payment_failures: failures }).eq('user_id', applied.userId);
  if (failures >= MAX_PAYMENT_FAILURES || sub.status === 'unpaid') {
    await setBillingAccess(applied.userId, 'suspended', `payment failed ${failures} times`);
  }
  await notify(applied.userId, failures).catch((err) => logger.warn({ err }, 'billing: payment-failed email not sent'));
  return applied.userId;
}

/** customer.subscription.deleted: cancelled; access continues to the end of the paid period. */
export async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<string | null> {
  const applied = await applyStripeSubscription(sub);
  if (!applied) return null;
  const period = subscriptionPeriod(sub);
  const sb = getSupabaseAdmin();
  await sb.from('user_subscriptions').update({ status: 'cancelled', auto_renew: false, cancel_at_period_end: false }).eq('user_id', applied.userId);
  if (period.end && Date.parse(period.end) <= Date.now()) {
    await setBillingAccess(applied.userId, 'suspended', 'subscription ended');
  }
  return applied.userId;
}

/**
 * A credit pack was paid for (Checkout in payment mode). Idempotent on the PaymentIntent: the
 * unique index on credit_transactions.stripe_payment_intent_id refuses a second grant.
 */
export async function grantPurchasedCredits(userId: string, credits: number, amountCents: number, paymentIntentId: string): Promise<boolean> {
  const sb = getSupabaseAdmin();
  const { data: done } = await sb.from('credit_transactions').select('id').eq('stripe_payment_intent_id', paymentIntentId).eq('transaction_type', 'purchase').limit(1);
  if (done && done.length) return false;
  const { data: sub } = await sb.from('user_subscriptions').select('id, credits_remaining').eq('user_id', userId).maybeSingle();
  if (!sub) throw new Error(`billing: ${userId} has no subscription row to add credits to`);
  const estimated = Number(sub.credits_remaining ?? 0) + credits;
  const { data: tx, error: txErr } = await sb.from('credit_transactions').insert({
    user_id: userId,
    amount: credits,
    balance_after: estimated,
    transaction_type: 'purchase',
    description: `Purchased ${credits} credits for $${(amountCents / 100).toFixed(2)}`,
    reference_id: paymentIntentId,
    stripe_payment_intent_id: paymentIntentId,
    metadata: { price_paid_cents: amountCents },
  }).select('id').single();
  // The unique index is the real guard against a concurrent second delivery: record first, then add.
  if (txErr) {
    if (/duplicate|unique/i.test(txErr.message)) return false;
    throw new Error(`billing: credit purchase not recorded: ${txErr.message}`);
  }
  const added = await atomicCreditAdd(userId, credits);
  if (added === undefined) {
    const { error } = await sb.from('user_subscriptions').update({ credits_remaining: estimated }).eq('id', sub.id);
    if (error) throw new Error(`billing: credit purchase not added: ${error.message}`);
  } else if (added !== null && tx) {
    await sb.from('credit_transactions').update({ balance_after: added }).eq('id', (tx as { id: string }).id);
  }
  return true;
}
