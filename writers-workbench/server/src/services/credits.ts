// Sprint 8 (S8-2): credit ledger service.
//
// Atomic update of user_subscriptions.credits_remaining + credits_used_this_period
// is implemented via a single UPDATE with arithmetic; the credit_transactions
// row is then inserted. Race conditions on the UPDATE are bounded by Postgres
// row-level locking on the subscription row's WHERE clause; concurrent debits
// against a near-zero balance can briefly overdraw, but the row's
// `credits_remaining < 0` is allowed and the credit gate (requireCredits) runs
// BEFORE the operation, so user-perceived overdraw is rare and the audit
// trail is exact regardless.
//
// For genuine atomicity we'd want a Postgres function (RPC) that does both in
// one transaction; this module is the lightweight first cut. The S8-10 QA
// suite includes a "two concurrent deductions" test to surface any
// contention issues we need to harden against.

import { getSupabaseAdmin } from './supabase-admin.js';
import { logger } from '../lib/logger.js';

/**
 * Change a balance in ONE statement (migration 039's credits_add_v2), so a deduction and a credit
 * purchase landing together cannot overwrite each other. Returns the new balance; `null` when a
 * deduction would go below zero; `undefined` when the function is not there (server deployed
 * ahead of the migration), in which case the caller keeps its old read-then-write path.
 */
export async function atomicCreditAdd(userId: string, delta: number, countUsage = false): Promise<number | null | undefined> {
  const supabase = getSupabaseAdmin() as unknown as { rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  if (typeof supabase.rpc !== 'function') return undefined;
  const { data, error } = await supabase.rpc('credits_add_v2', { p_user_id: userId, p_delta: delta, p_count_usage: countUsage });
  if (error) {
    if (/credits_add_v2|does not exist|schema cache/i.test(error.message)) return undefined;
    throw new Error(error.message);
  }
  if (data === null || data === undefined || (Array.isArray(data) && data.length === 0)) return null;
  const value = Array.isArray(data) ? (data[0] as Record<string, unknown>)?.credits_add_v2 ?? data[0] : data;
  return Number(value);
}

export type CreditTransactionType =
  | 'monthly_reset'
  | 'usage'
  | 'admin_adjustment'
  | 'purchase'
  | 'refund'
  // The automatic trial provisioned on a first authenticated request with no
  // subscription (migration 031). Deliberately its own type: it is not a monthly
  // reset, nobody adjusted it, and nobody paid for it.
  | 'trial_grant';

export interface DeductCreditsResult {
  ok: true;
  balance_after: number;
  transaction_id: string;
}

export interface DeductCreditsFailure {
  ok: false;
  reason: 'NO_SUBSCRIPTION' | 'INSUFFICIENT_CREDITS' | 'DB_ERROR';
  message: string;
  balance_after?: number;
}

/**
 * Deducts `amount` credits from the user's active subscription.
 * Inserts a `credit_transactions` row with type 'usage'.
 * Returns balance_after on success; { ok:false, reason } on failure.
 */
export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
  referenceId?: string,
  metadata?: Record<string, unknown>,
): Promise<DeductCreditsResult | DeductCreditsFailure> {
  if (amount <= 0) {
    return { ok: false, reason: 'DB_ERROR', message: 'amount must be positive' };
  }

  const supabase = getSupabaseAdmin();

  const { data: sub, error: subErr } = await supabase
    .from('user_subscriptions')
    .select('id, credits_remaining, credits_used_this_period')
    .eq('user_id', userId)
    .maybeSingle();

  if (subErr) {
    logger.error({ err: subErr, userId }, 'deductCredits: subscription lookup failed');
    return { ok: false, reason: 'DB_ERROR', message: subErr.message };
  }
  if (!sub) {
    return { ok: false, reason: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }

  const current = sub.credits_remaining as number;
  if (current < amount) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_CREDITS',
      message: `Insufficient credits (have ${current}, need ${amount})`,
      balance_after: current,
    };
  }

  let newRemaining = current - amount;
  let atomic: number | null | undefined;
  try {
    atomic = await atomicCreditAdd(userId, -amount, true);
  } catch (err) {
    logger.error({ err, userId }, 'deductCredits: atomic update failed');
    return { ok: false, reason: 'DB_ERROR', message: err instanceof Error ? err.message : 'update failed' };
  }
  if (atomic === null) {
    // Someone else spent the balance between the read above and this update.
    return { ok: false, reason: 'INSUFFICIENT_CREDITS', message: `Insufficient credits (need ${amount})`, balance_after: current };
  }
  if (atomic !== undefined) {
    newRemaining = atomic;
  } else {
    const newUsed = (sub.credits_used_this_period as number) + amount;
    const { error: updateErr } = await supabase
      .from('user_subscriptions')
      .update({ credits_remaining: newRemaining, credits_used_this_period: newUsed })
      .eq('id', sub.id);

    if (updateErr) {
      logger.error({ err: updateErr, userId }, 'deductCredits: update failed');
      return { ok: false, reason: 'DB_ERROR', message: updateErr.message };
    }
  }

  const { data: tx, error: txErr } = await supabase
    .from('credit_transactions')
    .insert({
      user_id: userId,
      amount: -amount,
      balance_after: newRemaining,
      transaction_type: 'usage' satisfies CreditTransactionType,
      description,
      reference_id: referenceId ?? null,
      metadata: metadata ?? {},
    })
    .select('id')
    .single();

  if (txErr) {
    logger.error({ err: txErr, userId }, 'deductCredits: transaction insert failed (balance already updated)');
    return { ok: true, balance_after: newRemaining, transaction_id: 'unknown' };
  }

  return { ok: true, balance_after: newRemaining, transaction_id: tx.id as string };
}

