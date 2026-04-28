import { Router, Request, Response } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  AdminUserSchema,
  AdminUserUpdateSchema,
  CreateUserWithSubscriptionSchema,
  LockAccountSchema,
  AdjustCreditsSchema,
  ChangeSubscriptionSchema,
  RoleChangeSchema,
  AdminUserFullUpdateSchema,
} from '../schemas.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { adjustCreditsAdmin } from '../services/credits.js';
import { logger } from '../lib/logger.js';

export const adminRouter = Router();

// All admin routes require JWT + admin role
adminRouter.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users
 *     description: Returns all users with content and project counts. Admin only.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/AdminUser'
 *       403:
 *         description: Not an admin
 *   post:
 *     tags: [Admin]
 *     summary: Create a new user
 *     description: Pre-create a user record with phone, name, email, and role. Admin only.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AdminCreateUserRequest'
 *     responses:
 *       201:
 *         description: User created
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not an admin
 * /admin/users/{id}:
 *   put:
 *     tags: [Admin]
 *     summary: Update user profile and role
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User updated
 *       403:
 *         description: Not an admin
 *       404:
 *         description: User not found
 *   delete:
 *     tags: [Admin]
 *     summary: Deactivate a user
 *     description: Sets user role to viewer (soft deactivation).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deactivated
 *       403:
 *         description: Not an admin
 * /admin/metrics:
 *   get:
 *     tags: [Admin]
 *     summary: System-wide metrics
 *     description: Returns entity counts and content breakdowns by status/type.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Metrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/AdminMetrics'
 *       403:
 *         description: Not an admin
 * /admin/workflows:
 *   get:
 *     tags: [Admin]
 *     summary: n8n workflow execution status
 *     description: Proxies to n8n API for recent execution data.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Workflow execution list
 *       403:
 *         description: Not an admin
 * /admin/storage:
 *   get:
 *     tags: [Admin]
 *     summary: Storage usage statistics
 *     description: Returns image and content storage usage from Supabase.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Storage stats
 *       403:
 *         description: Not an admin
 */
adminRouter.get('/users', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();
    const { data: users, error } = await supabase
      .from('users_v2')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with Sprint 8 meta + content/project counts
    const enriched = await Promise.all(
      (users || []).map(async (user) => {
        const [contentRes, projectRes, accountRes, roleRes, subRes] = await Promise.all([
          supabase
            .from('published_content_v2')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.user_id)
            .is('deleted_at', null),
          supabase
            .from('writing_projects_v2')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.user_id)
            .is('deleted_at', null),
          supabase.from('user_account_meta_v2').select('account_status, locked_at, locked_reason').eq('user_id', user.user_id).maybeSingle(),
          supabase.from('user_role_meta_v2').select('role').eq('user_id', user.user_id).maybeSingle(),
          supabase
            .from('user_subscriptions')
            .select('credits_remaining, credits_used_this_period, status, billing_cycle, current_period_end, trial_end, tier:subscription_tiers!inner(name, display_name, monthly_credits)')
            .eq('user_id', user.user_id)
            .maybeSingle(),
        ]);
        return {
          ...user,
          content_count: contentRes.count ?? 0,
          project_count: projectRes.count ?? 0,
          account_status: accountRes.data?.account_status ?? 'active',
          locked_at: accountRes.data?.locked_at ?? null,
          locked_reason: accountRes.data?.locked_reason ?? null,
          effective_role: roleRes.data?.role ?? (user.role === 'admin' ? 'admin' : 'user'),
          subscription: subRes.data ?? null,
        };
      })
    );

    res.json({ success: true, data: enriched });
  } catch (err) {
    logger.error({ err }, 'Failed to list users');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list users' } });
  }
});

// POST /api/admin/users — pre-create user
adminRouter.post('/users', validateBody(AdminUserSchema), async (req: Request, res: Response) => {
  try {
    const { phone, display_name, email, role } = req.body;
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('users_v2')
      .insert({
        user_id: phone,
        phone_number: phone,
        display_name: display_name.trim(),
        email: email?.trim() || null,
        role: role || 'user',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'A user with this phone number already exists' } });
        return;
      }
      throw error;
    }

    res.status(201).json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'Failed to create user');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create user' } });
  }
});

// PUT /api/admin/users/:id — update user profile and role
adminRouter.put('/users/:id', validateBody(AdminUserUpdateSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { display_name, email, role } = req.body;
    const supabase = getSupabaseAdmin();

    const updates: Record<string, unknown> = {};
    if (display_name !== undefined) updates.display_name = display_name.trim();
    if (email !== undefined) updates.email = email?.trim() || null;
    if (role !== undefined) updates.role = role;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'No fields to update' } });
      return;
    }

    const { data, error } = await supabase
      .from('users_v2')
      .update(updates)
      .eq('user_id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'Failed to update user');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update user' } });
  }
});

