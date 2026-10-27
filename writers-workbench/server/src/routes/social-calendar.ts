/**
 * The post calendar and the radars (port of the n8n blog / LinkedIn posting system, migration 038).
 *
 *   GET    /api/social/channels                    the caller's channels (website, LinkedIn pages)
 *   GET    /api/social/calendar?from&to            posts in a date range, with each channel's delivery
 *   GET    /api/social/posts/:id                   one post
 *   POST   /api/social/posts                       schedule a post
 *   PATCH  /api/social/posts/:id                   edit a post that has not gone out
 *   POST   /api/social/posts/:id/cancel            take it off the calendar (kept, state=cancelled)
 *   POST   /api/social/posts/:id/requeue           put a failed / partial / cancelled post back on
 *   GET    /api/social/radar/:radar                the latest slate (trend | dev), its run, what is queued
 *   POST   /api/social/radar/:radar/run            build this week's slate now        (engine job)
 *   POST   /api/social/radar/:radar/schedule       draft topics and put them on the calendar (engine job)
 *
 * Posting itself is the engine's (writer_engine.social.poster, every five minutes). Nothing here
 * talks to the website or to LinkedIn. A row's `#N` and its posting time (09:00 / 14:00 US Eastern)
 * are set by the database trigger in migration 038.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool } from '../lib/engine-hub.js';
import { getCreditCost } from '../services/credit-costs.js';
import { deductCredits } from '../services/credits.js';
import { logger } from '../lib/logger.js';

export const socialCalendarRouter = Router();
socialCalendarRouter.use(requireAuth);

const POST_COLUMNS =
  'id, display_number, external_id, title, body_md, linkedin_content, seo_title, meta_description, category, ' +
  'include_image, post_status, channels, scheduled_date, slot, scheduled_at, state, attempts, posted_at, last_error, ' +
  'source, item_type, source_url, radar_topic_id, created_at, updated_at';
const DELIVERY_COLUMNS = 'schedule_id, channel, status, attempts, public_url, detail, updated_at';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-mm-dd');
const CHANNEL = z.string().regex(/^[a-z0-9_]{2,40}$/);
const EDITABLE = new Set(['pending', 'failed', 'partial', 'cancelled']);

/** What `#N` is built from when a post is made by hand: sched-<date>-<slot>-<slug>, like the n8n queue. */
export function externalIdFor(title: string, date: string, slot: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'post';
  return `sched-${date}-${slot}-${slug}-${Date.now().toString(36)}`;
}

const PostFields = {
  title: z.string().trim().min(1).max(500),
  body_md: z.string().max(100_000).optional(),
  linkedin_content: z.string().max(3000).optional(),
  seo_title: z.string().max(120).optional(),
  meta_description: z.string().max(300).optional(),
  category: z.string().max(60).optional(),
  include_image: z.boolean().optional(),
  post_status: z.enum(['published', 'draft']).optional(),
  channels: z.array(CHANNEL).min(1).max(10),
  scheduled_date: DATE,
  slot: z.enum(['morning', 'afternoon']),
  source_url: z.string().url().max(2000).optional().nullable(),
};

export const CreatePostSchema = z
  .object(PostFields)
  .refine((p) => (p.body_md ?? '').trim() || (p.linkedin_content ?? '').trim(), {
    message: 'A post needs a blog body or LinkedIn text',
    path: ['body_md'],
  });
export const UpdatePostSchema = z.object(PostFields).partial();

function bad(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

async function channelKeys(userId: string): Promise<Set<string>> {
  const { data } = await getSupabaseAdmin()
    .from('social_channels_v2')
    .select('channel, enabled')
    .eq('user_id', userId);
  return new Set((data ?? []).filter((c) => c.enabled).map((c) => String(c.channel)));
}

async function unknownChannels(userId: string, channels: string[]): Promise<string[]> {
  const known = await channelKeys(userId);
  return channels.filter((c) => !known.has(c));
}

async function withDeliveries(posts: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  if (!posts.length) return posts;
  const { data } = await getSupabaseAdmin()
    .from('social_schedule_deliveries_v2')
    .select(DELIVERY_COLUMNS)
    .in('schedule_id', posts.map((p) => String(p.id)));
  const byPost = new Map<string, unknown[]>();
  for (const d of data ?? []) {
    const list = byPost.get(String(d.schedule_id)) ?? [];
    list.push(d);
    byPost.set(String(d.schedule_id), list);
  }
  return posts.map((p) => ({ ...p, deliveries: byPost.get(String(p.id)) ?? [] }));
}

async function ownPost(userId: string, id: string): Promise<Record<string, unknown> | null> {
  const { data } = await getSupabaseAdmin()
    .from('social_schedule_v2')
    .select(POST_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

socialCalendarRouter.get('/channels', async (req: Request, res: Response) => {
  const { data, error } = await getSupabaseAdmin()
    .from('social_channels_v2')
    .select('channel, kind, label, enabled')
    .eq('user_id', req.userId!)
    .order('channel');
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: data ?? [] });
});

socialCalendarRouter.get('/calendar', async (req: Request, res: Response) => {
  const from = DATE.safeParse(req.query.from);
  const to = DATE.safeParse(req.query.to);
  if (!from.success || !to.success) return bad(res, 400, 'VALIDATION_ERROR', 'from and to must be yyyy-mm-dd');
  const days = (Date.parse(to.data) - Date.parse(from.data)) / 86_400_000;
  if (days < 0 || days > 62) return bad(res, 400, 'VALIDATION_ERROR', 'The range is at most 62 days');
  const { data, error } = await getSupabaseAdmin()
    .from('social_schedule_v2')
    .select(POST_COLUMNS)
    .eq('user_id', req.userId!)
    .gte('scheduled_date', from.data)
    .lte('scheduled_date', to.data)
    .order('scheduled_at')
    .limit(500);
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: await withDeliveries((data ?? []) as unknown as Array<Record<string, unknown>>) });
});