/**
 * Adds `amount` credits to the user's subscription via a one-time purchase.
 * Returns balance_after and the credit_transactions row id.
 */
export async function purchaseCredits(
  userId: string,
  amount: number,
  pricePaidCents: number,
  referenceId?: string,
): Promise<DeductCreditsResult | DeductCreditsFailure> {
  if (amount <= 0) {
    return { ok: false, reason: 'DB_ERROR', message: 'amount must be positive' };
  }

  const supabase = getSupabaseAdmin();

  const { data: sub, error: subErr } = await supabase
    .from('user_subscriptions')
    .select('id, credits_remaining')
    .eq('user_id', userId)
    .maybeSingle();

  if (subErr) {
    logger.error({ err: subErr, userId }, 'purchaseCredits: subscription lookup failed');
    return { ok: false, reason: 'DB_ERROR', message: subErr.message };
  }
  if (!sub) {
    return { ok: false, reason: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }

  const newRemaining = (sub.credits_remaining as number) + amount;

  const { error: updateErr } = await supabase
    .from('user_subscriptions')
    .update({ credits_remaining: newRemaining })
    .eq('id', sub.id);

  if (updateErr) {
    logger.error({ err: updateErr, userId }, 'purchaseCredits: update failed');
    return { ok: false, reason: 'DB_ERROR', message: updateErr.message };
  }

  const { data: tx, error: txErr } = await supabase
    .from('credit_transactions')
    .insert({
      user_id: userId,
      amount,
      balance_after: newRemaining,
      transaction_type: 'purchase' satisfies CreditTransactionType,
      description: `Purchased ${amount} credits for $${(pricePaidCents / 100).toFixed(2)}`,
      reference_id: referenceId ?? null,
      metadata: { price_paid_cents: pricePaidCents },
    })
    .select('id')
    .single();

  if (txErr) {
    logger.error({ err: txErr, userId }, 'purchaseCredits: transaction insert failed (balance already updated)');
    return { ok: true, balance_after: newRemaining, transaction_id: 'unknown' };
  }

  return { ok: true, balance_after: newRemaining, transaction_id: tx.id as string };
}

/**
 * Admin credit adjustment (positive or negative). Records intent in
 * credit_transactions with type='admin_adjustment'.
 */
export async function adjustCreditsAdmin(
  userId: string,
  delta: number,
  reason: string,
  adminUserId: string,
): Promise<DeductCreditsResult | DeductCreditsFailure> {
  if (delta === 0) {
    return { ok: false, reason: 'DB_ERROR', message: 'delta must be non-zero' };
  }

  const supabase = getSupabaseAdmin();

  const { data: sub, error: subErr } = await supabase
    .from('user_subscriptions')
    .select('id, credits_remaining')
    .eq('user_id', userId)
    .maybeSingle();

  if (subErr || !sub) {
    return { ok: false, reason: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }

  const newRemaining = Math.max(0, (sub.credits_remaining as number) + delta);

  const { error: updateErr } = await supabase
    .from('user_subscriptions')
    .update({ credits_remaining: newRemaining })
    .eq('id', sub.id);

  if (updateErr) {
    return { ok: false, reason: 'DB_ERROR', message: updateErr.message };
  }

  const { data: tx, error: txErr } = await supabase
    .from('credit_transactions')
    .insert({
      user_id: userId,
      amount: delta,
      balance_after: newRemaining,
      transaction_type: 'admin_adjustment' satisfies CreditTransactionType,
      description: reason,
      reference_id: adminUserId,
      metadata: { adjusted_by: adminUserId },
    })
    .select('id')
    .single();

  return {
    ok: true,
    balance_after: newRemaining,
    transaction_id: txErr ? 'unknown' : (tx.id as string),
  };
}

/**
 * The shape `requireAuth` needs back after provisioning, so it can fill in the request context
 * without a second round trip.
 */
export interface ProvisionedSubscription {
  credits_remaining: number;
  tier: {
    id: string;
    name: string;
    display_name: string;
    features: Record<string, unknown>;
    monthly_credits: number;
    credit_purchase_price_cents: number;
  };
}

/**
 * Give a user the trial subscription if they have none.
 *
 * I8: a user who created a profile and then closed the tab on the "choose your plan" step ended up
 * with no `user_subscriptions` row at all. `requireAuth` then reported `creditsRemaining = null`,
 * `requireCredits` read that as 0, and **every chat, export and chapter request answered 402** —
 * for an account that had done nothing wrong and had no way to tell what was missing. The tier
 * step was the only thing that ever created the row, and it was skippable.
 *
 * So the row is no longer the tier step's responsibility. Anyone who reaches an authenticated
 * request without a subscription gets the trial tier, which exists for exactly this purpose
 * (30 days, 200 credits on DEV). Choosing a plan later overwrites it through the normal
 * `/account/subscribe` path, because that upserts on `user_id`.
 *
 * Idempotent and safe to race: the upsert is keyed on `user_id`, so two simultaneous first requests
 * produce one row. Returns null when there is no trial tier configured or the write fails — the
 * caller then behaves exactly as it did before, rather than failing the request.
 */
export async function ensureTrialSubscription(userId: string): Promise<ProvisionedSubscription | null> {
  const supabase = getSupabaseAdmin();

  // The trial tier is the one with trial_days > 0. Picked by that rather than by name so renaming
  // the tier in the dashboard cannot silently disable this.
  const { data: tier, error: tierErr } = await supabase
    .from('subscription_tiers')
    .select('id, name, display_name, features, monthly_credits, credit_purchase_price_cents, trial_days')
    .gt('trial_days', 0)
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (tierErr || !tier) {
    logger.warn({ err: tierErr, userId }, 'ensureTrialSubscription: no trial tier configured');
    return null;
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + (tier.trial_days as number) * 24 * 3600 * 1000);

  // ignoreDuplicates: two first requests racing must not both write, and a row that exists by the
  // time this runs (created by the other request, or a real plan) is never overwritten.
  const { data: created, error: upsertErr } = await supabase.from('user_subscriptions').upsert(
    {
      user_id: userId,
      tier_id: tier.id,
      status: 'active',
      billing_cycle: 'none',
      current_period_start: now.toISOString(),
      current_period_end: trialEnd.toISOString(),
      trial_start: now.toISOString(),
      trial_end: trialEnd.toISOString(),
      credits_remaining: tier.monthly_credits,
      credits_used_this_period: 0,
      auto_renew: false,
    },
    { onConflict: 'user_id', ignoreDuplicates: true },
  ).select('id');

  if (upsertErr) {
    logger.error({ err: upsertErr, userId }, 'ensureTrialSubscription: upsert failed');
    return null;
  }

  if (Array.isArray(created) && created.length === 0) {
    // Someone else's request provisioned it first; read what is there instead of granting again.
    const { data: existing } = await supabase.from('user_subscriptions').select('credits_remaining').eq('user_id', userId).maybeSingle();
    return existing ? {
      credits_remaining: Number(existing.credits_remaining ?? 0),
      tier: {
        id: tier.id as string, name: tier.name as string, display_name: tier.display_name as string,
        features: (tier.features ?? {}) as Record<string, unknown>, monthly_credits: tier.monthly_credits as number,
        credit_purchase_price_cents: tier.credit_purchase_price_cents as number,
      },
    } : null;
  }

  // Record it, so a balance that appeared on its own is explicable from the ledger rather than
  // looking like a bug or a grant nobody remembers making. One per user: the reference is unique.
  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount: tier.monthly_credits,
    balance_after: tier.monthly_credits,
    transaction_type: 'trial_grant' satisfies CreditTransactionType,
    description: `Automatic ${tier.display_name} (${tier.trial_days} days)`,
    reference_id: 'trial-grant',
  });

  logger.info(
    { userId, tier: tier.name, credits: tier.monthly_credits },
    'ensureTrialSubscription: provisioned',
  );

  return {
    credits_remaining: tier.monthly_credits as number,
    tier: {
      id: tier.id as string,
      name: tier.name as string,
      display_name: tier.display_name as string,
      features: (tier.features ?? {}) as Record<string, unknown>,
      monthly_credits: tier.monthly_credits as number,
      credit_purchase_price_cents: tier.credit_purchase_price_cents as number,
    },
  };
}
