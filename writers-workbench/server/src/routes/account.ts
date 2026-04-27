import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { DeleteAccountSchema, SignupSubscribeSchema } from '../schemas.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const accountRouter = Router();

// All account routes require JWT
accountRouter.use(requireAuth);

/**
 * @openapi
 * /account:
 *   delete:
 *     tags: [Account]
 *     summary: Delete authenticated user's own account
 *     description: Permanently deletes the user and all associated data via CASCADE. Requires typing "DELETE" to confirm.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DeleteAccountRequest'
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *       400:
 *         description: Invalid confirmation text
 *       401:
 *         description: Missing or invalid auth token
 */
accountRouter.delete('/', validateBody(DeleteAccountSchema), async (req, res, next) => {
  try {
    const supabase = getSupabaseAdmin();
    const userId = req.userId!;
    const authUid = req.authUid!;

    logger.info({ userId, authUid }, 'Account deletion requested');

    // Get cascade counts for logging
    const counts: Record<string, number> = {};
    for (const table of ['writing_projects_v2', 'published_content_v2', 'research_reports_v2', 'story_bible_v2', 'genre_config_v2', 'story_arcs_v2']) {
      const { count } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      counts[table] = count ?? 0;
    }

    logger.info({ userId, counts }, 'Cascade impact before deletion');

    // Delete from users_v2 first (cascade handles child tables)
    const { error: dbError } = await supabase
      .from('users_v2')
      .delete()
      .eq('user_id', userId);

    if (dbError) {
      logger.error({ userId, error: dbError }, 'Failed to delete user record');
      res.status(500).json({ success: false, error: { code: 'DELETE_FAILED', message: 'Failed to delete user data' } });
      return;
    }

    // Delete from Supabase Auth
    const { error: authError } = await supabase.auth.admin.deleteUser(authUid);

    if (authError) {
      logger.error({ authUid, error: authError }, 'Failed to delete auth user (data already deleted)');
      // Data is already gone, so still report success but log the auth cleanup failure
    }

    logger.info({ userId, authUid }, 'Account deleted successfully');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /account/cascade-info:
 *   get:
 *     tags: [Account]
 *     summary: Get cascade impact counts
 *     description: Returns counts of all data that will be deleted if the account is deleted.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cascade impact counts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CascadeInfo'
 *       401:
 *         description: Missing or invalid auth token
 */
/**
 * @openapi
 * /account/subscribe:
 *   post:
 *     tags: [Account]
 *     summary: Subscribe the current user to a tier (Sprint 8 — used by signup flow)
 *     description: |
 *       Idempotent: if the user already has a subscription, this updates it.
 *       For trial tiers, sets trial_start = now() and trial_end = now() + tier.trial_days.
 *       For paid tiers, sets the period to one billing cycle (30 days for monthly, 365 for annual).
 *       For free_full / 'none' tiers, never expires.
 *     security:
 *       - bearerAuth: []
 */
accountRouter.post('/subscribe', validateBody(SignupSubscribeSchema), async (req, res, next) => {
  try {
    const { tier_name, billing_cycle } = req.body as { tier_name: string; billing_cycle: 'monthly' | 'annual' | 'none' };
    const supabase = getSupabaseAdmin();
    const userId = req.userId!;

    const { data: tier, error: tierErr } = await supabase
      .from('subscription_tiers')
      .select('id, name, monthly_credits, trial_days, publicly_selectable, active')
      .eq('name', tier_name)
      .maybeSingle();
    if (tierErr || !tier) {
      res.status(400).json({ success: false, error: { code: 'INVALID_TIER', message: `Tier '${tier_name}' not found` } });
      return;
    }
    // free_full is admin-provisioned only — block self-signup.
    if (!tier.publicly_selectable || !tier.active) {
      res.status(403).json({ success: false, error: { code: 'TIER_NOT_AVAILABLE', message: 'Tier is not publicly selectable' } });
      return;
    }

    const periodStart = new Date();
    const trialEnd = tier.trial_days > 0 ? new Date(periodStart.getTime() + tier.trial_days * 24 * 3600 * 1000) : null;
    const periodEnd =
      billing_cycle === 'annual'
        ? new Date(periodStart.getTime() + 365 * 24 * 3600 * 1000)
        : billing_cycle === 'monthly'
          ? new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000)
          : null;

    const { data, error } = await supabase
      .from('user_subscriptions')
      .upsert({
        user_id: userId,
        tier_id: tier.id,
        status: 'active',
        billing_cycle: billing_cycle ?? (tier.trial_days > 0 ? 'none' : 'monthly'),
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd ? periodEnd.toISOString() : null,
        trial_start: trialEnd ? periodStart.toISOString() : null,
        trial_end: trialEnd ? trialEnd.toISOString() : null,
        credits_remaining: tier.monthly_credits,
        credits_used_this_period: 0,
        auto_renew: true,
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    await supabase.from('credit_transactions').insert({
      user_id: userId,
      amount: tier.monthly_credits,
      balance_after: tier.monthly_credits,
      transaction_type: 'monthly_reset',
      description: `Subscribed to '${tier_name}' — initial allowance`,
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

accountRouter.get('/cascade-info', async (req, res, next) => {
  try {
    const supabase = getSupabaseAdmin();
    const userId = req.userId!;

    const tables = [
      { table: 'writing_projects_v2', label: 'projects' },
      { table: 'published_content_v2', label: 'content items' },
      { table: 'research_reports_v2', label: 'research reports' },
      { table: 'story_bible_v2', label: 'story bible entries' },
    ];

    const counts: { label: string; count: number }[] = [];

    for (const { table, label } of tables) {
      const { count } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (count && count > 0) {
        counts.push({ label, count });
      }
    }

    res.json({ success: true, data: counts });
  } catch (err) {
    next(err);
  }
});