// DELETE /api/admin/users/:id — soft deactivate user
adminRouter.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supabase = getSupabaseAdmin();

    // Don't allow admin to deactivate themselves
    if (id === req.userId) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot deactivate your own account from admin panel' } });
      return;
    }

    const { data, error } = await supabase
      .from('users_v2')
      .update({ role: 'viewer', preferences: { deactivated: true, deactivated_at: new Date().toISOString() } })
      .eq('user_id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'Failed to deactivate user');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to deactivate user' } });
  }
});

// GET /api/admin/metrics — system-wide content metrics
adminRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();

    const [usersRes, contentRes, projectsRes, researchRes, imagesRes, socialRes] = await Promise.all([
      supabase.from('users_v2').select('id', { count: 'exact', head: true }),
      supabase.from('published_content_v2').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('writing_projects_v2').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('research_reports_v2').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('generated_images_v2').select('id', { count: 'exact', head: true }),
      supabase.from('social_posts_v2').select('id', { count: 'exact', head: true }),
    ]);

    // Content by status
    const { data: statusData } = await supabase
      .from('published_content_v2')
      .select('status')
      .is('deleted_at', null);

    const statusCounts: Record<string, number> = {};
    (statusData || []).forEach((row) => {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    });

    // Content by type
    const { data: typeData } = await supabase
      .from('published_content_v2')
      .select('content_type')
      .is('deleted_at', null);

    const typeCounts: Record<string, number> = {};
    (typeData || []).forEach((row) => {
      typeCounts[row.content_type] = (typeCounts[row.content_type] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        totalUsers: usersRes.count ?? 0,
        totalContent: contentRes.count ?? 0,
        totalProjects: projectsRes.count ?? 0,
        totalResearch: researchRes.count ?? 0,
        totalImages: imagesRes.count ?? 0,
        totalSocialPosts: socialRes.count ?? 0,
        contentByStatus: statusCounts,
        contentByType: typeCounts,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch metrics');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch metrics' } });
  }
});

// GET /api/admin/workflows — proxy to n8n API for execution status
adminRouter.get('/workflows', async (_req: Request, res: Response) => {
  try {
    const n8nUrl = process.env.N8N_API_URL || 'https://n8n.agileadautomation.com';
    const n8nApiKey = process.env.N8N_API_KEY;

    if (!n8nApiKey) {
      res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'n8n API key not configured' } });
      return;
    }

    const response = await fetch(`${n8nUrl}/api/v1/executions?limit=20`, {
      headers: { 'X-N8N-API-KEY': n8nApiKey },
    });

    if (!response.ok) {
      throw new Error(`n8n API returned ${response.status}`);
    }

    const data = (await response.json()) as { data?: unknown[] };
    res.json({ success: true, data: data.data || [] });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch workflow executions');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch workflow status' } });
  }
});

/**
 * @openapi
 * /admin/queues:
 *   get:
 *     tags: [Admin]
 *     summary: BullMQ queue depths, worker concurrency, and per-user hot list
 *     description: |
 *       Live queue snapshot for the admin dashboard. For each of the four named queues
 *       returns waiting/active/delayed/completed/failed counts plus configured concurrency.
 *       Also returns the top 20 users by currently-running jobs (from job_queue_v2).
 *       Returns 503 when Redis is not configured on this instance.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Snapshot payload.
 *       403:
 *         description: Not an admin.
 *       503:
 *         description: Redis not configured.
 */
adminRouter.get('/queues', async (_req: Request, res: Response) => {
  if (!process.env.REDIS_URL) {
    res.status(503).json({
      success: false,
      error: { code: 'REDIS_UNAVAILABLE', message: 'REDIS_URL not configured on this instance' },
    });
    return;
  }

  try {
    const { getNamedQueue } = await import('../lib/queue.js');
    const { ALL_QUEUE_NAMES, QUEUE_SETTINGS } = await import('../lib/jobs/types.js');
    const { DEFAULT_LIMITS } = await import('../lib/jobs/concurrency.js');

    const queues = await Promise.all(
      ALL_QUEUE_NAMES.map(async (name) => {
        const q = getNamedQueue(name);
        const counts = await q.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
        );
        return {
          name,
          counts,
          settings: QUEUE_SETTINGS[name],
        };
      }),
    );

    const supabase = getSupabaseAdmin();
    const { data: activeJobs, error: activeErr } = await supabase
      .from('job_queue_v2')
      .select('user_id, queue_name, job_type, created_at')
      .in('status', ['waiting', 'active', 'delayed']);

    if (activeErr) {
      logger.error({ err: activeErr }, 'admin/queues: active jobs query failed');
    }

    const perUser = new Map<string, number>();
    for (const row of (activeJobs ?? []) as { user_id: string }[]) {
      perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + 1);
    }
    const topUsers = [...perUser.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([user_id, count]) => ({ user_id, active_jobs: count }));

    res.json({
      success: true,
      data: {
        queues,
        perUserLimits: DEFAULT_LIMITS,
        topUsers,
        totalActive: (activeJobs ?? []).length,
      },
    });
  } catch (err) {
    logger.error({ err }, 'admin/queues: snapshot failed');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch queue snapshot' },
    });
  }
});

