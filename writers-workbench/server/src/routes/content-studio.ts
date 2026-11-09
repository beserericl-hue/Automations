/**
 * The Content Studio (migration 050) — the newsletter admin's page for an edition fed by a radar:
 * the week's slate, drafts in review, the publish decision, the queue, the next issue's stories, the
 * assistant and the public RSS feeds. Port of the n8n studio chat agents (fTRYiQOaQgdAmu7w,
 * y0vIznzMeiGoxouX) and their tools.
 *
 *   GET    /api/studio/editions                       the caller's studio editions
 *   GET    /api/studio/:ed                            edition, radar, the caller's channels, slate weeks
 *   GET    /api/studio/:ed/slate?week=yyyy-mm-dd      ranked topics + the post each became
 *   POST   /api/studio/:ed/radar/run                  build this week's slate now           (engine job)
 *   GET    /api/studio/:ed/posts?status=…             drafts | approved | queue | published | all
 *   POST   /api/studio/:ed/generate                   draft topics into review               (engine job, charged)
 *   PATCH  /api/studio/:ed/posts/:id                  inline edit
 *   POST   /api/studio/:ed/posts/:id/revise           revise with an instruction             (engine job, charged)
 *   POST   /api/studio/:ed/posts/:id/regenerate       redraft from its topic                 (engine job, charged)
 *   POST   /api/studio/:ed/posts/:id/image           make its sketchnote now, to see before approving (engine job, charged)
 *   POST   /api/studio/:ed/posts/:id/undo             back to the version before the last revise
 *   POST   /api/studio/:ed/posts/:id/email            email the draft to the caller
 *   POST   /api/studio/:ed/posts/actions              approve / unapprove / discard / cancel / requeue / unschedule / image_on / image_off
 *   POST   /api/studio/:ed/posts/schedule             next free slots | a day + slot | an exact time | now
 *   POST   /api/studio/:ed/digest/email               email the week's slate to the caller
 *   GET    /api/studio/:ed/digest/emails              the record of those emails (migration 052)
 *   GET    /api/studio/:ed/issue                      the next issue's chosen stories
 *   PUT    /api/studio/:ed/issue                      choose them (ordered)
 *   POST   /api/studio/:ed/issue/new                  start a fresh selection
 *   POST   /api/studio/:ed/assistant                  the assistant (engine hub, studio surface)
 *   GET    /api/studio/:ed/feeds                      the edition's public RSS URLs (made on first read)
 *   POST   /api/studio/:ed/feeds/rotate               new token (the old URLs stop working)
 *
 * Ownership: every route resolves `:ed` as one of the caller's own studio editions first and answers
 * 404 otherwise (lib/studio.ts); the engine checks it again on every op. Generating the issue itself
 * uses the existing POST /api/newsletter/generate (the saga takes the chosen stories).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineHub, callEngineWriteTool, engineErrorMessage, type EngineStepEnvelope } from '../lib/engine-hub.js';
import { getCreditCost } from '../services/credit-costs.js';
import { deductCredits } from '../services/credits.js';
import { findOwnedEdition, findStudioEdition, studioEditions, type StudioEdition } from '../lib/studio.js';
import { countSelection } from './social-calendar.js';
import { logger } from '../lib/logger.js';

export const contentStudioRouter = Router();
contentStudioRouter.use(requireAuth);

const POST_COLUMNS =
  'id, display_number, external_id, title, body_md, linkedin_content, seo_title, meta_description, category, ' +
  'include_image, image_url, post_status, channels, scheduled_date, slot, scheduled_at, post_at, state, attempts, ' +
  'posted_at, last_error, source, item_type, source_url, radar_topic_id, edition_id, humanize, studio, created_at, updated_at';

const STATUS_STATES: Record<string, string[] | null> = {
  drafts: ['draft'],
  approved: ['approved'],
  review: ['draft', 'approved'],
  queue: ['pending', 'posting', 'failed', 'partial'],
  published: ['posted', 'partial'],
  all: null,
};

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-mm-dd');
const UUID = z.string().uuid();
const CHANNEL = z.string().regex(/^[a-z0-9_]{2,40}$/);

function bad(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

const CODE_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNKNOWN_CHANNEL: 400,
  CONFLICT: 409,
  ALREADY_POSTED: 409,
  NOTHING_TO_UNDO: 409,
  NO_TOPIC: 409,
  NO_RECIPIENT: 409,
};

/** Load the caller's studio edition or answer 404. */
async function edition(req: Request, res: Response): Promise<StudioEdition | null> {
  const ed = await findStudioEdition(req.userId!, String(req.params.ed));
  if (!ed) bad(res, 404, 'NOT_FOUND', 'No such studio edition');
  return ed;
}

