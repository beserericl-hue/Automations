import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { DeleteAccountSchema } from '../schemas.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const accountRouter = Router();

// All account routes require JWT
accountRouter.use(requireAuth);

/**
 * DELETE /api/account — delete the authenticated user's own account.
 * Requires body: { confirmation: "DELETE" }
 * Cascade: users_v2 ON DELETE CASCADE handles all child tables.
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
 * GET /api/account/cascade-info — get counts of data that will be deleted
 */
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
