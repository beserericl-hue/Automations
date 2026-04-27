// Sprint 8 (S8-9): public-facing list of subscription tiers for the signup page.
// No auth required — pricing must be visible to anonymous visitors so they
// know what they're signing up for.
//
// Sensitive fields (created_by, internal flags) are not on this table; the
// rows are already configured for public display via the
// `publicly_selectable` column.

import { Router, Request, Response } from 'express';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const tiersRouter = Router();

/**
 * @openapi
 * /tiers:
 *   get:
 *     tags: [Tiers]
 *     summary: List publicly-selectable subscription tiers (for signup pricing page)
 *     responses:
 *       200:
 *         description: Tier list
 */
tiersRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('subscription_tiers')
      .select('id, name, display_name, description, monthly_credits, monthly_price_cents, annual_price_cents, credit_purchase_price_cents, features, trial_days, sort_order, is_default')
      .eq('active', true)
      .eq('publicly_selectable', true)
      .order('sort_order');

    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }
    res.json({ success: true, data: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'tiers/get threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  }
});