function privileged(req: Request): boolean {
  return req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
}

function chargeable(req: Request): boolean {
  return !privileged(req) && req.subscriptionTier !== null && req.subscriptionTier !== undefined;
}

/** A synchronous studio op. Answers the response itself on an engine refusal; returns the op's result otherwise. */
async function studioSync(
  req: Request,
  res: Response,
  ed: StudioEdition,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  let env: EngineStepEnvelope<Record<string, unknown>>;
  try {
    env = (await callEngineWriteTool('studio', {
      ...body, user_id: req.userId!, edition_id: ed.edition_id, async: false,
    })) as EngineStepEnvelope<Record<string, unknown>>;
  } catch (err) {
    bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Engine error');
    return null;
  }
  if (env.error) {
    const code = typeof env.error === 'object' && env.error?.code ? env.error.code : 'ENGINE_ERROR';
    bad(res, CODE_STATUS[code] ?? 422, code, engineErrorMessage(env.error));
    return null;
  }
  return env.payload?.result ?? {};
}

/** A queued studio op (LLM work). Charges `units` × the social-repurpose price after it is queued. */
async function studioJob(
  req: Request,
  res: Response,
  ed: StudioEdition,
  body: Record<string, unknown>,
  units: number,
  label: string,
): Promise<void> {
  const cost = (await getCreditCost('social_repurpose')) * units;
  if (chargeable(req) && cost > 0 && (req.creditsRemaining ?? 0) < cost) {
    return bad(res, 402, 'INSUFFICIENT_CREDITS', `This needs ${cost} credits.`);
  }
  try {
    const job = await callEngineWriteTool('studio', { ...body, user_id: req.userId!, edition_id: ed.edition_id, async: true });
    if (chargeable(req) && cost > 0) await deductCredits(req.userId!, cost, `studio.${label}:${ed.edition_id}`);
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued', creditsCharged: chargeable(req) ? cost : 0 });
  } catch (err) {
    bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Engine error');
  }
}

async function withDeliveries(posts: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  if (!posts.length) return posts;
  const { data } = await getSupabaseAdmin()
    .from('social_schedule_deliveries_v2')
    .select('schedule_id, channel, status, public_url, detail, updated_at')
    .in('schedule_id', posts.map((p) => String(p.id)));
  const by = new Map<string, unknown[]>();
  for (const d of (data ?? []) as Array<Record<string, unknown>>) {
    const list = by.get(String(d.schedule_id)) ?? [];
    list.push(d);
    by.set(String(d.schedule_id), list);
  }
  return posts.map((p) => ({ ...p, deliveries: by.get(String(p.id)) ?? [] }));
}

// ---------------------------------------------------------------------------- reads

contentStudioRouter.get('/editions', async (req: Request, res: Response) => {
  res.json({ success: true, data: await studioEditions(req.userId!) });
});

// ---------------------------------------------------------------------------- the library

/** Every radar post and recent slate topic of the caller, across all their editions and radars: what
 *  can be featured in ANY of their newsletters (Eric, 2026-11-05). Posts: approved, scheduled, posted. */
