// Sprint 8 (S8-4 follow-up, write impersonation): proxy mutations as the
// impersonated user. Mirrors the client's existing direct-Supabase writes
// (saveMutation, deleteMutation, restoreMutation, etc.) but routes through
// the server with service role + the swapped req.userId.
//
// Every successful write appends an audit entry to impersonation_log.actions_taken
// so the target user has a record of what the superuser did on their behalf.
//
// Field whitelists are explicit per route — the client may send any set of
// fields, but only the named ones get through. New writable columns require
// updating the whitelist here.

import { Router, Request, Response } from 'express';
import { requireAuth, requireSuperuser } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const impersonateWriteRouter = Router();

// All endpoints are superuser-only. The data-plane proxy (impersonate-data.ts)
// permits non-impersonating superusers to inspect any user's data; for writes
// we additionally require an active impersonation session — i.e. the superuser
// must have called POST /api/superuser/impersonate first. This keeps writes
// always tied to a logged audit row.
impersonateWriteRouter.use(requireAuth, requireSuperuser, (req: Request, res: Response, next) => {
  if (!req.isImpersonating || !req.impersonationLogId) {
    res.status(400).json({
      success: false,
      error: { code: 'NO_IMPERSONATION_SESSION', message: 'Start impersonation before calling write endpoints' },
    });
    return;
  }
  next();
});

const targetUserId = (req: Request) => req.userId!;

/** Pull only the named keys out of `body`. Drops anything else silently. */
function pick<T extends Record<string, unknown>>(body: unknown, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  if (!body || typeof body !== 'object') return out;
  const obj = body as Record<string, unknown>;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k as string)) {
      (out as Record<string, unknown>)[k as string] = obj[k as string];
    }
  }
  return out;
}

interface ImpersonationActionEntry {
  at: string;
  superuser_id: string;
  target_user_id: string;
  action: string;
  resource: { table: string; id?: string };
  fields_changed?: string[];
  result: 'ok' | 'error';
  error?: string;
}

/** Append an audit record to impersonation_log.actions_taken (best-effort). */
async function logAction(req: Request, entry: Omit<ImpersonationActionEntry, 'at' | 'superuser_id' | 'target_user_id'>): Promise<void> {
  if (!req.impersonationLogId) return;
  const full: ImpersonationActionEntry = {
    at: new Date().toISOString(),
    superuser_id: req.realUserId ?? 'unknown',
    target_user_id: req.userId ?? 'unknown',
    ...entry,
  };
  try {
    const supabase = getSupabaseAdmin();
    const { data: row } = await supabase
      .from('impersonation_log')
      .select('actions_taken')
      .eq('id', req.impersonationLogId)
      .maybeSingle();
    const current = (row?.actions_taken as ImpersonationActionEntry[] | null) ?? [];
    const next = [...current, full].slice(-500); // bound the log to last 500 actions
    await supabase
      .from('impersonation_log')
      .update({ actions_taken: next })
      .eq('id', req.impersonationLogId);
  } catch (err) {
    logger.warn({ err, log_id: req.impersonationLogId }, 'impersonate-write: audit log append failed');
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT_WRITABLE_FIELDS = ['title', 'genre_slug', 'status', 'project_type', 'outline', 'chapter_count', 'draft_path'] as const;

impersonateWriteRouter.patch('/projects/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const updates = pick(req.body, PROJECT_WRITABLE_FIELDS);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: { code: 'NO_FIELDS', message: 'No valid fields to update' } });
    return;
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('writing_projects_v2')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    await logAction(req, { action: 'project.update', resource: { table: 'writing_projects_v2', id: String(req.params.id) }, result: 'error', error: error.message });
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  await logAction(req, {
    action: 'project.update',
    resource: { table: 'writing_projects_v2', id: String(req.params.id) },
    fields_changed: Object.keys(updates),
    result: 'ok',
  });
  res.json({ success: true, data });
});

impersonateWriteRouter.delete('/projects/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Mirror the client's cascade behavior — soft-delete project + child content + bible.
  const [projRes, contentRes, bibleRes] = await Promise.all([
    supabase.from('writing_projects_v2').update({ deleted_at: now }).eq('id', String(req.params.id)).eq('user_id', userId).select('id').maybeSingle(),
    supabase.from('published_content_v2').update({ deleted_at: now }).eq('project_id', String(req.params.id)).eq('user_id', userId).is('deleted_at', null).select('id'),
    supabase.from('story_bible_v2').update({ deleted_at: now }).eq('project_id', String(req.params.id)).eq('user_id', userId).is('deleted_at', null).select('id'),
  ]);

  if (projRes.error || !projRes.data) {
    await logAction(req, { action: 'project.delete', resource: { table: 'writing_projects_v2', id: String(req.params.id) }, result: 'error', error: projRes.error?.message ?? 'not found' });
    res.status(projRes.error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: projRes.error?.message ?? 'Project not found' } });
    return;
  }

  await logAction(req, {
    action: 'project.delete',
    resource: { table: 'writing_projects_v2', id: String(req.params.id) },
    fields_changed: ['deleted_at'],
    result: 'ok',
  });
  res.json({
    success: true,
    data: {
      project_id: String(req.params.id),
      content_cascaded: contentRes.data?.length ?? 0,
      bible_cascaded: bibleRes.data?.length ?? 0,
    },
  });
});