// GET /api/admin/storage — Supabase Storage usage stats
adminRouter.get('/storage', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();

    // Get file counts from storage-backed tables
    const [imagesRes, contentRes] = await Promise.all([
      supabase.from('generated_images_v2').select('file_size_bytes'),
      supabase.from('published_content_v2').select('storage_path').not('storage_path', 'is', null),
    ]);

    const totalImageBytes = (imagesRes.data || []).reduce(
      (sum, row) => sum + (row.file_size_bytes || 0),
      0
    );

    res.json({
      success: true,
      data: {
        totalImages: imagesRes.data?.length ?? 0,
        totalImageSizeBytes: totalImageBytes,
        totalStoredContent: contentRes.data?.length ?? 0,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch storage stats');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch storage stats' } });
  }
});

/**
 * @openapi
 * /admin/bounces:
 *   get:
 *     tags: [Admin]
 *     summary: Recent Postal bounce / complaint events
 *     description: |
 *       Returns up to 100 most recent events from email_bounces_v2,
 *       optionally filtered by event_type or recipient address.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: event_type
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Bounce list
 *       403:
 *         description: Not an admin
 */
adminRouter.get('/bounces', async (req: Request, res: Response) => {
  const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;

  try {
    const supabase = getSupabaseAdmin();
    let q = supabase
      .from('email_bounces_v2')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (eventType) q = q.eq('event_type', eventType);
    if (to) q = q.eq('to_address', to);

    const { data, error } = await q;
    if (error) {
      logger.error({ err: error }, 'admin/bounces query failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    // Summary counts by event_type for the same (optionally-filtered) window
    const bounces = data ?? [];
    const summary: Record<string, number> = {};
    for (const row of bounces as Array<{ event_type: string }>) {
      summary[row.event_type] = (summary[row.event_type] ?? 0) + 1;
    }

    res.json({ success: true, data: { bounces, summary, total: bounces.length } });
  } catch (err) {
    logger.error({ err }, 'admin/bounces threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL' } });
  }
});