contentStudioRouter.get('/library', async (req: Request, res: Response) => {
  const sb = getSupabaseAdmin();
  const [{ data: posts, error }, { data: topics }] = await Promise.all([
    sb.from('social_schedule_v2')
      .select('id, display_number, title, state, source_url, item_type, edition_id, scheduled_date, posted_at, radar_topic_id, source')
      .eq('user_id', req.userId!).in('state', ['approved', 'pending', 'posting', 'posted', 'partial'])
      .order('display_number', { ascending: false }).limit(150),
    sb.from('radar_topics_v2').select('id, radar, week_of, rank, title, url, item_type, source')
      .eq('user_id', req.userId!).order('week_of', { ascending: false }).order('rank').limit(120),
  ]);
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: { posts: posts ?? [], topics: topics ?? [] } });
});

contentStudioRouter.get('/:ed', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const sb = getSupabaseAdmin();
  const [{ data: channels }, { data: weeks }, { data: runs }] = await Promise.all([
    sb.from('social_channels_v2').select('channel, kind, label, enabled').eq('user_id', req.userId!).order('channel'),
    sb.from('radar_topics_v2').select('week_of').eq('user_id', req.userId!).eq('radar', ed.radar)
      .order('week_of', { ascending: false }).limit(600),
    sb.from('radar_runs_v2').select('week_of, status, stats, error, started_at, finished_at')
      .eq('user_id', req.userId!).eq('radar', ed.radar).order('week_of', { ascending: false }).limit(1),
  ]);
  const weekList = [...new Set(((weeks ?? []) as Array<{ week_of: string }>).map((w) => String(w.week_of).slice(0, 10)))].slice(0, 12);
  res.json({
    success: true,
    data: {
      edition: ed,
      channels: ((channels ?? []) as Array<Record<string, unknown>>).filter((c) => c.enabled !== false),
      weeks: weekList,
      run: runs?.[0] ?? null,
    },
  });
});

contentStudioRouter.get('/:ed/slate', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const sb = getSupabaseAdmin();
  let week = typeof req.query.week === 'string' && DATE.safeParse(req.query.week).success ? req.query.week : null;
  if (!week) {
    const { data } = await sb.from('radar_topics_v2').select('week_of').eq('user_id', req.userId!).eq('radar', ed.radar)
      .order('week_of', { ascending: false }).limit(1);
    week = data?.[0]?.week_of ? String(data[0].week_of).slice(0, 10) : null;
  }
  if (!week) return res.json({ success: true, data: { radar: ed.radar, week_of: null, topics: [] } });
  const { data: topics, error } = await sb.from('radar_topics_v2')
    .select('id, rank, title, url, source, item_type, angle, category, score, summary, also_covered_by, week_of')
    .eq('user_id', req.userId!).eq('radar', ed.radar).eq('week_of', week).order('rank');
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  const list = (topics ?? []) as Array<Record<string, unknown>>;
  const posts: Record<string, Record<string, unknown>> = {};
  if (list.length) {
    const { data } = await sb.from('social_schedule_v2')
      .select('id, display_number, state, scheduled_date, slot, radar_topic_id, edition_id')
      .eq('user_id', req.userId!).in('radar_topic_id', list.map((t) => String(t.id)));
    for (const p of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(p.radar_topic_id);
      if (p.state === 'cancelled' && posts[key]) continue;
      posts[key] = p;
    }
  }
  res.json({ success: true, data: { radar: ed.radar, week_of: week, topics: list.map((t) => ({ ...t, post: posts[String(t.id)] ?? null })) } });
});

contentStudioRouter.get('/:ed/posts', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const status = String(req.query.status ?? 'review');
  if (!(status in STATUS_STATES)) return bad(res, 400, 'VALIDATION_ERROR', `status is one of ${Object.keys(STATUS_STATES).join(', ')}`);
  let q = getSupabaseAdmin().from('social_schedule_v2').select(POST_COLUMNS)
    .eq('user_id', req.userId!).eq('edition_id', ed.edition_id);
  const states = STATUS_STATES[status];
  if (states) q = q.in('state', states);
  const { data, error } = await q.order('display_number', { ascending: false }).limit(200);
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  res.json({ success: true, data: await withDeliveries((data ?? []) as unknown as Array<Record<string, unknown>>) });
});

