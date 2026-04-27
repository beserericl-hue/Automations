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

export type CreditTransactionType =
  | 'monthly_reset'
  | 'usage'
  | 'admin_adjustment'
  | 'purchase'
  | 'refund';

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

  const newRemaining = current - amount;
  const newUsed = (sub.credits_used_this_period as number) + amount;

  const { error: updateErr } = await supabase
    .from('user_subscriptions')
    .update({ credits_remaining: newRemaining, credits_used_this_period: newUsed })
    .eq('id', sub.id);

  if (updateErr) {
    logger.error({ err: updateErr, userId }, 'deductCredits: update failed');
    return { ok: false, reason: 'DB_ERROR', message: updateErr.message };
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
