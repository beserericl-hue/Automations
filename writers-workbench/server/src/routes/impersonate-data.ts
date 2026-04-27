// Sprint 8 (S8-4 follow-up): server-side data proxy for impersonation.
//
// Why this exists: when a superuser impersonates another user via the
// X-Impersonate-User header, requireAuth swaps `req.userId` to the target.
// But the client's direct Supabase queries still flow under the SUPERUSER's
// JWT, and RLS on the data tables filters by get_current_user_id() — so the
// browser sees the superuser's rows, not the target's.
//
// Refactoring every client query to route through the server is a large lift,
// and adding admin-bypass RLS policies on base tables conflicts with schema
// governance. The compromise is this proxy: superuser-only routes that use
// service role and trust `req.userId` (which is the impersonated id when
// X-Impersonate-User is honoured by requireAuth).
//
// All routes here are gated by requireSuperuser. Non-superuser callers get
// 403, even when X-Impersonate-User is not set.

import { Router, Request, Response } from 'express';
import { requireAuth, requireSuperuser } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const impersonateDataRouter = Router();

impersonateDataRouter.use(requireAuth, requireSuperuser);

// Helper: identify whether the request actually represents an impersonation
// session. Superusers can hit these endpoints without impersonating to inspect
// any user's data — that's intentional for the SuperuserPanel.
function targetUserId(req: Request): string {
  return req.userId!;
}

interface ProjectSummary { id: string; title: string; status: string | null; genre_slug: string | null; outline: { story_arc_name?: string } | null; updated_at: string }

/**
 * @openapi
 * /impersonate/data/dashboard:
 *   get:
 *     tags: [Superuser]
 *     summary: Counts + recent items as the impersonated user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Impersonate-User
 *         schema: { type: string }
 *     responses:
 *       200: { description: Counts + recent items in one payload }
 */
impersonateDataRouter.get('/dashboard', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const supabase = getSupabaseAdmin();

  try {
    const [projects, drafts, published, research, contentList, projectList, researchList] = await Promise.all([
      supabase.from('writing_projects_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('published_content_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'draft').is('deleted_at', null),
      supabase.from('published_content_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'published').is('deleted_at', null),
      supabase.from('research_reports_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null),
      supabase.from('published_content_v2')
        .select('id, title, content_type, status, genre_slug, content_text, chapter_number, project_id, updated_at')
        .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(10),
      supabase.from('writing_projects_v2')
        .select('id, title, status, genre_slug, outline, updated_at')
        .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(5),
      supabase.from('research_reports_v2')
        .select('id, topic, status, genre_slug, content, updated_at')
        .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(5),
    ]);

    // Resolve project titles for content rows (one extra query)
    const projectIds = new Set<string>();
    for (const c of (contentList.data ?? []) as Array<{ project_id: string | null }>) {
      if (c.project_id) projectIds.add(c.project_id);
    }
    let projectMap: Record<string, { title: string; story_arc: string | null }> = {};
    if (projectIds.size > 0) {
      const { data: projs } = await supabase
        .from('writing_projects_v2')
        .select('id, title, outline')
        .in('id', Array.from(projectIds));
      if (projs) {
        for (const p of projs as ProjectSummary[]) {
          projectMap[p.id] = { title: p.title, story_arc: p.outline?.story_arc_name ?? null };
        }
      }
    }

    res.json({
      success: true,
      data: {
        target_user_id: userId,
        counts: {
          projects: projects.count ?? 0,
          drafts: drafts.count ?? 0,
          published: published.count ?? 0,
          research: research.count ?? 0,
        },
        contentRows: contentList.data ?? [],
        projectRows: projectList.data ?? [],
        researchRows: researchList.data ?? [],
        projectMap,
      },
    });
  } catch (err) {
    logger.error({ err, userId }, 'impersonate-data/dashboard failed');
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  }
});

/**
 * @openapi
 * /impersonate/data/projects:
 *   get:
 *     tags: [Superuser]
 *     summary: Project list as the impersonated user
 *     security:
 *       - bearerAuth: []
 */
impersonateDataRouter.get('/projects', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const limit = Math.min(500, Math.max(1, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10) || 50));

  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/projects/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  res.json({ success: true, data });
});