// ============================================================
// Side sprint (migration 013): cross-user ingestion view for admin/superuser.
// Migration 013 widened the SELECT RLS on content_ingestion_v2 to include
// is_admin_v2(); this route lets the admin UI surface that visibility with
// optional filters (user, key prefix, type) and a hard pagination cap.
// ============================================================
adminRouter.get('/ingestion', async (req: Request, res: Response) => {
  const userIdFilter = typeof req.query.user_id === 'string' ? req.query.user_id : null;
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : null;
  const type = typeof req.query.type === 'string' ? req.query.type : null;
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;

  try {
    const supabase = getSupabaseAdmin();
    let q = supabase
      .from('content_ingestion_v2')
      .select('id, key, user_id, type, title, source_name, source_url, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (userIdFilter) q = q.eq('user_id', userIdFilter);
    if (prefix) q = q.like('key', `${prefix}%`);
    if (type) q = q.eq('type', type);

    const { data, error } = await q;
    if (error) {
      logger.error({ err: error }, 'admin/ingestion query failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    const rows = data ?? [];
    // Summary by user_id so the admin can see who's ingesting what at a glance.
    const byUser: Record<string, number> = {};
    for (const row of rows as Array<{ user_id: string }>) {
      byUser[row.user_id] = (byUser[row.user_id] ?? 0) + 1;
    }

    res.json({ success: true, data: { rows, total: rows.length, by_user: byUser } });
  } catch (err) {
    logger.error({ err }, 'admin/ingestion threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL' } });
  }
});

// ============================================================
// Sprint 8 (S8-3): account lifecycle + subscription management
// ============================================================

/**
 * @openapi
 * /admin/users-with-subscription:
 *   post:
 *     tags: [Admin]
 *     summary: Create a user and provision their subscription in one call
 *     security:
 *       - bearerAuth: []
 */
adminRouter.post(
  '/users-with-subscription',
  validateBody(CreateUserWithSubscriptionSchema),
  async (req: Request, res: Response) => {
    const { phone, display_name, email, role, tier_name, billing_cycle, is_free, password } = req.body;
    const supabase = getSupabaseAdmin();

    try {
      const { data: existing } = await supabase.from('users_v2').select('user_id').eq('user_id', phone).maybeSingle();
      if (existing) {
        res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'A user with this phone number already exists' } });
        return;
      }

      // Resolve tier (free flag forces free_full when set).
      const lookupName = is_free ? 'free_full' : tier_name;
      const { data: tier, error: tierErr } = await supabase
        .from('subscription_tiers')
        .select('id, monthly_credits, trial_days')
        .eq('name', lookupName)
        .maybeSingle();
      if (tierErr || !tier) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TIER', message: `Tier '${lookupName}' not found` } });
        return;
      }

      // If admin supplied a password, create the Supabase Auth account first
      // so we can store the linked UID on the users_v2 row in the same insert.
      // We do this BEFORE the users_v2 insert so a duplicate-email or other
      // auth failure doesn't leave a half-provisioned profile row behind.
      let supabaseAuthUid: string | null = null;
      if (password) {
        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
          email: email.trim(),
          password,
          email_confirm: true,
          user_metadata: { provisioned_by_admin: true, target_user_id: phone },
        });
        if (createErr || !created?.user?.id) {
          res.status(400).json({
            success: false,
            error: {
              code: 'AUTH_CREATE_FAILED',
              message: createErr?.message ?? 'Failed to create Supabase Auth account',
            },
          });
          return;
        }
        supabaseAuthUid = created.user.id;
      }

      const { data: user, error: userErr } = await supabase
        .from('users_v2')
        .insert({
          user_id: phone,
          phone_number: phone,
          display_name: display_name.trim(),
          email: email.trim(),
          role: role || 'user',
          supabase_auth_uid: supabaseAuthUid,
        })
        .select()
        .single();
      if (userErr) {
        // Roll back the auth account so the form can be retried.
        if (supabaseAuthUid) {
          await supabase.auth.admin.deleteUser(supabaseAuthUid).catch(() => undefined);
        }
        throw userErr;
      }

      const periodStart = new Date();
      const periodEnd = is_free ? null : new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000);
      const trialEnd = tier.trial_days > 0 ? new Date(periodStart.getTime() + tier.trial_days * 24 * 3600 * 1000) : null;

      const { error: subErr } = await supabase.from('user_subscriptions').insert({
        user_id: phone,
        tier_id: tier.id,
        status: 'active',
        billing_cycle: is_free ? 'none' : billing_cycle ?? 'monthly',
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd ? periodEnd.toISOString() : null,
        trial_start: trialEnd ? periodStart.toISOString() : null,
        trial_end: trialEnd ? trialEnd.toISOString() : null,
        credits_remaining: tier.monthly_credits,
        auto_renew: !is_free,
        created_by: req.realUserId ?? req.userId ?? null,
      });
      if (subErr) {
        // Best-effort cleanup of the half-created user
        await supabase.from('users_v2').delete().eq('user_id', phone);
        throw subErr;
      }

      // Seed an initial monthly_reset transaction so the UI ledger has a starting row.
      await supabase.from('credit_transactions').insert({
        user_id: phone,
        amount: tier.monthly_credits,
        balance_after: tier.monthly_credits,
        transaction_type: 'monthly_reset',
        description: `Initial allowance from tier '${lookupName}'`,
      });

      res.status(201).json({ success: true, data: user });
    } catch (err) {
      logger.error({ err }, 'admin: create-user-with-subscription failed');
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create user' } });
    }
  },
);

/**
 * @openapi
 * /admin/users/{id}/lock:
 *   put:
 *     tags: [Admin]
 *     summary: Lock a user account
 *     security:
 *       - bearerAuth: []
 */
adminRouter.put('/users/:id/lock', validateBody(LockAccountSchema), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body as { reason: string };
  if (id === req.realUserId) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot lock your own account' } });
    return;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('user_account_meta_v2')
    .upsert({
      user_id: id,
      account_status: 'locked',
      locked_at: new Date().toISOString(),
      locked_by: req.realUserId ?? req.userId ?? null,
      locked_reason: reason,
    }, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data });
});

/**
 * @openapi
 * /admin/users/{id}/unlock:
 *   put:
 *     tags: [Admin]
 *     summary: Unlock a user account
 *     security:
 *       - bearerAuth: []
 */
adminRouter.put('/users/:id/unlock', async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('user_account_meta_v2')
    .upsert({
      user_id: req.params.id,
      account_status: 'active',
      locked_at: null,
      locked_by: null,
      locked_reason: null,
    }, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data });
});

