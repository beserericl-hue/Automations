/**
 * Public RSS feeds of a Content Studio edition — what Substack polls instead of the n8n webhooks
 * (`/webhook/ai-dev-roundup.xml` uSFq6y6YombFzzfT and `/webhook/ai-dev-roundup-digest.xml` K6peMqAydbdr7Ldt).
 *
 *   GET /feeds/:token/items.xml    one item per post of the edition that has gone out
 *   GET /feeds/:token/digest.xml   one item per week: the whole slate
 *
 * No login: the token (newsletter_edition_feeds_v2, 32 random url-safe characters) is the secret, and
 * the studio can rotate it. Nothing private is served — only posts already published to their
 * channels and the public links of the week's slate; never drafts, scheduled-but-unsent posts,
 * deliveries' requests, or anything about the owner. An unknown or disabled token is a plain 404.
 */
import { Router, type Request, type Response } from 'express';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { digestFeed, itemsFeed, type DigestTopic, type FeedPost } from '../lib/studio-rss.js';
import { findStudioEdition } from '../lib/studio.js';
import { logger } from '../lib/logger.js';

export const studioFeedsRouter = Router();

const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const WEEKS = 8;
const ITEMS = 50;

async function resolve(req: Request, res: Response) {
  const token = String(req.params.token ?? '');
  if (!TOKEN.test(token)) {
    res.status(404).type('text/plain').send('Not found');
    return null;
  }
  const { data } = await getSupabaseAdmin().from('newsletter_edition_feeds_v2')
    .select('edition_id, user_id, enabled').eq('token', token).maybeSingle();
  // The edition must still be the owner's studio edition (it could have been unsubscribed from its radar).
  const ed = data && data.enabled !== false ? await findStudioEdition(String(data.user_id), String(data.edition_id)) : null;
  if (!data || !ed) {
    res.status(404).type('text/plain').send('Not found');
    return null;
  }
  return { ed, userId: String(data.user_id), token };
}

function send(res: Response, xml: string): void {
  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=900');
  res.set('X-Robots-Tag', 'noindex');
  res.send(xml);
}

function site(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

studioFeedsRouter.get('/:token/items.xml', async (req: Request, res: Response) => {
  try {
    const r = await resolve(req, res);
    if (!r) return;
    const sb = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const { data } = await sb.from('social_schedule_v2')
      .select('id, external_id, title, body_md, linkedin_content, category, scheduled_at, posted_at, source_url, state')
      .eq('user_id', r.userId).eq('edition_id', r.ed.edition_id)
      .in('state', ['posted', 'partial'])
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: false })
      .limit(ITEMS);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const urls = new Map<string, string>();
    if (rows.length) {
      const { data: dels } = await sb.from('social_schedule_deliveries_v2')
        .select('schedule_id, channel, public_url').in('schedule_id', rows.map((p) => String(p.id))).eq('channel', 'website');
      for (const d of (dels ?? []) as Array<Record<string, unknown>>) {
        if (d.public_url) urls.set(String(d.schedule_id), String(d.public_url));
      }
    }
    const posts: FeedPost[] = rows.map((p) => ({
      external_id: String(p.external_id),
      title: String(p.title ?? ''),
      body_md: (p.body_md as string | null) ?? null,
      linkedin_content: (p.linkedin_content as string | null) ?? null,
      category: (p.category as string | null) ?? null,
      scheduled_at: (p.scheduled_at as string | null) ?? null,
      posted_at: (p.posted_at as string | null) ?? null,
      source_url: (p.source_url as string | null) ?? null,
      website_url: urls.get(String(p.id)) ?? null,
    }));
    send(res, itemsFeed({ name: r.ed.name, siteUrl: site(req), selfUrl: `${site(req)}/feeds/${r.token}/items.xml`, posts }));
  } catch (err) {
    logger.error({ err }, 'studio feed: items failed');
    res.status(500).type('text/plain').send('Feed unavailable');
  }
});

studioFeedsRouter.get('/:token/digest.xml', async (req: Request, res: Response) => {
  try {
    const r = await resolve(req, res);
    if (!r) return;
    const sb = getSupabaseAdmin();
    const { data: weekRows } = await sb.from('radar_topics_v2').select('week_of')
      .eq('user_id', r.userId).eq('radar', r.ed.radar).order('week_of', { ascending: false }).limit(60 * WEEKS);
    const weeks = [...new Set(((weekRows ?? []) as Array<{ week_of: string }>).map((w) => String(w.week_of).slice(0, 10)))].slice(0, WEEKS);
    let topics: Array<Record<string, unknown>> = [];
    let runs: Array<Record<string, unknown>> = [];
    if (weeks.length) {
      const [t, rr] = await Promise.all([
        sb.from('radar_topics_v2').select('week_of, rank, title, url, source, item_type, angle')
          .eq('user_id', r.userId).eq('radar', r.ed.radar).in('week_of', weeks).order('rank'),
        sb.from('radar_runs_v2').select('week_of, finished_at')
          .eq('user_id', r.userId).eq('radar', r.ed.radar).in('week_of', weeks),
      ]);
      topics = (t.data ?? []) as Array<Record<string, unknown>>;
      runs = (rr.data ?? []) as Array<Record<string, unknown>>;
    }
    const finished = new Map(runs.map((x) => [String(x.week_of).slice(0, 10), (x.finished_at as string | null) ?? null]));
    const xml = digestFeed({
      editionId: r.ed.edition_id,
      name: r.ed.name,
      siteUrl: site(req),
      selfUrl: `${site(req)}/feeds/${r.token}/digest.xml`,
      weeks: weeks.map((w) => ({
        week_of: w,
        published_at: finished.get(w) ?? null,
        topics: topics.filter((t) => String(t.week_of).slice(0, 10) === w).map((t) => ({
          rank: Number(t.rank), title: String(t.title ?? ''), url: String(t.url ?? ''),
          source: (t.source as string | null) ?? null, item_type: (t.item_type as string | null) ?? null, angle: (t.angle as string | null) ?? null,
        }) as DigestTopic),
      })),
    });
    send(res, xml);
  } catch (err) {
    logger.error({ err }, 'studio feed: digest failed');
    res.status(500).type('text/plain').send('Feed unavailable');
  }
});