/**
 * @openapi
 * /impersonate/data/content:
 *   get:
 *     tags: [Superuser]
 *     summary: Content list as the impersonated user (filterable)
 */
impersonateDataRouter.get('/content', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const type = typeof req.query.type === 'string' ? req.query.type : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;
  const limit = Math.min(500, Math.max(1, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '100', 10) || 100));

  let q = getSupabaseAdmin()
    .from('published_content_v2')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (type) q = q.eq('content_type', type);
  if (status) q = q.eq('status', status);
  if (projectId) q = q.eq('project_id', projectId);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/content/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  res.json({ success: true, data });
});

impersonateDataRouter.get('/research', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const limit = Math.min(500, Math.max(1, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10) || 50));

  const { data, error } = await getSupabaseAdmin()
    .from('research_reports_v2')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/story-bible/:projectId', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('story_bible_v2')
    .select('*')
    .eq('user_id', userId)
    .eq('project_id', req.params.projectId)
    .is('deleted_at', null)
    .order('entry_type, name');

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/outline-versions-info/:projectId', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error, count } = await getSupabaseAdmin()
    .from('outline_versions_v2')
    .select('version_number, created_at, revision_note', { count: 'exact' })
    .eq('project_id', req.params.projectId)
    .eq('user_id', userId)
    .order('version_number', { ascending: false })
    .limit(1);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({
    success: true,
    data: {
      totalVersions: count ?? 0,
      latestVersion: data?.[0] ?? null,
    },
  });
});

impersonateDataRouter.get('/outline-versions/:projectId', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('outline_versions_v2')
    .select('*')
    .eq('project_id', req.params.projectId)
    .eq('user_id', userId)
    .order('version_number', { ascending: false });

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

/**
 * Lightweight project list — id+title only — used by the sidebar's "My Projects"
 * expandable section. Same shape as the existing direct Supabase query.
 */
impersonateDataRouter.get('/projects-summary', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const limit = Math.min(100, Math.max(1, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20));

  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('id, title, status, updated_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

/** Content version history (read-only audit) for a content item. */
impersonateDataRouter.get('/content-versions/:contentId', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('content_versions_v2')
    .select('*')
    .eq('content_id', req.params.contentId)
    .eq('user_id', userId)
    .order('version_number', { ascending: false });

  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/research/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('research_reports_v2')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  res.json({ success: true, data });
});

impersonateDataRouter.get('/images', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;
  const imageType = typeof req.query.image_type === 'string' ? req.query.image_type : null;
  const limit = Math.min(500, Math.max(1, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '100', 10) || 100));

  let q = getSupabaseAdmin()
    .from('generated_images_v2')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (projectId) q = q.eq('project_id', projectId);
  if (imageType) q = q.eq('image_type', imageType);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

impersonateDataRouter.get('/images/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('generated_images_v2')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    return;
  }
  res.json({ success: true, data });
});

impersonateDataRouter.get('/social-posts', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;
  const platform = typeof req.query.platform === 'string' ? req.query.platform : null;
  const sourceContentId = typeof req.query.source_content_id === 'string' ? req.query.source_content_id : null;

  let q = getSupabaseAdmin()
    .from('social_posts_v2')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (projectId) q = q.eq('project_id', projectId);
  if (platform) q = q.eq('platform', platform);
  if (sourceContentId) q = q.eq('source_content_id', sourceContentId);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

/** Soft-deleted items the user could restore (Trash view). */
impersonateDataRouter.get('/trash', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const supabase = getSupabaseAdmin();
  const [projectsRes, contentRes, researchRes, bibleRes] = await Promise.all([
    supabase.from('writing_projects_v2').select('*').eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
    supabase.from('published_content_v2').select('*').eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
    supabase.from('research_reports_v2').select('*').eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
    supabase.from('story_bible_v2').select('*').eq('user_id', userId).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
  ]);
  res.json({
    success: true,
    data: {
      projects: projectsRes.data ?? [],
      content: contentRes.data ?? [],
      research: researchRes.data ?? [],
      bible: bibleRes.data ?? [],
    },
  });
});