// ---------------------------------------------------------------------------- history (every week)

/** What became of a topic: the bucket the History tab groups by. */
export function historyBucket(post: Record<string, unknown> | null): string {
  if (!post) return 'not_drafted';
  const state = String(post.state ?? '');
  if (state === 'cancelled') return (post.studio as Record<string, unknown> | null)?.discarded_at ? 'discarded' : 'cancelled';
  if (state === 'draft' || state === 'approved') return 'drafted';
  if (state === 'pending' || state === 'posting') return 'scheduled';
  if (state === 'posted' || state === 'partial') return 'published';
  return state; // failed
}

/** Every slate week of this radar with what each topic became, newest first (Eric, 2026-11-05: "the
 *  history of all the posts not generated or scheduled from week to week"). The Slate tab shows one
 *  week; this is all of them, bucketed, so an ungenerated topic from October can still be drafted. */
contentStudioRouter.get('/:ed/history', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const sb = getSupabaseAdmin();
  const { data: topics, error } = await sb.from('radar_topics_v2')
    .select('id, rank, title, url, source, item_type, angle, week_of')
    .eq('user_id', req.userId!).eq('radar', ed.radar).order('week_of', { ascending: false }).order('rank').limit(2000);
  if (error) return bad(res, 500, 'DB_ERROR', error.message);
  const list = (topics ?? []) as Array<Record<string, unknown>>;
  const posts: Record<string, Record<string, unknown>> = {};
  if (list.length) {
    const { data } = await sb.from('social_schedule_v2')
      .select('id, display_number, state, scheduled_date, slot, post_at, posted_at, radar_topic_id, edition_id, studio')
      .eq('user_id', req.userId!).in('radar_topic_id', list.map((t) => String(t.id)));
    for (const p of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(p.radar_topic_id);
      if (p.state === 'cancelled' && posts[key]) continue; // a live post beats a discarded one for the same topic
      posts[key] = p;
    }
  }
  const weeks: Array<{ week_of: string; topics: Array<Record<string, unknown>>; counts: Record<string, number> }> = [];
  const totals: Record<string, number> = {};
  for (const t of list) {
    const week = String(t.week_of).slice(0, 10);
    let w = weeks[weeks.length - 1];
    if (!w || w.week_of !== week) {
      w = { week_of: week, topics: [], counts: {} };
      weeks.push(w);
    }
    const post = posts[String(t.id)] ?? null;
    const bucket = historyBucket(post);
    w.topics.push({ ...t, post, bucket });
    w.counts[bucket] = (w.counts[bucket] ?? 0) + 1;
    totals[bucket] = (totals[bucket] ?? 0) + 1;
  }
  res.json({ success: true, data: { radar: ed.radar, weeks, totals } });
});

// ---------------------------------------------------------------------------- your own topic

const OwnTopicSchema = z.object({
  title: z.string().trim().min(3).max(300),
  url: z.string().trim().url().max(2000).optional().or(z.literal('')),
  angle: z.string().trim().max(2000).optional(),
});