/**
 * @openapi
 * /admin/users/{id}/subscription:
 *   put:
 *     tags: [Admin]
 *     summary: Change a user's subscription tier
 *     security:
 *       - bearerAuth: []
 */
adminRouter.put(
  '/users/:id/subscription',
  validateBody(ChangeSubscriptionSchema),
  async (req: Request, res: Response) => {
    const { tier_name, billing_cycle, reset_credits } = req.body;
    const targetId = String(req.params.id);
    const supabase = getSupabaseAdmin();

    const { data: tier, error: tierErr } = await supabase
      .from('subscription_tiers')
      .select('id, monthly_credits, trial_days')
      .eq('name', tier_name)
      .maybeSingle();
    if (tierErr || !tier) {
      res.status(400).json({ success: false, error: { code: 'INVALID_TIER', message: `Tier '${tier_name}' not found` } });
      return;
    }

    // UPSERT so admins can both *create* a subscription on a user that has
    // none (e.g. a self-signup that skipped tier selection, or an
    // admin-provisioned account) and *change* an existing one.
    const { data: existing } = await supabase
      .from('user_subscriptions')
      .select('id, credits_remaining')
      .eq('user_id', targetId)
      .maybeSingle();

    const isNew = !existing;
    const periodStart = new Date();
    const cycle = billing_cycle ?? (tier.trial_days > 0 ? 'none' : 'monthly');
    const trialEnd = tier.trial_days > 0
      ? new Date(periodStart.getTime() + tier.trial_days * 24 * 3600 * 1000)
      : null;
    const periodEnd =
      cycle === 'annual'
        ? new Date(periodStart.getTime() + 365 * 24 * 3600 * 1000)
        : cycle === 'monthly'
          ? new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000)
          : null;

    const row: Record<string, unknown> = {
      user_id: targetId,
      tier_id: tier.id,
      status: 'active',
      billing_cycle: cycle,
      auto_renew: cycle !== 'none',
      created_by: req.realUserId ?? req.userId ?? null,
    };

    if (isNew) {
      // New subscription: full reset of period + credits regardless of
      // reset_credits flag (there's nothing to preserve).
      row.current_period_start = periodStart.toISOString();
      row.current_period_end = periodEnd ? periodEnd.toISOString() : null;
      row.trial_start = trialEnd ? periodStart.toISOString() : null;
      row.trial_end = trialEnd ? trialEnd.toISOString() : null;
      row.credits_remaining = tier.monthly_credits;
      row.credits_used_this_period = 0;
    } else if (reset_credits !== false) {
      // Existing subscription: respect reset_credits (default true). Refresh
      // period_start so the next billing cycle starts now.
      row.current_period_start = periodStart.toISOString();
      row.current_period_end = periodEnd ? periodEnd.toISOString() : null;
      row.credits_remaining = tier.monthly_credits;
      row.credits_used_this_period = 0;
    }

    const { data, error } = await supabase
      .from('user_subscriptions')
      .upsert(row, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    // Emit a credit_transactions row when credits were reset (or initialised
    // on a new sub) so the audit trail explains why the balance jumped.
    if (isNew || reset_credits !== false) {
      await supabase.from('credit_transactions').insert({
        user_id: targetId,
        amount: tier.monthly_credits,
        balance_after: tier.monthly_credits,
        transaction_type: 'admin_adjustment',
        description: isNew
          ? `Subscription created — tier '${tier_name}' (${tier.monthly_credits} credits)`
          : `Tier change to '${tier_name}' — credits reset`,
        reference_id: req.realUserId ?? req.userId ?? null,
      });
    }

    res.status(isNew ? 201 : 200).json({ success: true, data });
  },
);

/**
 * @openapi
 * /admin/users/{id}/credits:
 *   post:
 *     tags: [Admin]
 *     summary: Adjust a user's credit balance (positive or negative)
 *     security:
 *       - bearerAuth: []
 */
adminRouter.post('/users/:id/credits', validateBody(AdjustCreditsSchema), async (req: Request, res: Response) => {
  const { delta, reason } = req.body as { delta: number; reason: string };
  const targetId = String(req.params.id);
  const result = await adjustCreditsAdmin(targetId, delta, reason, req.realUserId ?? req.userId ?? 'unknown');
  if (!result.ok) {
    const status = result.reason === 'NO_SUBSCRIPTION' ? 404 : 500;
    res.status(status).json({ success: false, error: { code: result.reason, message: result.message } });
    return;
  }
  res.json({ success: true, data: result });
});