/** Cross-cutting search across the impersonated user's projects, content, research. */
impersonateDataRouter.get('/search', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ success: true, data: { projects: [], content: [], research: [] } });
    return;
  }
  const supabase = getSupabaseAdmin();
  const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const [projectsRes, contentRes, researchRes] = await Promise.all([
    supabase.from('writing_projects_v2').select('id, title, status, genre_slug').eq('user_id', userId).is('deleted_at', null).ilike('title', pattern).limit(15),
    supabase.from('published_content_v2').select('id, title, content_type, status, project_id').eq('user_id', userId).is('deleted_at', null).ilike('title', pattern).limit(15),
    supabase.from('research_reports_v2').select('id, topic, status, genre_slug').eq('user_id', userId).is('deleted_at', null).ilike('topic', pattern).limit(15),
  ]);
  res.json({
    success: true,
    data: {
      projects: projectsRes.data ?? [],
      content: contentRes.data ?? [],
      research: researchRes.data ?? [],
    },
  });
});

impersonateDataRouter.get('/token-usage', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const sinceDays = Math.min(365, Math.max(1, parseInt(typeof req.query.days === 'string' ? req.query.days : '30', 10) || 30));
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);

  const { data, error } = await getSupabaseAdmin()
    .from('token_usage_v2')
    .select('*')
    .eq('user_id', userId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  res.json({ success: true, data: data ?? [] });
});

/**
 * Content provenance — flattened content_usage_v2 + content_index join.
 * Mirrors the shape ProvenancePanel.tsx expects from its direct Supabase query
 * (joined `content_index` with `or(output_title.eq.X, content_id.eq.X)` filter).
 */
impersonateDataRouter.get('/provenance/:contentId', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const supabase = getSupabaseAdmin();
  const { data: usage, error } = await supabase
    .from('content_usage_v2')
    .select(`
      id,
      content_id,
      output_type,
      output_title,
      created_at,
      content_index (
        title,
        source_type,
        source_url,
        scraped_at
      )
    `)
    .eq('user_id', userId)
    .or(`output_title.eq.${req.params.contentId},content_id.eq.${req.params.contentId}`);
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  type Row = {
    id: string;
    content_id: string;
    output_type: string;
    output_title: string;
    created_at: string;
    content_index: { title?: string; source_type?: string; source_url?: string; scraped_at?: string } | null;
  };
  const flattened = ((usage ?? []) as Row[]).map((row) => ({
    id: row.id,
    content_id: row.content_id,
    output_type: row.output_type,
    output_title: row.output_title,
    created_at: row.created_at,
    source_title: row.content_index?.title ?? null,
    source_type: row.content_index?.source_type ?? null,
    source_url: row.content_index?.source_url ?? null,
    scraped_at: row.content_index?.scraped_at ?? null,
  }));
  res.json({ success: true, data: flattened });
});

impersonateDataRouter.get('/outlines', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('id, title, status, genre_slug, outline, chapter_count, updated_at, created_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .not('outline', 'is', null)
    .order('updated_at', { ascending: false });
  if (error) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  // Filter out empty outline JSONBs ('{}') the same way the existing UI does.
  const filtered = (data ?? []).filter((p: { outline?: Record<string, unknown> | null }) => {
    const o = p.outline;
    return o && typeof o === 'object' && Object.keys(o).length > 0;
  });
  res.json({ success: true, data: filtered });
});