/** The Monday (Eastern) of the week a topic added now belongs to — the engine's radar.run.week_of. */
export function currentWeekOf(now = new Date()): string {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0 = Sunday
  const monday = new Date(et);
  monday.setDate(et.getDate() + (day === 0 ? 1 : 1 - day));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

/** Put the owner's own topic on this week's slate (the n8n studio's "paste your own topic"). It takes
 *  the next rank, so "generate 25" and the History tab treat it like any radar topic. */
async function addOwnTopic(userId: string, ed: StudioEdition, body: z.infer<typeof OwnTopicSchema>): Promise<Record<string, unknown>> {
  const sb = getSupabaseAdmin();
  const week = currentWeekOf();
  const { data: existing } = await sb.from('radar_topics_v2').select('rank').eq('user_id', userId).eq('radar', ed.radar).eq('week_of', week);
  const rank = Math.max(0, ...((existing ?? []) as Array<{ rank: number }>).map((r) => Number(r.rank))) + 1;
  if (rank > 50) throw new Error('This week\'s slate is full (50 topics)');
  const url = body.url || '';
  const row = {
    id: randomUUID(), user_id: userId, radar: ed.radar, week_of: week, rank,
    title: body.title, url: url || `own://${userId}/${week}/${rank}`, source: 'you', item_type: url.includes('youtube.com') || url.includes('youtu.be') ? 'video' : 'article',
    angle: body.angle ?? '', summary: '',
  };
  const { error } = await sb.from('radar_topics_v2').insert(row);
  if (error) throw new Error(error.message);
  return row;
}

contentStudioRouter.post('/:ed/topics', validateBody(OwnTopicSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  try {
    const topic = await addOwnTopic(req.userId!, ed, req.body as z.infer<typeof OwnTopicSchema>);
    res.status(201).json({ success: true, data: topic });
  } catch (err) {
    bad(res, 500, 'DB_ERROR', err instanceof Error ? err.message : 'Could not add the topic');
  }
});

/** "write about <topic or URL>" / "draft about …" / a bare URL: the assistant's own-topic command. */
export function ownTopicCommand(message: string): { title: string; url?: string } | null {
  const m = message.trim().match(/^(?:write|draft|post|blog)\s+(?:about|on|from)\s*:?\s+(.+)$/i) ?? message.trim().match(/^(https?:\/\/\S+)$/i);
  if (!m) return null;
  const text = m[1].trim().replace(/^["“]|["”]$/g, '');
  const url = text.match(/https?:\/\/\S+/)?.[0];
  const title = url ? text.replace(url, '').replace(/[\s:—-]+$/g, '').trim() || url.replace(/^https?:\/\//, '').slice(0, 120) : text;
  return { title: title.slice(0, 300), ...(url ? { url } : {}) };
}

// ---------------------------------------------------------------------------- radar + drafting

contentStudioRouter.post('/:ed/radar/run', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  try {
    const job = await callEngineWriteTool('ingestion', { op: 'radar', radar: ed.radar, user_id: req.userId!, force: true, async: true });
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Engine error');
  }
});

export const GenerateSchema = z.object({
  numbers: z.string().max(200).optional(),
  topic_ids: z.array(UUID).min(1).max(30).optional(),
  week_of: DATE.optional(),
  redo: z.boolean().optional(),
}).refine((b) => Boolean(b.numbers?.trim()) || Boolean(b.topic_ids?.length), { message: 'Choose topics', path: ['topic_ids'] });

contentStudioRouter.post('/:ed/generate', validateBody(GenerateSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const body = req.body as z.infer<typeof GenerateSchema>;
  const units = body.topic_ids?.length ?? countSelection(body.numbers ?? '');
  await studioJob(req, res, ed, {
    op: 'generate',
    ...(body.topic_ids ? { topic_ids: body.topic_ids } : { numbers: body.numbers }),
    ...(body.week_of ? { week_of: body.week_of } : {}),
    ...(body.redo ? { redo: true } : {}),
  }, units, 'generate');
});

export const EditSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  body_md: z.string().max(100_000).optional(),
  linkedin_content: z.string().max(3000).optional(),
  seo_title: z.string().max(120).optional(),
  meta_description: z.string().max(300).optional(),
  category: z.string().max(60).optional(),
  include_image: z.boolean().optional(),
  image_url: z.string().url().startsWith('https://').max(2000).nullable().optional(),
  channels: z.array(CHANNEL).min(1).max(10).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

contentStudioRouter.patch('/:ed/posts/:id', validateBody(EditSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  const out = await studioSync(req, res, ed, { op: 'update', action: 'edit', post_ids: [String(req.params.id)], changes: req.body });
  if (out) res.json({ success: true, data: out });
});

const ReviseSchema = z.object({ instruction: z.string().trim().min(2).max(1000) });

contentStudioRouter.post('/:ed/posts/:id/revise', validateBody(ReviseSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  await studioJob(req, res, ed, {
    op: 'revise', mode: 'revise', post_ids: [String(req.params.id)], instruction: (req.body as { instruction: string }).instruction,
  }, 1, 'revise');
});

contentStudioRouter.post('/:ed/posts/:id/regenerate', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  await studioJob(req, res, ed, { op: 'revise', mode: 'regenerate', post_ids: [String(req.params.id)] }, 1, 'regenerate');
});

