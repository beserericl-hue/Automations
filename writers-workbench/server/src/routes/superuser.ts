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
import { getGlobalJson, setGlobalConfig } from '../lib/app-config.js';
import { clearCreditCostCache, creditCostCatalog, DEFAULT_CREDIT_COSTS } from '../services/credit-costs.js';

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
interface StoredSuperuserConfig {
  credit_costs?: Record<string, number>;
  maintenance_mode?: boolean;
  [k: string]: unknown;
}

/**
 * The config as the panel edits it: EVERY credit key (from credit-costs.ts, the same table the
 * charging code reads — so a new key appears here without touching the panel), its effective price
 * (the superuser's override, else the default), and the catalog (label, group, default, unit).
 */
export function configForPanel(stored: StoredSuperuserConfig | null): Record<string, unknown> & { credit_costs: Record<string, number> } {
  const overrides = stored?.credit_costs ?? {};
  const credit_costs: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_CREDIT_COSTS)) {
    credit_costs[key] = Object.prototype.hasOwnProperty.call(overrides, key) ? Number(overrides[key]) : DEFAULT_CREDIT_COSTS[key];
  }
  return {
    ...(stored ?? {}),
    maintenance_mode: Boolean(stored?.maintenance_mode),
    credit_costs,
    credit_cost_catalog: creditCostCatalog(),
  };
}

superuserRouter.get('/config', async (_req: Request, res: Response) => {
  // Item 8: a system-wide value lives in the global settings table (migration 045). It used to be
  // upserted into the per-user app_config_v2 with no user_id, which that table's NOT NULL rejects,
  // so this config was never actually saved.
  let stored: StoredSuperuserConfig | null;
  try {
    stored = (await getGlobalJson<StoredSuperuserConfig>(SUPERUSER_CONFIG_KEY)) ?? null;
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : 'read failed' } });
    return;
  }
  res.json({ success: true, data: configForPanel(stored) });
});

superuserRouter.put('/config', validateBody(SuperuserConfigSchema), async (req: Request, res: Response) => {
  const body = { ...(req.body as StoredSuperuserConfig) };
  delete body.credit_cost_catalog; // display-only; the panel echoes it back
  const incoming = body.credit_costs ?? {};
  const unknownKeys = Object.keys(incoming).filter((k) => !Object.prototype.hasOwnProperty.call(DEFAULT_CREDIT_COSTS, k));
  if (unknownKeys.length) {
    res.status(400).json({ success: false, error: { code: 'UNKNOWN_CREDIT_KEY', message: `Not a credit key: ${unknownKeys.join(', ')}` } });
    return;
  }

  let before: StoredSuperuserConfig | null = null;
  try {
    before = (await getGlobalJson<StoredSuperuserConfig>(SUPERUSER_CONFIG_KEY)) ?? null;
  } catch { /* nothing saved yet */ }
  const beforeCosts = configForPanel(before).credit_costs;

  // Store only what differs from the code default: a key left at its default keeps following the
  // code, so a default changed in a later release is not frozen by an old save of the whole table.
  const merged: Record<string, number> = { ...beforeCosts, ...incoming };
  const overrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== DEFAULT_CREDIT_COSTS[k]) overrides[k] = v;
  const toStore: StoredSuperuserConfig = { ...(before ?? {}), ...body, credit_costs: overrides };

  const changes = Object.keys(DEFAULT_CREDIT_COSTS)
    .filter((k) => merged[k] !== beforeCosts[k])
    .map((k) => ({ key: k, from: beforeCosts[k], to: merged[k] }));
  const by = req.realUserId ?? req.userId ?? null;
  try {
    await setGlobalConfig(SUPERUSER_CONFIG_KEY, JSON.stringify(toStore), {
      description: 'Superuser system config: credit costs and maintenance mode',
      updatedBy: by,
    });
    clearCreditCostCache();
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: err instanceof Error ? err.message : 'write failed' } });
    return;
  }
  // Audit: who changed which price from what to what (the row itself keeps updated_by/updated_at).
  if (changes.length || Boolean(before?.maintenance_mode) !== Boolean(toStore.maintenance_mode)) {
    logger.info(
      { audit: 'superuser.config', by, credit_cost_changes: changes, maintenance_mode: Boolean(toStore.maintenance_mode) },
      'superuser: config changed',
    );
  }
  res.json({ success: true, data: { ...configForPanel(toStore), changes } });
});
