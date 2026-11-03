/**
 * The one credit gate + charge used by the routes priced on 2026-11-03 (repair, Q/A, humanize, the
 * brainstorm screen, chat by routed op). Same rules as the older inline copies in chapter-actions /
 * chat / research-run:
 *
 *   - admins and superusers are exempt (never checked, never charged);
 *   - a user with no subscription row is let through and not charged (the gate only fires once a
 *     subscription exists — requireAuth provisions the trial for everyone else);
 *   - the balance is checked BEFORE the work starts (402 INSUFFICIENT_CREDITS, the chat body shape);
 *   - the charge is taken only AFTER the work was accepted (queued / returned), so a failure to start
 *     costs nothing. There is no refund on a later engine failure, like every other op.
 */
import type { Request, Response } from 'express';
import { deductCredits } from '../services/credits.js';
import { logger } from './logger.js';

export function creditsExempt(req: Request): boolean {
  return req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
}

export function hasSubscription(req: Request): boolean {
  return req.subscriptionTier !== null && req.subscriptionTier !== undefined;
}

/** Would this request be charged at all? */
export function chargeable(req: Request): boolean {
  return !creditsExempt(req) && hasSubscription(req);
}

/** The 402 every priced route answers when the balance is short. */
export function sendInsufficient(res: Response, cost: number, have: number): void {
  res.setHeader('X-Credits-Remaining', String(have));
  res.status(402).json({
    success: false,
    error: {
      code: 'INSUFFICIENT_CREDITS',
      message: `This operation requires ${cost} credits; you have ${have}.`,
      creditsRequired: cost,
      creditsRemaining: have,
    },
  });
}

/** Answer 402 when the caller cannot afford `cost`. Returns true when it answered. */
export function refuseIfInsufficient(req: Request, res: Response, cost: number): boolean {
  if (!chargeable(req) || cost <= 0) return false;
  const have = req.creditsRemaining ?? 0;
  if (have >= cost) return false;
  sendInsufficient(res, cost, have);
  return true;
}

/**
 * Take `cost` credits for work that has been accepted. Sets X-Credits-Remaining. Returns what was
 * charged (0 when exempt / free / refused) and the balance after; `refused` when the balance had
 * gone below `cost` by the time of the deduction (a concurrent spend).
 */
export async function chargeCredits(
  req: Request,
  res: Response,
  cost: number,
  description: string,
  referenceId?: string,
): Promise<{ charged: number; remaining: number; refused?: boolean }> {
  let remaining = req.creditsRemaining ?? 0;
  if (!chargeable(req) || cost <= 0) {
    res.setHeader('X-Credits-Remaining', String(remaining));
    return { charged: 0, remaining };
  }
  const r = await deductCredits(req.userId!, cost, description, referenceId);
  if (!r.ok) {
    logger.warn({ userId: req.userId, cost, description, reason: r.reason }, 'credit-charge: deduction refused');
    if (r.balance_after !== undefined) remaining = r.balance_after;
    res.setHeader('X-Credits-Remaining', String(remaining));
    return { charged: 0, remaining, refused: r.reason === 'INSUFFICIENT_CREDITS' };
  }
  remaining = r.balance_after;
  res.setHeader('X-Credits-Remaining', String(remaining));
  return { charged: cost, remaining };
}