socialCalendarRouter.get('/posts/:id', async (req: Request, res: Response) => {
  const post = await ownPost(req.userId!, String(req.params.id));
  if (!post) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  res.json({ success: true, data: (await withDeliveries([post]))[0] });
});

socialCalendarRouter.post('/posts', validateBody(CreatePostSchema), async (req: Request, res: Response) => {
  const userId = req.userId!;
  const body = req.body as z.infer<typeof CreatePostSchema>;
  const unknown = await unknownChannels(userId, body.channels);
  if (unknown.length) return bad(res, 400, 'UNKNOWN_CHANNEL', `Not one of your channels: ${unknown.join(', ')}`);
  const row = {
    user_id: userId,
    external_id: externalIdFor(body.title, body.scheduled_date, body.slot),
    title: body.title,
    body_md: body.body_md ?? '',
    linkedin_content: body.linkedin_content ?? '',
    seo_title: body.seo_title || body.title.slice(0, 120),
    meta_description: body.meta_description ?? '',
    category: (body.category || 'INSIGHTS').toUpperCase(),
    include_image: body.include_image ?? false,
    post_status: body.post_status ?? 'published',
    channels: body.channels,
    scheduled_date: body.scheduled_date,
    slot: body.slot,
    source: 'manual',
    item_type: (body.body_md ?? '').trim() ? 'blog' : 'article',
    source_url: body.source_url ?? null,
  };
  const { data, error } = await getSupabaseAdmin().from('social_schedule_v2').insert(row).select(POST_COLUMNS).single();
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  logger.info({ userId, id: (data as unknown as { id: string }).id }, 'social post scheduled');
  res.status(201).json({ success: true, data: { ...(data as object), deliveries: [] } });
});

socialCalendarRouter.patch('/posts/:id', validateBody(UpdatePostSchema), async (req: Request, res: Response) => {
  const userId = req.userId!;
  const post = await ownPost(userId, String(req.params.id));
  if (!post) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  if (!EDITABLE.has(String(post.state))) {
    return bad(res, 409, 'ALREADY_POSTED', `A ${post.state} post cannot be edited`);
  }
  const patch = req.body as z.infer<typeof UpdatePostSchema>;
  if (patch.channels) {
    const unknown = await unknownChannels(userId, patch.channels);
    if (unknown.length) return bad(res, 400, 'UNKNOWN_CHANNEL', `Not one of your channels: ${unknown.join(', ')}`);
  }
  if (patch.category) patch.category = patch.category.toUpperCase();
  const { data, error } = await getSupabaseAdmin()
    .from('social_schedule_v2')
    .update(patch)
    .eq('id', String(post.id))
    .eq('user_id', userId)
    .select(POST_COLUMNS)
    .single();
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: (await withDeliveries([data as unknown as Record<string, unknown>]))[0] });
});

async function transition(req: Request, res: Response, from: string[], patch: Record<string, unknown>): Promise<void> {
  const userId = req.userId!;
  const post = await ownPost(userId, String(req.params.id));
  if (!post) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  if (!from.includes(String(post.state))) return bad(res, 409, 'WRONG_STATE', `The post is ${post.state}`);
  const { data, error } = await getSupabaseAdmin()
    .from('social_schedule_v2')
    .update(patch)
    .eq('id', String(post.id))
    .eq('user_id', userId)
    .eq('state', String(post.state))
    .select(POST_COLUMNS)
    .maybeSingle();
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  if (!data) return bad(res, 409, 'WRONG_STATE', 'The post changed while you were looking at it; reload');
  res.json({ success: true, data: (await withDeliveries([data as unknown as Record<string, unknown>]))[0] });
}

socialCalendarRouter.post('/posts/:id/cancel', (req, res) =>
  transition(req, res, ['pending', 'failed', 'partial'], { state: 'cancelled' }),
);

// Back to pending with a fresh retry budget. The deliveries that already worked are kept, so only
// the channels that failed are sent again (the publisher skips ok channels).
socialCalendarRouter.post('/posts/:id/requeue', (req, res) =>
  transition(req, res, ['failed', 'partial', 'cancelled'], { state: 'pending', attempts: 0, last_error: null }),
);

