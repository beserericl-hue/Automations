/**
 * Per-genre user ingestion URL routes (migration 013).
 *
 * GET    /api/genres/:slug/urls               — list URLs visible to caller
 * POST   /api/genres/:slug/urls               — add URL (private; public requires admin)
 * DELETE /api/genres/:slug/urls/:id           — remove URL (own + admin)
 *
 * Visibility model:
 *   - The seeded text[] columns on genre_config_v2 (rss_feed_urls, source_urls,
 *     subreddit_names, goodreads_shelves) remain canonical for the public
 *     URLs admins curated pre-Sprint-8. This endpoint augments them with
 *     per-row entries from genre_ingestion_urls_v2.
 *   - Regular users see public + own private rows.
 *   - Admin / superuser callers see everything (including other users' private rows).
 *
 * The migration's RLS would already enforce this if the route used a
 * caller-scoped Supabase client. We use the service-role client (consistent
 * with the rest of the routes) and apply the same logic in code so the
 * policy and the route can't drift.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import {
  AddGenreUrlSchema,
  GenreSlugParamSchema,
  GenreUrlIdParamSchema,
} from '../schemas.js';
import { logger } from '../lib/logger.js';

export const genresRouter = Router();

function isAdminCaller(req: Request): boolean {
  return req.effectiveRole === 'admin' || req.effectiveRole === 'superuser';
}

// ----------------------------------------------------------------------
// GET /api/genres/:slug/urls
// ----------------------------------------------------------------------
genresRouter.get('/:slug/urls', requireAuth, async (req: Request, res: Response) => {
  const parsed = GenreSlugParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  const slug = parsed.data.slug;
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();

  // Service role bypasses RLS; we filter explicitly to match the policy.
  let query = supabase
    .from('genre_ingestion_urls_v2')
    .select('id, genre_slug, url, url_type, visibility, created_by_user_id, label, active, created_at, updated_at')
    .eq('genre_slug', slug)
    .eq('active', true)
    .order('url_type', { ascending: true })
    .order('created_at', { ascending: true });

  if (!isAdminCaller(req)) {
    // Non-admin: public OR mine. Supabase-js .or() takes the PostgREST
    // operator string. We URL-encode the user_id only because it can
    // contain a leading '+' which PostgREST treats as a space.
    query = query.or(`visibility.eq.public,created_by_user_id.eq.${encodeURIComponent(userId)}`);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ error, slug, userId }, 'genre_urls list failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }

  res.json({ success: true, urls: data ?? [] });
});

// ----------------------------------------------------------------------
// POST /api/genres/:slug/urls
// ----------------------------------------------------------------------
genresRouter.post(
  '/:slug/urls',
  requireAuth,
  validateBody(AddGenreUrlSchema),
  async (req: Request, res: Response) => {
    const params = GenreSlugParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', fields: params.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      });
      return;
    }
    const slug = params.data.slug;
    const body = req.body as import('zod').infer<typeof AddGenreUrlSchema>;
    const userId = req.userId!;

    // Public URLs are admin/superuser-only. The migration's RLS WITH-CHECK
    // also enforces this, but the route catches it earlier with a clean 403.
    if (body.visibility === 'public' && !isAdminCaller(req)) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only admins can add public genre URLs' },
      });
      return;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('genre_ingestion_urls_v2')
      .insert({
        genre_slug: slug,
        url: body.url,
        url_type: body.url_type,
        visibility: body.visibility,
        created_by_user_id: userId,
        label: body.label ?? null,
      })
      .select('id, genre_slug, url, url_type, visibility, created_by_user_id, label, active, created_at, updated_at')
      .single();

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE', message: 'You already added this URL to this genre' },
        });
        return;
      }
      if (code === '23503') {
        res.status(400).json({
          success: false,
          error: { code: 'FK_VIOLATION', message: 'user_id does not exist' },
        });
        return;
      }
      logger.error({ error, slug, userId }, 'genre_urls insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_INSERT_FAILED', message: error.message } });
      return;
    }

    res.status(201).json({ success: true, url: data });
  },
);

// ----------------------------------------------------------------------
// DELETE /api/genres/:slug/urls/:id
// ----------------------------------------------------------------------
genresRouter.delete('/:slug/urls/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = GenreUrlIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  const { slug, id } = parsed.data;
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();

  // Look up the row so we can apply ownership rules and return a precise 404
  // / 403 instead of a silent zero-row delete.
  const { data: existing, error: lookupErr } = await supabase
    .from('genre_ingestion_urls_v2')
    .select('id, genre_slug, created_by_user_id')
    .eq('id', id)
    .eq('genre_slug', slug)
    .maybeSingle();

  if (lookupErr) {
    logger.error({ lookupErr, id, slug }, 'genre_urls delete: lookup failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: lookupErr.message } });
    return;
  }
  if (!existing) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'URL not found' } });
    return;
  }

  if (existing.created_by_user_id !== userId && !isAdminCaller(req)) {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only delete your own URLs' } });
    return;
  }

  const { error: delErr } = await supabase
    .from('genre_ingestion_urls_v2')
    .delete()
    .eq('id', id);

  if (delErr) {
    logger.error({ delErr, id, slug }, 'genre_urls delete failed');
    res.status(500).json({ success: false, error: { code: 'DB_DELETE_FAILED', message: delErr.message } });
    return;
  }

  res.json({ success: true });
});

// ----------------------------------------------------------------------
// GET /api/admin/genre-urls — admin/superuser cross-user view of every URL
// row in genre_ingestion_urls_v2. Useful for moderation; not used by the
// non-admin UI surface.
// ----------------------------------------------------------------------
export const adminGenreUrlsRouter = Router();
adminGenreUrlsRouter.get('/', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('genre_ingestion_urls_v2')
    .select('id, genre_slug, url, url_type, visibility, created_by_user_id, label, active, created_at, updated_at')
    .order('genre_slug', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) {
    logger.error({ error }, 'admin genre_urls list failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }
  res.json({ success: true, urls: data ?? [] });
});