contentStudioRouter.post('/:ed/posts/:id/image', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  await studioJob(req, res, ed, { op: 'revise', mode: 'image', post_ids: [String(req.params.id)] }, 1, 'image');
});

contentStudioRouter.post('/:ed/posts/:id/undo', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  const out = await studioSync(req, res, ed, { op: 'revise', mode: 'undo', post_ids: [String(req.params.id)] });
  if (out) res.json({ success: true, data: out });
});

contentStudioRouter.post('/:ed/posts/:id/email', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  if (!UUID.safeParse(req.params.id).success) return bad(res, 404, 'NOT_FOUND', 'Post not found');
  const out = await studioSync(req, res, ed, { op: 'email', post_ids: [String(req.params.id)] });
  if (out) res.json({ success: true, data: out });
});

const DigestSchema = z.object({ week_of: DATE.optional() });

contentStudioRouter.post('/:ed/digest/email', validateBody(DigestSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const out = await studioSync(req, res, ed, { op: 'email', target: 'digest', ...(req.body as object) });
  if (out) res.json({ success: true, data: out });
});

// The record of each "Email me the week's slate" (migration 052, written by the engine): to whom,
// which subject, which Postal message, when, and which week. Newest first.
contentStudioRouter.get('/:ed/digest/emails', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const { data, error } = await getSupabaseAdmin()
    .from('newsletter_owner_emails_v2')
    .select('id, to_email, subject, postal_message_id, sent_at, week_of')
    .eq('user_id', req.userId!)
    .eq('edition_id', ed.edition_id)
    .eq('kind', 'slate')
    .order('sent_at', { ascending: false })
    .limit(10);
  if (error) return bad(res, 500, 'DB_QUERY_FAILED', error.message);
  res.json({ success: true, data: data ?? [] });
});

export const ActionSchema = z.object({
  ids: z.array(UUID).min(1).max(100),
  action: z.enum(['approve', 'unapprove', 'discard', 'cancel', 'requeue', 'unschedule', 'image_on', 'image_off']),
});

contentStudioRouter.post('/:ed/posts/actions', validateBody(ActionSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const body = req.body as z.infer<typeof ActionSchema>;
  const out = await studioSync(req, res, ed, { op: 'update', action: body.action, post_ids: body.ids });
  if (out) res.json({ success: true, data: out });
});

export const ScheduleSchema = z.object({
  ids: z.array(UUID).min(1).max(100),
  mode: z.enum(['next', 'slot', 'at', 'now']),
  day: DATE.optional(),
  slot: z.enum(['morning', 'afternoon']).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  channels: z.array(CHANNEL).min(1).max(10).optional(),
}).refine((b) => b.mode !== 'slot' || (b.day && b.slot), { message: 'A day and a slot are needed', path: ['day'] })
  .refine((b) => b.mode !== 'at' || b.at, { message: 'A time is needed', path: ['at'] });

contentStudioRouter.post('/:ed/posts/schedule', validateBody(ScheduleSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const b = req.body as z.infer<typeof ScheduleSchema>;
  const out = await studioSync(req, res, ed, {
    op: 'schedule', post_ids: b.ids, mode: b.mode,
    ...(b.day ? { day: b.day } : {}), ...(b.slot ? { slot: b.slot } : {}), ...(b.at ? { at: b.at } : {}),
    ...(b.channels ? { channels: b.channels } : {}),
  });
  if (out) res.json({ success: true, data: out });
});

