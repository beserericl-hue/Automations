/**
 * Multi-User Newsletters Sprint — feed sources + cron-driven ingestion fan-out.
 *
 * Two routers exported:
 *
 *   feedsRouter  — mounted under /api/newsletter, session-authenticated.
 *     GET    /editions/:id/feeds     list caller's feeds for an edition
 *     POST   /editions/:id/feeds     create a feed for an edition
 *     PUT    /feeds/:id              partial update
 *     DELETE /feeds/:id              hard delete (CASCADE drops the runs log)
 *
 *   feedsCronRouter — mounted under /api/newsletter/cron,
 *     guarded by X-Ingestion-Secret. n8n's multi-user cron workflow uses these:
 *     GET    /feeds/due              return active feeds whose interval has elapsed
 *     POST   /feeds/:id/runs         report the result of one fetch attempt
 *
 *   The /feeds/due route stamps `last_fetched_at = now()` on every row it
 *   returns, so two overlapping cron ticks don't double-fetch the same feed.
 *   The cron worker's POST /runs is best-effort logging — if it fails the
 *   row's last_fetched_at is already updated and the feed will simply be
 *   skipped until the next interval window.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import {
  CreateNewsletterFeedSchema,
  UpdateNewsletterFeedSchema,
  FeedIdParamSchema,
  FeedRunCallbackSchema,
  FeedsDueQuerySchema,
  NewsletterEditionIdParamSchema,
} from '../schemas.js';
import { logger } from '../lib/logger.js';

export const feedsRouter = Router();
export const feedsCronRouter = Router();

const requireIngestionSecret = requireSharedSecret('X-Ingestion-Secret', 'INGESTION_SECRET');

const FEED_COLUMNS =
  'id, user_id, edition_id, name, url, url_type, active, fetch_interval_minutes, last_fetched_at, last_item_count, last_error, created_at, updated_at';

// ---------------------------------------------------------------------------
// User-facing CRUD
// ---------------------------------------------------------------------------

// GET /api/newsletter/editions/:id/feeds — list feeds owned by the caller
// for a given edition.
feedsRouter.get('/editions/:id/feeds', requireAuth, async (req: Request, res: Response) => {
  const params = NewsletterEditionIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: params.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('newsletter_feed_sources_v2')
    .select(FEED_COLUMNS)
    .eq('user_id', userId)
    .eq('edition_id', params.data.id)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error, userId }, 'feeds list failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }
  res.json({ success: true, feeds: data ?? [] });
});

// POST /api/newsletter/editions/:id/feeds — add a feed to an edition.
feedsRouter.post(
  '/editions/:id/feeds',
  requireAuth,
  validateBody(CreateNewsletterFeedSchema),
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', fields: params.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      });
      return;
    }
    const userId = req.userId!;
    const editionId = params.data.id;
    const body = req.body as import('zod').infer<typeof CreateNewsletterFeedSchema>;
    const supabase = getSupabaseAdmin();

    // Confirm the edition exists and belongs to the caller. Saves the user
    // a confusing 23503 FK violation by returning a clear 404 instead.
    const { data: edition } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!edition) {
      res.status(404).json({ success: false, error: { code: 'EDITION_NOT_FOUND', message: 'Edition not found or not yours' } });
      return;
    }

    const { data, error } = await supabase
      .from('newsletter_feed_sources_v2')
      .insert({
        user_id: userId,
        edition_id: editionId,
        name: body.name,
        url: body.url,
        url_type: body.url_type,
        fetch_interval_minutes: body.fetch_interval_minutes,
        active: body.active,
      })
      .select(FEED_COLUMNS)
      .single();

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE_URL', message: 'You already added this URL to this newsletter' },
        });
        return;
      }
      logger.error({ error, userId, editionId }, 'feeds insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_INSERT_FAILED', message: error.message } });
      return;
    }
    res.status(201).json({ success: true, feed: data });
  },
);

// PUT /api/newsletter/feeds/:id — partial update.
feedsRouter.put(
  '/feeds/:id',
  requireAuth,
  validateBody(UpdateNewsletterFeedSchema),
  async (req: Request, res: Response) => {
    const params = FeedIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
      return;
    }
    const userId = req.userId!;
    const body = req.body as import('zod').infer<typeof UpdateNewsletterFeedSchema>;
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('newsletter_feed_sources_v2')
      .update(body)
      .eq('id', params.data.id)
      .eq('user_id', userId)
      .select(FEED_COLUMNS)
      .maybeSingle();

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE_URL', message: 'A feed with this URL already exists for this newsletter' },
        });
        return;
      }
      logger.error({ error, userId }, 'feeds update failed');
      res.status(500).json({ success: false, error: { code: 'DB_UPDATE_FAILED', message: error.message } });
      return;
    }
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Feed not found' } });
      return;
    }
    res.json({ success: true, feed: data });
  },
);

// DELETE /api/newsletter/feeds/:id — hard delete. Runs log cascades.
feedsRouter.delete('/feeds/:id', requireAuth, async (req: Request, res: Response) => {
  const params = FeedIdParamSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    return;
  }
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('newsletter_feed_sources_v2')
    .delete()
    .eq('id', params.data.id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error({ error, userId }, 'feeds delete failed');
    res.status(500).json({ success: false, error: { code: 'DB_DELETE_FAILED', message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Feed not found' } });
    return;
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/newsletter/editions/:id/feeds/import-from-genre
//   body: { genre_slug: string }
// Copies the genre's seeded URLs (genre_config_v2.rss_feed_urls,
// .source_urls, .subreddit_names) into newsletter_feed_sources_v2 for the
// caller's edition. Idempotent via the existing
// uq_feed_sources_dup unique index on (user_id, edition_id, lower(url)).
// Returns counts: { inserted, skipped_duplicate }.
//
// Subreddit names are converted to a Reddit feed URL of the shape
// https://www.reddit.com/r/<name>/.json — the multi-user cron worker
// already accepts url_type='reddit' for that path.
// ---------------------------------------------------------------------------
// Lightweight inline schema — co-located with the route since it's only
// used here. The genre_slug regex matches genre_config_v2's slug shape.
const ImportFromGenreSchema = z.object({
  genre_slug: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'genre_slug must be slug-style'),
});

feedsRouter.post(
  '/editions/:id/feeds/import-from-genre',
  requireAuth,
  validateBody(ImportFromGenreSchema),
  async (req: Request, res: Response) => {
    const params = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
      return;
    }
    const userId = req.userId!;
    const editionId = params.data.id;
    const body = req.body as { genre_slug: string };
    const supabase = getSupabaseAdmin();

    // Confirm edition ownership.
    const { data: edition } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!edition) {
      res.status(404).json({ success: false, error: { code: 'EDITION_NOT_FOUND', message: 'Edition not found or not yours' } });
      return;
    }

    // Pull the genre. Visible if public (user_id IS NULL) or own.
    const { data: genre, error: genreErr } = await supabase
      .from('genre_config_v2')
      .select('genre_slug, genre_name, user_id, rss_feed_urls, source_urls, subreddit_names')
      .eq('genre_slug', body.genre_slug)
      .eq('active', true)
      .or(`user_id.is.null,user_id.eq.${encodeURIComponent(userId)}`)
      .maybeSingle();
    if (genreErr) {
      logger.error({ genreErr, userId, slug: body.genre_slug }, 'genre lookup failed during import');
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: genreErr.message } });
      return;
    }
    if (!genre) {
      res.status(404).json({ success: false, error: { code: 'GENRE_NOT_FOUND', message: `Genre "${body.genre_slug}" not visible` } });
      return;
    }

    type Row = {
      user_id: string; edition_id: string; name: string; url: string;
      url_type: 'rss' | 'reddit' | 'source' | 'firecrawl_scrape';
      fetch_interval_minutes: number; active: boolean;
    };
    const rows: Row[] = [];
    const seen = new Set<string>();
    function add(name: string, url: string, url_type: Row['url_type'], interval = 240) {
      const key = `${url_type}::${url.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ user_id: userId, edition_id: editionId, name, url, url_type, fetch_interval_minutes: interval, active: true });
    }
    for (const u of (genre.rss_feed_urls ?? []) as string[]) {
      if (typeof u !== 'string' || !u.trim()) continue;
      add(`${genre.genre_name} — RSS`, u.trim(), 'rss', 240);
    }
    for (const u of (genre.source_urls ?? []) as string[]) {
      if (typeof u !== 'string' || !u.trim()) continue;
      add(`${genre.genre_name} — source`, u.trim(), 'source', 240);
    }
    for (const sub of (genre.subreddit_names ?? []) as string[]) {
      if (typeof sub !== 'string' || !sub.trim()) continue;
      const cleaned = sub.trim().replace(/^r\//i, '');
      const redditUrl = `https://www.reddit.com/r/${cleaned}/.json`;
      add(`r/${cleaned}`, redditUrl, 'reddit', 180);
    }

    if (rows.length === 0) {
      res.json({ success: true, inserted: 0, skipped_duplicate: 0, genre: genre.genre_slug });
      return;
    }

    // Dedup against feeds already attached to this edition. We can't use a DB upsert with
    // onConflict here — newsletter_feed_sources_v2 has no unique constraint on (user_id, edition_id,
    // url), so ON CONFLICT errors out ("no unique or exclusion constraint matching"). Filter in code
    // instead: fetch existing URLs, insert only the genuinely new rows.
    const { data: existingRows, error: existErr } = await supabase
      .from('newsletter_feed_sources_v2')
      .select('url')
      .eq('edition_id', editionId);
    if (existErr) {
      logger.error({ existErr, userId, editionId }, 'import-from-genre existing-feeds lookup failed');
      res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: existErr.message } });
      return;
    }
    const existingUrls = new Set((existingRows ?? []).map((r) => String(r.url).toLowerCase()));
    const newRows = rows.filter((r) => !existingUrls.has(r.url.toLowerCase()));

    if (newRows.length === 0) {
      res.status(201).json({ success: true, genre: genre.genre_slug, inserted: 0, skipped_duplicate: rows.length });
      return;
    }

    const { data: inserted, error: insErr } = await supabase
      .from('newsletter_feed_sources_v2')
      .insert(newRows)
      .select('id');
    if (insErr) {
      logger.error({ insErr, userId, editionId, slug: body.genre_slug }, 'import-from-genre insert failed');
      res.status(500).json({ success: false, error: { code: 'DB_INSERT_FAILED', message: insErr.message } });
      return;
    }
    const newCount = (inserted ?? []).length;
    res.status(201).json({
      success: true,
      genre: genre.genre_slug,
      inserted: newCount,
      skipped_duplicate: rows.length - newCount,
    });
  },
);

// ---------------------------------------------------------------------------
// Cron worker callbacks (X-Ingestion-Secret guarded — no user JWT)
// ---------------------------------------------------------------------------

// GET /api/newsletter/cron/feeds/due — n8n cron worker fan-out source.
// Returns active feeds whose `(now() - last_fetched_at) >= fetch_interval_minutes`
// (or last_fetched_at IS NULL). Atomically stamps last_fetched_at = now()
// on the rows it returns so two overlapping cron ticks don't double-fetch.
feedsCronRouter.get('/feeds/due', requireIngestionSecret, async (req: Request, res: Response) => {
  const parsed = FeedsDueQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  const supabase = getSupabaseAdmin();

  // Two-step: (1) read candidates, (2) UPDATE the chosen rows with
  // last_fetched_at = now() to claim them. Worth using a Postgres function
  // when scale demands SKIP LOCKED; for now a service-role round-trip is
  // sufficient because /feeds/due is gated by the cron's own ingestion
  // secret and runs serially.
  const { data: candidates, error: e1 } = await supabase
    .from('newsletter_feed_sources_v2')
    .select(FEED_COLUMNS)
    .eq('active', true)
    .order('last_fetched_at', { ascending: true, nullsFirst: true })
    .limit(parsed.data.limit);

  if (e1) {
    logger.error({ error: e1 }, 'feeds/due query failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: e1.message } });
    return;
  }

  const now = Date.now();
  const due = (candidates ?? []).filter((row) => {
    if (!row.last_fetched_at) return true;
    const last = new Date(row.last_fetched_at as string).getTime();
    return now - last >= row.fetch_interval_minutes * 60 * 1000;
  });

  if (due.length === 0) {
    res.json({ success: true, feeds: [] });
    return;
  }

  // Claim them.
  const ids = due.map((r) => r.id as string);
  const stamp = new Date().toISOString();
  const { error: e2 } = await supabase
    .from('newsletter_feed_sources_v2')
    .update({ last_fetched_at: stamp })
    .in('id', ids);
  if (e2) {
    logger.error({ error: e2 }, 'feeds/due claim failed');
    res.status(500).json({ success: false, error: { code: 'DB_UPDATE_FAILED', message: e2.message } });
    return;
  }

  res.json({ success: true, feeds: due });
});

// POST /api/newsletter/cron/feeds/:id/runs — n8n posts the outcome of one
// fetch. Always writes a runs row; updates last_item_count + last_error
// on the feed row.
feedsCronRouter.post(
  '/feeds/:id/runs',
  requireIngestionSecret,
  validateBody(FeedRunCallbackSchema),
  async (req: Request, res: Response) => {
    const params = FeedIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
      return;
    }
    const body = req.body as import('zod').infer<typeof FeedRunCallbackSchema>;
    const supabase = getSupabaseAdmin();

    const { data: feed, error: lookupErr } = await supabase
      .from('newsletter_feed_sources_v2')
      .select('id, user_id, edition_id')
      .eq('id', params.data.id)
      .maybeSingle();
    if (lookupErr || !feed) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Feed not found' } });
      return;
    }

    const finishedAt = new Date().toISOString();
    const errorMessage = body.error_message ?? null;

    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('newsletter_ingestion_runs_v2').insert({
        feed_source_id: feed.id,
        user_id: feed.user_id,
        edition_id: feed.edition_id,
        finished_at: finishedAt,
        items_fetched: body.items_fetched ?? null,
        items_uploaded: body.items_uploaded ?? null,
        items_skipped_existing: body.items_skipped_existing ?? null,
        error_message: errorMessage,
      }),
      supabase
        .from('newsletter_feed_sources_v2')
        .update({
          last_item_count: body.items_uploaded ?? body.items_fetched ?? null,
          last_error: errorMessage,
        })
        .eq('id', feed.id),
    ]);

    if (e1) logger.error({ error: e1, feedId: feed.id }, 'ingestion_runs insert failed');
    if (e2) logger.error({ error: e2, feedId: feed.id }, 'feed last_* update failed');
    if (e1 || e2) {
      res.status(500).json({ success: false, error: { code: 'DB_WRITE_FAILED', message: (e1 ?? e2)!.message } });
      return;
    }
    res.json({ success: true });
  },
);
