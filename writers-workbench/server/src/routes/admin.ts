import { Router, Request, Response } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AdminUserSchema, AdminUserUpdateSchema } from '../schemas.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const adminRouter = Router();

// All admin routes require JWT + admin role
adminRouter.use(requireAuth, requireAdmin);

// GET /api/admin/users — list all users
adminRouter.get('/users', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseAdmin();
    const { data: users, error } = await supabase
      .from('users_v2')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with content and project counts
    const enriched = await Promise.all(
      (users || []).map(async (user) => {
        const [contentRes, projectRes] = await Promise.all([
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
        ]);
        return {
          ...user,
          content_count: contentRes.count ?? 0,
          project_count: projectRes.count ?? 0,
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