// ---------------------------------------------------------------------------- the next issue
// Any edition the caller owns can have chosen stories, not only a radar-fed one (findOwnedEdition).

async function ownedEdition(req: Request, res: Response): Promise<StudioEdition | null> {
  const ed = await findOwnedEdition(req.userId!, String(req.params.ed));
  if (!ed) bad(res, 404, 'NOT_FOUND', 'No such edition');
  return ed;
}

contentStudioRouter.get('/:ed/issue', async (req: Request, res: Response) => {
  const ed = await ownedEdition(req, res);
  if (!ed) return;
  const out = await studioSync(req, res, ed, { op: 'issue', action: 'show' });
  if (out) res.json({ success: true, data: out });
});

export const IssueSchema = z.object({
  items: z.array(z.object({ kind: z.enum(['post', 'topic']), id: UUID })).max(20),
});

contentStudioRouter.put('/:ed/issue', validateBody(IssueSchema), async (req: Request, res: Response) => {
  const ed = await ownedEdition(req, res);
  if (!ed) return;
  const out = await studioSync(req, res, ed, { op: 'issue', action: 'set', items: (req.body as z.infer<typeof IssueSchema>).items });
  if (out) res.json({ success: true, data: out });
});

contentStudioRouter.post('/:ed/issue/new', async (req: Request, res: Response) => {
  const ed = await ownedEdition(req, res);
  if (!ed) return;
  const out = await studioSync(req, res, ed, { op: 'issue', action: 'new' });
  if (out) res.json({ success: true, data: out });
});

// ---------------------------------------------------------------------------- the assistant

const AssistantSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  conversation_id: z.string().max(200).optional(),
  week_of: DATE.optional(),
});

/** Topics a hub "generate" dispatch covered, for the per-topic charge. */
export function assistantUnits(op: string | null | undefined, params: Record<string, unknown> | null | undefined): number {
  if (op === 'generate') {
    const ids = params?.topic_ids;
    if (Array.isArray(ids)) return ids.length;
    return countSelection(String(params?.numbers ?? ''));
  }
  if (op === 'revise') return String(params?.mode ?? 'revise') === 'undo' ? 0 : 1;
  if (op === 'batch' && Array.isArray(params?.steps)) {
    // Several studio ops from one message ("make #3 punchier and schedule it thursday"): each step's units.
    return (params.steps as unknown[]).reduce<number>((sum, step) => {
      if (!step || typeof step !== 'object') return sum;
      const { op: stepOp, ...rest } = step as Record<string, unknown>;
      return stepOp === 'batch' ? sum : sum + assistantUnits(String(stepOp ?? ''), rest);
    }, 0);
  }
  return 0;
}

/**
 * The Review tab's posts, top to bottom (the order StudioReview lists them), for the assistant: "the
 * second draft" is a position on that list, and the router can only resolve it to a #number if it sees it.
 */
async function reviewList(userId: string, editionId: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await getSupabaseAdmin().from('social_schedule_v2')
    .select('display_number, title, state')
    .eq('user_id', userId).eq('edition_id', editionId).in('state', STATUS_STATES.review!)
    .order('display_number', { ascending: false }).limit(40);
  return ((data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    display_number: p.display_number, title: String(p.title ?? '').slice(0, 100), state: p.state,
  }));
}

