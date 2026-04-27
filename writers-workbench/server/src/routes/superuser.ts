// Sprint 8 (S8-2 / S8-4 / S8-7): superuser-only routes.
//   POST   /api/superuser/impersonate          — start impersonation session
//   DELETE /api/superuser/impersonate          — end impersonation session
//   GET    /api/superuser/impersonate/active   — check current impersonation
//   GET    /api/superuser/impersonate/log      — full impersonation history
//
// Tier management (S8-7) is also routed under /api/superuser:
//   GET    /api/superuser/tiers
//   POST   /api/superuser/tiers
//   PUT    /api/superuser/tiers/:id
//   PUT    /api/superuser/tiers/:id/deactivate
//   GET    /api/superuser/config
//   PUT    /api/superuser/config

import { Router, Request, Response } from 'express';
import { requireAuth, requireSuperuser } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  ImpersonateStartSchema,
  TierCreateSchema,
  TierUpdateSchema,
  SuperuserConfigSchema,
} from '../schemas.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const superuserRouter = Router();

// Every route here requires JWT + superuser role.
superuserRouter.use(requireAuth, requireSuperuser);

// ============================================================
// Impersonation
// ============================================================

/**
 * @openapi
 * /superuser/impersonate:
 *   post:
 *     tags: [Superuser]
 *     summary: Start impersonating a user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [target_user_id]
 *             properties:
 *               target_user_id: { type: string }
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Impersonation session started
 */
superuserRouter.post('/impersonate', validateBody(ImpersonateStartSchema), async (req: Request, res: Response) => {
  const { target_user_id, reason } = req.body as { target_user_id: string; reason?: string };
  const superuserId = req.realUserId!;

  if (target_user_id === superuserId) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot impersonate yourself' } });
    return;
  }

  const supabase = getSupabaseAdmin();

  // Confirm the target user exists.
  const { data: target } = await supabase
    .from('users_v2')
    .select('user_id, display_name, email')
    .eq('user_id', target_user_id)
    .maybeSingle();

  if (!target) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Target user not found' } });
    return;
  }

  // End any existing active session (the table has a UNIQUE index on
  // superuser_id WHERE ended_at IS NULL — INSERT would conflict otherwise).
  await supabase
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('superuser_id', superuserId)
    .is('ended_at', null);

  const { data: row, error } = await supabase
    .from('impersonation_log')
    .insert({
      superuser_id: superuserId,
      target_user_id,
      reason: reason ?? null,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error, superuserId, target_user_id }, 'impersonate: insert failed');
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  res.json({
    success: true,
    data: {
      log_id: row.id,
      target_user: target,
      started_at: row.started_at,
    },
  });
});

/**
 * @openapi
 * /superuser/impersonate:
 *   delete:
 *     tags: [Superuser]
 *     summary: End the current impersonation session
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Session ended (or no active session) }
 */
superuserRouter.delete('/impersonate', async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('superuser_id', req.realUserId!)
    .is('ended_at', null)
    .select('id, target_user_id, started_at, ended_at')
    .maybeSingle();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  res.json({ success: true, data: data ?? null });
});

/**
 * @openapi
 * /superuser/impersonate/active:
 *   get:
 *     tags: [Superuser]
 *     summary: Get the current active impersonation session (or null)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Active session or null }
 */
superuserRouter.get('/impersonate/active', async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('impersonation_log')
    .select(`
      id, superuser_id, target_user_id, started_at, ended_at, reason,
      target:users_v2!impersonation_log_target_user_id_fkey(user_id, display_name, email)
    `)
    .eq('superuser_id', req.realUserId!)
    .is('ended_at', null)
    .maybeSingle();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? null });
});

/**
 * @openapi
 * /superuser/impersonate/log:
 *   get:
 *     tags: [Superuser]
 *     summary: Full impersonation audit log
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Audit log rows }
 */
superuserRouter.get('/impersonate/log', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('impersonation_log')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(500);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

// ============================================================
// Tier management (S8-7)
// ============================================================

/**
 * @openapi
 * /superuser/tiers:
 *   get:
 *     tags: [Superuser]
 *     summary: List all subscription tiers (with subscriber counts)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Tier list }
 */
superuserRouter.get('/tiers', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const [tiersRes, subsRes] = await Promise.all([
    supabase.from('subscription_tiers').select('*').order('sort_order'),
    supabase.from('user_subscriptions').select('tier_id, status'),
  ]);

  if (tiersRes.error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: tiersRes.error.message } });
    return;
  }

  const counts = new Map<string, number>();
  for (const row of (subsRes.data ?? []) as Array<{ tier_id: string; status: string }>) {
    if (row.status === 'active') counts.set(row.tier_id, (counts.get(row.tier_id) ?? 0) + 1);
  }

  const enriched = (tiersRes.data ?? []).map((t) => ({
    ...t,
    active_subscriber_count: counts.get(t.id) ?? 0,
  }));

  res.json({ success: true, data: enriched });
});

superuserRouter.post('/tiers', validateBody(TierCreateSchema), async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('subscription_tiers')
    .insert(req.body)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'A tier with that name already exists' } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.status(201).json({ success: true, data });
});

superuserRouter.put('/tiers/:id', validateBody(TierUpdateSchema), async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const apply_to_existing = req.body._apply_credit_change_to_existing as boolean | undefined;
  const updates = { ...req.body };
  delete updates._apply_credit_change_to_existing;

  const { data, error } = await supabase
    .from('subscription_tiers')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  // Optionally propagate the new monthly_credits cap to existing subscribers'
  // remaining-credit cap (does NOT change current credits_remaining — only the
  // amount they'll receive on next reset). The spec calls this an opt-in
  // checkbox; we treat the absence of the flag as "no propagation".
  if (apply_to_existing && typeof updates.monthly_credits === 'number') {
    // No-op for now: the reset cron (S8-5) reads tier.monthly_credits at
    // reset-time, so any tier change automatically applies on the next reset.
    // The flag is preserved in the API surface for future immediate-apply
    // semantics (e.g. mid-cycle top-up).
  }

  res.json({ success: true, data });
});

superuserRouter.put('/tiers/:id/deactivate', async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('subscription_tiers')
    .update({ active: false, publicly_selectable: false })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data });
});

// ============================================================
// System config (S8-7)
// ============================================================

const SUPERUSER_CONFIG_KEY = 'sprint8_superuser_config';

/**
 * @openapi
 * /superuser/config:
 *   get:
 *     tags: [Superuser]
 *     summary: Read system-wide superuser configuration
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Config object }
 */
superuserRouter.get('/config', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('app_config_v2')
    .select('value')
    .eq('key', SUPERUSER_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  res.json({
    success: true,
    data: data?.value ?? {
      credit_costs: {
        write_chapter: 5, write_short_story: 5, write_blog: 5, write_newsletter: 5,
        brainstorm: 3, research: 2, cover_art: 10, social_repurpose: 3,
      },
      maintenance_mode: false,
    },
  });
});

superuserRouter.put('/config', validateBody(SuperuserConfigSchema), async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('app_config_v2')
    .upsert({ key: SUPERUSER_CONFIG_KEY, value: req.body }, { onConflict: 'key' })
    .select()
    .single();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data.value });
});
