// Sprint 8 (S8-2 / S8-6): credit balance, pricing, and purchase routes.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { CreditPurchaseSchema } from '../schemas.js';
import { purchaseCredits } from '../services/credits.js';
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
 *       Records a credit purchase intent. Actual payment processing is deferred
 *       to Sprint 9 (Stripe). This endpoint updates the balance and creates a
 *       credit_transactions row with type='purchase'.
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
creditsRouter.post('/purchase', validateBody(CreditPurchaseSchema), async (req: Request, res: Response) => {
  const { amount } = req.body as { amount: number };
  const tier = req.subscriptionTier;
  if (!tier) {
    res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription tier' } });
    return;
  }

  const totalCents = amount * tier.credit_purchase_price_cents;

  const result = await purchaseCredits(req.userId!, amount, totalCents);
  if (!result.ok) {
    const status = result.reason === 'NO_SUBSCRIPTION' ? 404 : 500;
    res.status(status).json({ success: false, error: { code: result.reason, message: result.message } });
    return;
  }

  res.json({
    success: true,
    data: {
      amount_purchased: amount,
      price_paid_cents: totalCents,
      balance_after: result.balance_after,
      transaction_id: result.transaction_id,
    },
  });
});