/**
 * @openapi
 * /admin/subscriptions:
 *   get:
 *     tags: [Admin]
 *     summary: List subscriptions with user info, optional filters
 *     security:
 *       - bearerAuth: []
 */
adminRouter.get('/subscriptions', async (req: Request, res: Response) => {
  const tierFilter = typeof req.query.tier === 'string' ? req.query.tier : null;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;

  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('user_subscriptions')
    .select(`
      id, user_id, status, billing_cycle, current_period_start, current_period_end,
      trial_start, trial_end, credits_remaining, credits_used_this_period, auto_renew,
      tier:subscription_tiers!inner(id, name, display_name, monthly_credits, monthly_price_cents, annual_price_cents)
    `)
    .order('created_at', { ascending: false })
    .limit(500);
  if (statusFilter) q = q.eq('status', statusFilter);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  let rows = (data ?? []) as Array<Record<string, unknown> & { tier?: { name?: string } | null }>;
  if (tierFilter) {
    rows = rows.filter((r) => r.tier?.name === tierFilter);
  }

  res.json({ success: true, data: rows });
});

/**
 * @openapi
 * /admin/revenue:
 *   get:
 *     tags: [Admin]
 *     summary: Aggregate billing stats (MRR, active subscribers, conversions)
 *     security:
 *       - bearerAuth: []
 */
adminRouter.get('/revenue', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data: subs, error } = await supabase
    .from('user_subscriptions')
    .select(`
      status, billing_cycle, trial_end,
      tier:subscription_tiers!inner(name, monthly_price_cents, annual_price_cents)
    `);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  let mrrCents = 0;
  let arrCents = 0;
  let activePaid = 0;
  let activeFree = 0;
  let trialActive = 0;
  let trialExpired = 0;
  const byTier: Record<string, number> = {};

  type Row = {
    status: string;
    billing_cycle: string;
    trial_end: string | null;
    tier?: { name?: string; monthly_price_cents?: number; annual_price_cents?: number } | null;
  };

  for (const row of (subs ?? []) as Row[]) {
    const tier = row.tier;
    if (!tier) continue;
    byTier[tier.name ?? 'unknown'] = (byTier[tier.name ?? 'unknown'] ?? 0) + 1;

    if (row.status !== 'active') {
      if (row.status === 'expired' && tier.name === 'trial') trialExpired++;
      continue;
    }
    if (tier.name === 'trial') {
      trialActive++;
      continue;
    }
    if ((tier.monthly_price_cents ?? 0) === 0 && (tier.annual_price_cents ?? 0) === 0) {
      activeFree++;
      continue;
    }
    activePaid++;
    if (row.billing_cycle === 'monthly') {
      mrrCents += tier.monthly_price_cents ?? 0;
    } else if (row.billing_cycle === 'annual') {
      mrrCents += Math.round((tier.annual_price_cents ?? 0) / 12);
    }
    arrCents += (row.billing_cycle === 'annual' ? (tier.annual_price_cents ?? 0) : (tier.monthly_price_cents ?? 0) * 12);
  }

  res.json({
    success: true,
    data: {
      mrr_cents: mrrCents,
      arr_cents: arrCents,
      active_paid_subscribers: activePaid,
      active_free_subscribers: activeFree,
      active_trial_subscribers: trialActive,
      expired_trials: trialExpired,
      subscribers_by_tier: byTier,
    },
  });
});

/**
 * @openapi
 * /admin/tiers:
 *   get:
 *     tags: [Admin]
 *     summary: List all active subscription tiers (admin-only — includes non-publicly-selectable tiers)
 *     description: |
 *       Unlike `GET /api/tiers` (which serves the public signup page and
 *       filters by `publicly_selectable=true`), this endpoint returns every
 *       active tier — including admin-provisioned ones like `free_full` /
 *       Full Access (Comp). Used by the AdminPanel's tier-assignment UI so
 *       admins can put a user on a comp tier the public signup never offers.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Tier list }
 */