const RADARS = new Set(['trend', 'dev']);

socialCalendarRouter.get('/radar/:radar', async (req: Request, res: Response) => {
  const radar = String(req.params.radar);
  if (!RADARS.has(radar)) return bad(res, 404, 'NOT_FOUND', 'No such radar');
  const userId = req.userId!;
  const sb = getSupabaseAdmin();
  const [{ data: sub }, { data: runs }] = await Promise.all([
    sb.from('radar_subscriptions_v2').select('enabled, settings').eq('user_id', userId).eq('radar', radar).maybeSingle(),
    sb.from('radar_runs_v2').select('week_of, status, stats, error, started_at, finished_at')
      .eq('user_id', userId).eq('radar', radar).order('week_of', { ascending: false }).limit(1),
  ]);
  const latest = runs?.[0] ?? null;
  const { data: weekRow } = await sb.from('radar_topics_v2').select('week_of')
    .eq('user_id', userId).eq('radar', radar).order('week_of', { ascending: false }).limit(1);
  const week = weekRow?.[0]?.week_of ?? null;
  let topics: Array<Record<string, unknown>> = [];
  if (week) {
    const { data } = await sb.from('radar_topics_v2')
      .select('id, rank, title, url, source, item_type, angle, category, driver_type, client_relevance, score, summary, also_covered_by, week_of')
      .eq('user_id', userId).eq('radar', radar).eq('week_of', week).order('rank');
    topics = (data ?? []) as Array<Record<string, unknown>>;
  }
  const queued: Record<string, { display_number: number; state: string; scheduled_date: string; slot: string }> = {};
  if (topics.length) {
    const { data } = await sb.from('social_schedule_v2').select('radar_topic_id, display_number, state, scheduled_date, slot')
      .eq('user_id', userId).in('radar_topic_id', topics.map((t) => String(t.id)));
    for (const r of data ?? []) {
      if (r.radar_topic_id) queued[String(r.radar_topic_id)] = r as never;
    }
  }
  res.json({
    success: true,
    data: { radar, subscribed: Boolean(sub?.enabled), week_of: week, run: latest, topics, queued },
  });
});

const RunSchema = z.object({ force: z.boolean().optional() });
const ScheduleSchema = z.object({
  numbers: z.union([z.string().max(200), z.array(z.number().int().min(1).max(50)).max(50)]),
  channels: z.array(CHANNEL).min(1).max(10).optional(),
});

socialCalendarRouter.post('/radar/:radar/run', validateBody(RunSchema), async (req: Request, res: Response) => {
  const radar = String(req.params.radar);
  if (!RADARS.has(radar)) return bad(res, 404, 'NOT_FOUND', 'No such radar');
  try {
    const job = await callEngineWriteTool('ingestion', {
      op: 'radar', radar, user_id: req.userId!, force: Boolean((req.body as z.infer<typeof RunSchema>).force), async: true,
    });
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Engine error');
  }
});

socialCalendarRouter.post('/radar/:radar/schedule', validateBody(ScheduleSchema), async (req: Request, res: Response) => {
  const radar = String(req.params.radar);
  if (!RADARS.has(radar)) return bad(res, 404, 'NOT_FOUND', 'No such radar');
  const userId = req.userId!;
  const body = req.body as z.infer<typeof ScheduleSchema>;
  if (body.channels) {
    const unknown = await unknownChannels(userId, body.channels);
    if (unknown.length) return bad(res, 400, 'UNKNOWN_CHANNEL', `Not one of your channels: ${unknown.join(', ')}`);
  }
  // Every drafted topic is one LLM writing job, charged like a social repurpose.
  const count = Array.isArray(body.numbers) ? body.numbers.length : countSelection(body.numbers);
  const privileged = req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
  const hasSubscription = req.subscriptionTier !== null && req.subscriptionTier !== undefined;
  const cost = (await getCreditCost('social_repurpose')) * count;
  if (!privileged && cost > 0 && hasSubscription && (req.creditsRemaining ?? 0) < cost) {
    return bad(res, 402, 'INSUFFICIENT_CREDITS', `This needs ${cost} credits.`);
  }
  try {
    const job = await callEngineWriteTool('ingestion', {
      op: 'radar_schedule', radar, user_id: userId, numbers: body.numbers,
      ...(body.channels ? { channels: body.channels } : {}), async: true,
    });
    if (!privileged && cost > 0 && hasSubscription) await deductCredits(userId, cost, `social.radar:${radar}`);
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Engine error');
  }
});

/** How many topics "1-3, 8" or "all" names, for the credit check. "all" counts as a full slate. */
export function countSelection(spec: string): number {
  const text = spec.trim().toLowerCase();
  if (!text || text === 'all') return 24;
  const seen = new Set<number>();
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n <= 50; n++) seen.add(n);
    } else if (/^\d+$/.test(part.trim())) {
      seen.add(Number(part.trim()));
    }
  }
  return seen.size;
}
