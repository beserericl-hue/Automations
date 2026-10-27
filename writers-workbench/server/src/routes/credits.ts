// Sprint 8 (S8-2 / S8-6): credit balance, pricing, and purchase routes.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { CreditPurchaseSchema } from '../schemas.js';
import { getStripeClient, paymentsReady, appUrl } from '../services/stripe.js';
import { getOrCreateStripeCustomer } from '../services/stripe-sync.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const creditsRouter = Router();

creditsRouter.use(requireAuth);

/**
 * @openapi
 * /credits/balance:
 *   get:
 *     tags: [Credits]
 *     summary: Get current user's credit balance and subscription tier
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Balance + tier info
 */
creditsRouter.get('/balance', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select(`
        id, status, billing_cycle, current_period_start, current_period_end,
        trial_start, trial_end, credits_remaining, credits_used_this_period,
        auto_renew, tier:subscription_tiers!inner(*)
      `)
      .eq('user_id', req.userId!)
      .maybeSingle();

    if (error) {
      logger.error({ err: error, userId: req.userId }, 'credits/balance: query failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'credits/balance threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  }
});

/**
 * @openapi
 * /credits/pricing:
 *   get:
 *     tags: [Credits]
 *     summary: Get the per-credit purchase price for the current user's tier
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pricing info
 */
creditsRouter.get('/pricing', (req: Request, res: Response) => {
  const tier = req.subscriptionTier;
  if (!tier) {
    res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription tier' } });
    return;
  }
  res.json({
    success: true,
    data: {
      tier_name: tier.name,
      tier_display_name: tier.display_name,
      price_per_credit_cents: tier.credit_purchase_price_cents,
      purchases_available: purchasesAvailable(),
      unavailable_reason: purchasesAvailable() ? null : PURCHASES_UNAVAILABLE,
    },
  });
});

/**
 * @openapi
 * /credits/transactions:
 *   get:
 *     tags: [Credits]
 *     summary: List the current user's credit transactions
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Transaction list
 */
creditsRouter.get('/transactions', async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 50;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('credit_transactions')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }
    res.json({ success: true, data: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'credits/transactions threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  }
});

/**
 * @openapi
 * /credits/purchase:
 *   post:
 *     tags: [Credits]
 *     summary: Purchase additional credits at the current tier's per-credit price
 *     description: |
 *       Requires a configured payment provider. Until one is wired up this returns
 *       503 PAYMENTS_NOT_CONFIGURED and grants nothing — see the note in the handler.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount]
 *             properties:
 *               amount: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Purchase recorded; new balance returned
 */
/**
 * Is there a payment provider behind this endpoint at all?
 *
 * Until Sprint 9 this route took an `amount`, added that many credits to the caller's balance and
 * wrote a `credit_transactions` row of type 'purchase' — with **no payment of any kind**. Any
 * authenticated user could grant themselves unlimited credits by calling their own API, and the
 * ledger would record it as a purchase. The docstring said payment was "deferred"; the endpoint was
 * live regardless.
 *
 * It now fails closed. Legitimate grants still have a path: `adjustCreditsAdmin` behind
 * `/api/admin`, which is admin-gated and records who did it.
 */
function paymentsConfigured(): boolean {
  return paymentsReady();
}

/**
 * Would a purchase go through? Stripe configured AND its webhook secret set, because credits are
 * only ever added by the webhook once Stripe says the payment cleared.
 */
export function purchasesAvailable(): boolean {
  return paymentsConfigured();
}

/** Shown in place of the purchase form, and returned by the route when it refuses. */
export const PURCHASES_UNAVAILABLE =
  'Credit purchases are not available yet. Your plan\'s monthly credits still apply, and an administrator can add credits to your account.';

/**
 * Sprint 9: this route no longer adds credits. It starts a Stripe Checkout for `amount` credits at
 * the caller's tier price and returns its URL; the webhook adds the credits when the payment clears
 * (routes/stripe-webhook.ts → grantPurchasedCredits). Same as POST /api/billing/credits/checkout.
 */
creditsRouter.post('/purchase', validateBody(CreditPurchaseSchema), async (req: Request, res: Response) => {
  if (!paymentsConfigured()) {
    logger.warn({ userId: req.userId }, 'credits/purchase refused: payments not configured');
    res.status(503).json({ success: false, error: { code: 'PAYMENTS_NOT_CONFIGURED', message: PURCHASES_UNAVAILABLE } });
    return;
  }
  const { amount } = req.body as { amount: number };
  const tier = req.subscriptionTier;
  if (!tier) {
    res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription tier' } });
    return;
  }
  try {
    const customer = await getOrCreateStripeCustomer(req.userId!);
    const unit = tier.credit_purchase_price_cents;
    const session = await getStripeClient().checkout.sessions.create({
      mode: 'payment',
      customer,
      client_reference_id: req.userId!,
      line_items: [{ quantity: amount, price_data: { currency: 'usd', unit_amount: unit, product_data: { name: 'Writers Workbench credit' } } }],
      metadata: { kind: 'credits', user_id: req.userId!, credits: String(amount) },
      payment_intent_data: { metadata: { kind: 'credits', user_id: req.userId!, credits: String(amount) } },
      success_url: `${appUrl()}/credits?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl()}/credits?purchase=cancelled`,
    });
    res.json({ success: true, data: { checkout_url: session.url, amount, total_cents: amount * unit } });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'credits/purchase: checkout failed');
    res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: 'Could not start the purchase.' } });
  }
});