adminRouter.get('/tiers', async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('subscription_tiers')
    .select('*')
    .eq('active', true)
    .order('sort_order');
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

/**
 * @openapi
 * /admin/users/{id}/role:
 *   post:
 *     tags: [Admin]
 *     summary: Promote / demote a user. Writes to user_role_meta_v2 (Sprint 8).
 *     description: |
 *       Source-of-truth for elevated roles is `user_role_meta_v2`. The legacy
 *       `users_v2.role` column has a frozen CHECK constraint that does NOT
 *       accept 'superuser' — so role changes flow through this endpoint, NOT
 *       through PUT /admin/users/:id with a role field.
 *
 *       Authorization rules:
 *         - Setting role to 'admin' or 'superuser' requires the caller to be a superuser.
 *         - Admins can demote (set role to 'user') but not promote.
 *         - A user cannot demote themselves to keep at least one superuser/admin in the system.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [user, admin, superuser]
 *               notes: { type: string }
 *     responses:
 *       200: { description: Role updated; returns the user with the new effective_role }
 *       403: { description: Caller lacks permission to grant the requested role }
 *       404: { description: User not found }
 */
adminRouter.post('/users/:id/role', validateBody(RoleChangeSchema), async (req: Request, res: Response) => {
  const { role, notes } = req.body as { role: 'user' | 'admin' | 'superuser'; notes?: string };
  const targetId = String(req.params.id);
  const callerEffectiveRole = req.effectiveRole;
  const callerId = req.realUserId ?? req.userId ?? 'unknown';

  // Sprint 8 spec: only superuser may grant elevated roles.
  if ((role === 'superuser' || role === 'admin') && callerEffectiveRole !== 'superuser') {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only superusers can promote others to admin or superuser' },
    });
    return;
  }

  // Don't let callers strip themselves of access in one click.
  if (targetId === callerId && role === 'user' && (callerEffectiveRole === 'admin' || callerEffectiveRole === 'superuser')) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Cannot demote yourself. Ask another superuser to do it.' },
    });
    return;
  }

  const supabase = getSupabaseAdmin();

  try {
    // Confirm target exists.
    const { data: target } = await supabase.from('users_v2').select('user_id, role').eq('user_id', targetId).maybeSingle();
    if (!target) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return;
    }

    if (role === 'user') {
      // Demote: clear the meta row + set legacy column to 'user'
      await supabase.from('user_role_meta_v2').delete().eq('user_id', targetId);
      await supabase.from('users_v2').update({ role: 'user' }).eq('user_id', targetId);
    } else {
      // Promote / change elevation
      await supabase
        .from('user_role_meta_v2')
        .upsert(
          {
            user_id: targetId,
            role,
            granted_by: callerId,
            granted_at: new Date().toISOString(),
            notes: notes ?? null,
          },
          { onConflict: 'user_id' },
        );
      // Keep legacy column in sync — its CHECK constraint accepts 'admin' but
      // not 'superuser'. For superuser elevation we leave the legacy column at
      // 'admin' (defensible: every superuser is also an admin) so any older
      // code path that still reads users_v2.role gets a sensible answer.
      await supabase.from('users_v2').update({ role: 'admin' }).eq('user_id', targetId);
    }

    // Return the enriched row matching the user-list shape.
    const { data: updated } = await supabase.from('users_v2').select('*').eq('user_id', targetId).maybeSingle();
    const { data: roleMeta } = await supabase.from('user_role_meta_v2').select('role').eq('user_id', targetId).maybeSingle();
    const effective_role = (roleMeta as { role?: string } | null)?.role ?? (updated?.role === 'admin' ? 'admin' : 'user');

    logger.info({ caller: callerId, target: targetId, role }, 'admin: role changed');
    res.json({ success: true, data: { ...updated, effective_role } });
  } catch (err) {
    logger.error({ err, target: targetId }, 'admin: role change failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to change role' } });
  }
});

/**
 * @openapi
 * /admin/users/{id}/email-prefs:
 *   get:
 *     tags: [Admin]
 *     summary: Read a user's app_config_v2 email overrides (recipient + bcc)
 *     description: |
 *       Used by the admin Edit User dialog to populate the same fields that
 *       appear in the user's own Settings page. The values live in
 *       app_config_v2 (key='recipient_email' and key='bcc_email').
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ recipient_email: string|null, bcc_email: string|null }" }
 */
adminRouter.get('/users/:id/email-prefs', async (req: Request, res: Response) => {
  const targetId = String(req.params.id);
  const { data, error } = await getSupabaseAdmin()
    .from('app_config_v2')
    .select('key, value')
    .eq('user_id', targetId)
    .in('key', ['recipient_email', 'bcc_email']);
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  const map: Record<string, string | null> = { recipient_email: null, bcc_email: null };
  for (const row of (data ?? []) as Array<{ key: string; value: string }>) {
    if (row.key in map) map[row.key] = row.value ?? null;
  }
  res.json({ success: true, data: map });
});

/**
 * @openapi
 * /admin/users/{id}/full:
 *   post:
 *     tags: [Admin]
 *     summary: One-shot admin update for profile + email overrides + password (hotfix 2026-04-28)
 *     description: |
 *       Single endpoint that touches every field a user can change in their own
 *       Settings page. All fields are optional — only the present ones are
 *       written.
 *
 *       - `display_name`, `email` → users_v2 update
 *       - `recipient_email`, `bcc_email` → app_config_v2 upsert
 *       - `password` → Supabase Auth admin updateUserById
 *
 *       The legacy `PUT /api/admin/users/:id` is kept for backward compat with
 *       older callers (it only handles display_name + email + role on the
 *       legacy column). New admin UI uses this `/full` endpoint.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "Per-field results: { display_name?, email?, recipient_email?, bcc_email?, password? } each with ok/error" }
 *       400: { description: Validation error }
 *       404: { description: User not found }
 */