contentStudioRouter.post('/:ed/assistant', validateBody(AssistantSchema), async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const body = req.body as z.infer<typeof AssistantSchema>;
  const unitPrice = await getCreditCost('social_repurpose');
  if (chargeable(req) && unitPrice > 0 && (req.creditsRemaining ?? 0) < unitPrice) {
    return bad(res, 402, 'INSUFFICIENT_CREDITS', `The assistant needs at least ${unitPrice} credits for drafting.`);
  }
  const own = ownTopicCommand(body.message);
  if (own) {
    // The owner's own topic: onto this week's slate, then drafted like any other (charged as one topic).
    try {
      const topic = await addOwnTopic(req.userId!, ed, { title: own.title, url: own.url ?? '', angle: '' });
      const job = await callEngineWriteTool('studio', { op: 'generate', topic_ids: [String(topic.id)], user_id: req.userId!, edition_id: ed.edition_id, async: true });
      const charged = chargeable(req) ? unitPrice : 0;
      if (charged > 0) await deductCredits(req.userId!, charged, `studio.assistant.generate:${ed.edition_id}`);
      return res.json({
        success: true,
        data: {
          kind: 'queued', op: 'generate',
          message: `Added “${own.title}” to this week's slate as #${topic.rank} and started drafting it.`,
          jobId: job.job_id ?? null, result: null, error: null, conversationId: null, creditsCharged: charged,
        },
      });
    } catch (err) {
      return bad(res, 502, 'ENGINE_UNREACHABLE', err instanceof Error ? err.message : 'Could not draft that topic');
    }
  }
  try {
    const hub = await callEngineHub({
      message: body.message,
      userId: req.userId!,
      // The conversation is the studio's own, per edition, so "#3" never resolves against the chat drawer's list.
      conversationId: body.conversation_id || `studio:${ed.edition_id}`,
      context: {
        surface: 'content_studio',
        edition_id: ed.edition_id,
        studio_posts: await reviewList(req.userId!, ed.edition_id),
        ...(body.week_of ? { week_of: body.week_of } : {}),
      },
    });
    let charged = 0;
    if (hub.tool === 'studio' && hub.kind === 'queued' && chargeable(req)) {
      charged = unitPrice * assistantUnits(hub.op, hub.params);
      if (charged > 0) await deductCredits(req.userId!, charged, `studio.assistant.${hub.op}:${ed.edition_id}`);
    }
    const data = hub.data as EngineStepEnvelope<Record<string, unknown>> | undefined;
    res.json({
      success: true,
      data: {
        kind: hub.kind,
        op: hub.tool === 'studio' ? hub.op : null,
        message: hub.assistant_message ?? '',
        jobId: hub.job_id ?? null,
        result: data?.payload?.result ?? null,
        error: data?.error ? engineErrorMessage(data.error) : null,
        conversationId: hub.conversation_id ?? null,
        creditsCharged: charged,
      },
    });
  } catch (err) {
    logger.error({ err, edition: ed.edition_id }, 'studio assistant: engine hub failed');
    bad(res, 502, 'ENGINE_UNREACHABLE', 'The assistant could not reach the engine');
  }
});

// ---------------------------------------------------------------------------- RSS feed URLs

async function feedRow(userId: string, ed: StudioEdition, rotate: boolean): Promise<{ token: string; enabled: boolean }> {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('newsletter_edition_feeds_v2').select('token, enabled, user_id')
    .eq('edition_id', ed.edition_id).eq('user_id', userId).maybeSingle();
  if (data && !rotate) return { token: String(data.token), enabled: data.enabled !== false };
  const token = randomBytes(24).toString('base64url');
  if (data) {
    await sb.from('newsletter_edition_feeds_v2').update({ token }).eq('edition_id', ed.edition_id).eq('user_id', userId);
  } else {
    await sb.from('newsletter_edition_feeds_v2').insert({ edition_id: ed.edition_id, user_id: userId, token });
  }
  return { token, enabled: true };
}

function feedUrls(req: Request, token: string): { items: string; digest: string } {
  const base = `${req.protocol}://${req.get('host')}`;
  return { items: `${base}/feeds/${token}/items.xml`, digest: `${base}/feeds/${token}/digest.xml` };
}

contentStudioRouter.get('/:ed/feeds', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const row = await feedRow(req.userId!, ed, false);
  res.json({ success: true, data: { enabled: row.enabled, ...feedUrls(req, row.token) } });
});

contentStudioRouter.post('/:ed/feeds/rotate', async (req: Request, res: Response) => {
  const ed = await edition(req, res);
  if (!ed) return;
  const row = await feedRow(req.userId!, ed, true);
  res.json({ success: true, data: { enabled: row.enabled, ...feedUrls(req, row.token) } });
});