impersonateWriteRouter.post('/projects/:id/restore', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .update({ deleted_at: null })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'project.restore', resource: { table: 'writing_projects_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'project.restore', resource: { table: 'writing_projects_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const CONTENT_WRITABLE_FIELDS = [
  'title', 'content_text', 'storage_path', 'cover_image_path', 'status',
  'genre_slug', 'project_id', 'chapter_number', 'metadata', 'published_at',
] as const;

impersonateWriteRouter.patch('/content/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const updates = pick(req.body, CONTENT_WRITABLE_FIELDS);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: { code: 'NO_FIELDS', message: 'No valid fields to update' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('published_content_v2')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'content.update', resource: { table: 'published_content_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, {
    action: 'content.update',
    resource: { table: 'published_content_v2', id: String(req.params.id) },
    fields_changed: Object.keys(updates),
    result: 'ok',
  });
  res.json({ success: true, data });
});

impersonateWriteRouter.delete('/content/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('published_content_v2')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'content.delete', resource: { table: 'published_content_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'content.delete', resource: { table: 'published_content_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

impersonateWriteRouter.post('/content/:id/restore', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('published_content_v2')
    .update({ deleted_at: null })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'content.restore', resource: { table: 'published_content_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'content.restore', resource: { table: 'published_content_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

/**
 * Insert a content_versions_v2 snapshot. Used by the editor's auto-save and
 * any explicit "save version" flow. version_number is computed server-side
 * from the max existing version.
 */
impersonateWriteRouter.post('/content-versions', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const body = (req.body ?? {}) as { content_id?: string; content_text?: string; changed_by?: string; change_note?: string };
  if (!body.content_id || typeof body.content_text !== 'string') {
    res.status(400).json({ success: false, error: { code: 'INVALID_BODY', message: 'content_id and content_text required' } });
    return;
  }
  const supabase = getSupabaseAdmin();
  // Verify the content belongs to the impersonated user (RLS bypass means we must check explicitly).
  const { data: content } = await supabase
    .from('published_content_v2')
    .select('id')
    .eq('id', body.content_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!content) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Content not found for target user' } });
    return;
  }
  const { data: latest } = await supabase
    .from('content_versions_v2')
    .select('version_number')
    .eq('content_id', body.content_id)
    .order('version_number', { ascending: false })
    .limit(1);
  const nextVersion = ((latest?.[0]?.version_number as number | undefined) ?? 0) + 1;

  const { data, error } = await supabase
    .from('content_versions_v2')
    .insert({
      user_id: userId,
      content_id: body.content_id,
      version_number: nextVersion,
      content_text: body.content_text,
      changed_by: body.changed_by ?? `superuser_impersonation:${req.realUserId ?? 'unknown'}`,
      change_note: body.change_note ?? 'Saved during superuser impersonation',
    })
    .select()
    .single();

  if (error) {
    await logAction(req, { action: 'content_version.create', resource: { table: 'content_versions_v2', id: body.content_id }, result: 'error', error: error.message });
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  await logAction(req, {
    action: 'content_version.create',
    resource: { table: 'content_versions_v2', id: body.content_id },
    result: 'ok',
  });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Story Bible
// ---------------------------------------------------------------------------

const BIBLE_WRITABLE_FIELDS = ['project_id', 'entry_type', 'name', 'description', 'metadata', 'chapter_introduced', 'last_chapter_seen'] as const;

impersonateWriteRouter.post('/story-bible', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const fields = pick(req.body, BIBLE_WRITABLE_FIELDS);
  if (!fields.project_id || !fields.entry_type || !fields.name) {
    res.status(400).json({ success: false, error: { code: 'INVALID_BODY', message: 'project_id, entry_type, and name are required' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('story_bible_v2')
    .insert({ ...fields, user_id: userId })
    .select()
    .single();
  if (error) {
    await logAction(req, { action: 'story_bible.create', resource: { table: 'story_bible_v2' }, result: 'error', error: error.message });
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  await logAction(req, {
    action: 'story_bible.create',
    resource: { table: 'story_bible_v2', id: data.id as string },
    fields_changed: Object.keys(fields),
    result: 'ok',
  });
  res.status(201).json({ success: true, data });
});

impersonateWriteRouter.patch('/story-bible/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const updates = pick(req.body, BIBLE_WRITABLE_FIELDS);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: { code: 'NO_FIELDS', message: 'No valid fields to update' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('story_bible_v2')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'story_bible.update', resource: { table: 'story_bible_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, {
    action: 'story_bible.update',
    resource: { table: 'story_bible_v2', id: String(req.params.id) },
    fields_changed: Object.keys(updates),
    result: 'ok',
  });
  res.json({ success: true, data });
});

impersonateWriteRouter.delete('/story-bible/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('story_bible_v2')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'story_bible.delete', resource: { table: 'story_bible_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'story_bible.delete', resource: { table: 'story_bible_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

const RESEARCH_WRITABLE_FIELDS = ['topic', 'genre_slug', 'content', 'status'] as const;

impersonateWriteRouter.patch('/research/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const updates = pick(req.body, RESEARCH_WRITABLE_FIELDS);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: { code: 'NO_FIELDS', message: 'No valid fields to update' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('research_reports_v2')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'research.update', resource: { table: 'research_reports_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, {
    action: 'research.update',
    resource: { table: 'research_reports_v2', id: String(req.params.id) },
    fields_changed: Object.keys(updates),
    result: 'ok',
  });
  res.json({ success: true, data });
});

impersonateWriteRouter.delete('/research/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('research_reports_v2')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'research.delete', resource: { table: 'research_reports_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'research.delete', resource: { table: 'research_reports_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

impersonateWriteRouter.post('/research/:id/restore', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('research_reports_v2')
    .update({ deleted_at: null })
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'research.restore', resource: { table: 'research_reports_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'research.restore', resource: { table: 'research_reports_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_WRITABLE_FIELDS = [
  'content_id', 'project_id', 'image_type', 'platform', 'storage_path', 'thumbnail_path',
  'original_prompt', 'genre_slug', 'image_format', 'width', 'height', 'file_size_bytes',
  'generation_model', 'metadata',
] as const;

impersonateWriteRouter.post('/images', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const fields = pick(req.body, IMAGE_WRITABLE_FIELDS);
  if (!fields.storage_path || !fields.image_type) {
    res.status(400).json({ success: false, error: { code: 'INVALID_BODY', message: 'storage_path and image_type are required' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('generated_images_v2')
    .insert({ ...fields, user_id: userId })
    .select()
    .single();
  if (error) {
    await logAction(req, { action: 'image.create', resource: { table: 'generated_images_v2' }, result: 'error', error: error.message });
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }
  await logAction(req, { action: 'image.create', resource: { table: 'generated_images_v2', id: data.id as string }, result: 'ok' });
  res.status(201).json({ success: true, data });
});

impersonateWriteRouter.delete('/images/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('generated_images_v2')
    .delete()
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'image.delete', resource: { table: 'generated_images_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'image.delete', resource: { table: 'generated_images_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Social posts
// ---------------------------------------------------------------------------

const SOCIAL_WRITABLE_FIELDS = ['post_text', 'hashtags', 'image_id', 'status', 'scheduled_at', 'published_at', 'metadata'] as const;

impersonateWriteRouter.patch('/social-posts/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const updates = pick(req.body, SOCIAL_WRITABLE_FIELDS);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: { code: 'NO_FIELDS', message: 'No valid fields to update' } });
    return;
  }
  const { data, error } = await getSupabaseAdmin()
    .from('social_posts_v2')
    .update(updates)
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'social_post.update', resource: { table: 'social_posts_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, {
    action: 'social_post.update',
    resource: { table: 'social_posts_v2', id: String(req.params.id) },
    fields_changed: Object.keys(updates),
    result: 'ok',
  });
  res.json({ success: true, data });
});

impersonateWriteRouter.delete('/social-posts/:id', async (req: Request, res: Response) => {
  const userId = targetUserId(req);
  const { data, error } = await getSupabaseAdmin()
    .from('social_posts_v2')
    .delete()
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error || !data) {
    await logAction(req, { action: 'social_post.delete', resource: { table: 'social_posts_v2', id: String(req.params.id) }, result: 'error', error: error?.message ?? 'not found' });
    res.status(error ? 500 : 404).json({ success: false, error: { code: 'DB_ERROR', message: error?.message ?? 'Not found' } });
    return;
  }
  await logAction(req, { action: 'social_post.delete', resource: { table: 'social_posts_v2', id: String(req.params.id) }, result: 'ok' });
  res.json({ success: true, data });
});