adminRouter.post('/users/:id/full', validateBody(AdminUserFullUpdateSchema), async (req: Request, res: Response) => {
  const targetId = String(req.params.id);
  const { display_name, email, recipient_email, bcc_email, password } = req.body as {
    display_name?: string;
    email?: string | null;
    recipient_email?: string | null;
    bcc_email?: string | null;
    password?: string;
  };
  const supabase = getSupabaseAdmin();

  // Confirm target exists.
  const { data: existing } = await supabase
    .from('users_v2')
    .select('user_id, email, supabase_auth_uid')
    .eq('user_id', targetId)
    .maybeSingle();
  if (!existing) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }

  const results: Record<string, { ok: boolean; error?: string; note?: string }> = {};

  // 1. Profile (users_v2)
  let effectiveEmail = (existing as { email: string | null }).email;
  if (display_name !== undefined || email !== undefined) {
    const updates: Record<string, unknown> = {};
    if (display_name !== undefined) updates.display_name = display_name.trim();
    if (email !== undefined) {
      const trimmed = email && email.trim() !== '' ? email.trim() : null;
      updates.email = trimmed;
      effectiveEmail = trimmed;
    }
    const { error } = await supabase.from('users_v2').update(updates).eq('user_id', targetId);
    results.profile = error ? { ok: false, error: error.message } : { ok: true };
  }

  // 2. App config — recipient_email + bcc_email
  for (const [key, raw] of [
    ['recipient_email', recipient_email],
    ['bcc_email', bcc_email],
  ] as const) {
    if (raw === undefined) continue;
    const value = raw === null ? '' : raw.trim();
    const { error } = await supabase
      .from('app_config_v2')
      .upsert({ user_id: targetId, key, value }, { onConflict: 'user_id,key' });
    results[key] = error ? { ok: false, error: error.message } : { ok: true };
  }

  // 3. Password — Supabase Auth admin updateUserById, OR createUser if the
  // user was provisioned by an admin and never finished signup (no auth UUID).
  // Admin-created users (POST /admin/users-with-subscription) only get a
  // users_v2 row; they have no auth.users entry until they complete signup.
  // When an admin sets a password from the Edit dialog, we treat that as
  // "finalize the signup": create the auth account with email + password,
  // mark email_confirm so they can log in immediately, then link the UUID
  // back into users_v2.
  if (password !== undefined) {
    const authUid = (existing as { supabase_auth_uid: string | null }).supabase_auth_uid;
    if (authUid) {
      const { error } = await supabase.auth.admin.updateUserById(authUid, { password });
      if (error) {
        results.password = { ok: false, error: error.message };
        logger.warn({ targetId, err: error }, 'admin: password reset failed');
      } else {
        results.password = { ok: true };
        logger.info({ targetId, by: req.realUserId ?? req.userId }, 'admin: password reset by admin');
      }
    } else if (!effectiveEmail) {
      results.password = {
        ok: false,
        error:
          'User has no email on file — cannot create an auth account. Set the email field and save again.',
      };
    } else {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: effectiveEmail,
        password,
        email_confirm: true,
        user_metadata: { provisioned_by_admin: true, target_user_id: targetId },
      });
      if (createErr || !created?.user?.id) {
        results.password = {
          ok: false,
          error: createErr?.message ?? 'Failed to create Supabase Auth account',
        };
        logger.warn({ targetId, err: createErr }, 'admin: auth account creation failed');
      } else {
        const newUid = created.user.id;
        const { error: linkErr } = await supabase
          .from('users_v2')
          .update({ supabase_auth_uid: newUid })
          .eq('user_id', targetId);
        if (linkErr) {
          results.password = {
            ok: false,
            error: `Auth account created but failed to link UUID: ${linkErr.message}`,
          };
          logger.error({ targetId, newUid, err: linkErr }, 'admin: failed to link auth UID');
        } else {
          results.password = { ok: true, note: 'Created Supabase Auth account and linked it' };
          logger.info(
            { targetId, newUid, by: req.realUserId ?? req.userId },
            'admin: created auth account for admin-provisioned user',
          );
        }
      }
    }
  }

  // Return the per-field outcomes so the client can show partial-success feedback.
  res.json({ success: true, data: { user_id: targetId, results } });
});


