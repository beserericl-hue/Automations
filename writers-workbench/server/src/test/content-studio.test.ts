/**
 * Content Studio API (migration 050): only the owner's radar editions exist for a caller (everything
 * else is a 404 with no engine call), each op hands the engine the caller + edition, drafting is
 * charged per topic at the social-repurpose price, the assistant runs on the studio surface with the
 * edition pinned in context, and the RSS feeds serve only posted content behind an unguessable token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const engine = vi.fn();
const hub = vi.fn();
const deduct = vi.fn();
let currentUser = 'owner';
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.userId = currentUser; req.subscriptionTier = { name: 'basic' }; req.creditsRemaining = 50; req.effectiveRole = 'user'; next();
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/engine-hub.js', () => ({
  callEngineWriteTool: (...a: unknown[]) => engine(...a),
  callEngineHub: (...a: unknown[]) => hub(...a),
  engineErrorMessage: (e: unknown) => (typeof e === 'string' ? e : (e as { message?: string })?.message ?? ''),
}));
vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async () => 3 }));
vi.mock('../services/credits.js', () => ({ deductCredits: (...a: unknown[]) => deduct(...a) }));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    let limit = Infinity;
    const rows = () => (db[table] ??= []);
    const run = () => {
      if (op === 'insert') { rows().push({ ...payload }); return [payload]; }
      const hit = rows().filter((r) => f.every((x) => x(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return hit; }
      return hit.slice(0, limit);
    };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      lte: (c: string, v: string) => (f.push((r) => String(r[c]) <= v), q),
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

const TOPIC = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  currentUser = 'owner';
  for (const k of Object.keys(db)) delete db[k];
  db.newsletter_editions_v2 = [
    { id: 'ai-dev-roundup', user_id: 'owner', display_name: 'AI Dev Roundup', cadence: 'weekly' },
    { id: 'plain', user_id: 'owner', display_name: 'No radar' },
    { id: 'theirs', user_id: 'other', display_name: 'Theirs' },
  ];
  db.radar_subscriptions_v2 = [{ user_id: 'owner', radar: 'dev', enabled: true, settings: { edition_id: 'ai-dev-roundup', channels: ['li_agile'] } }];
  db.newsletter_feed_sources_v2 = [{ user_id: 'other', edition_id: 'theirs', url: 'radar://dev', url_type: 'radar', active: true }];
  db.radar_topics_v2 = [
    { id: TOPIC, user_id: 'owner', radar: 'dev', week_of: '2026-11-02', rank: 1, title: 'A topic', url: 'https://a', item_type: 'article', angle: 'why' },
    { id: 'v', user_id: 'owner', radar: 'dev', week_of: '2026-11-02', rank: 2, title: 'A video', url: 'https://www.youtube.com/watch?v=abc123', item_type: 'video', angle: '' },
    { id: 'old', user_id: 'owner', radar: 'dev', week_of: '2026-10-26', rank: 1, title: 'Last week', url: 'https://old', item_type: 'article', angle: '' },
  ];
  db.social_schedule_v2 = [
    { id: POST, user_id: 'owner', edition_id: 'ai-dev-roundup', display_number: 7, state: 'draft', title: 'Draft', radar_topic_id: TOPIC },
  ];
  engine.mockReset().mockImplementation(async (_tool: string, body: Record<string, unknown>) =>
    body.async ? { job_id: 'j1', status: 'queued' } : { status: 'ok', payload: { op: body.op, result: { message: 'ok' } } });
  hub.mockReset();
  deduct.mockReset().mockResolvedValue({ ok: true });
});

async function call(method: string, path: string, body?: unknown, prefix = '/api/studio'): Promise<{ status: number; json: Record<string, unknown>; text: string; type: string }> {
  const { contentStudioRouter } = await import('../routes/content-studio.js');
  const { studioFeedsRouter } = await import('../routes/studio-feeds.js');
  const app = express(); app.use(express.json()); app.use('/api/studio', contentStudioRouter); app.use('/feeds', studioFeedsRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${prefix}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* xml */ }
    return { status: r.status, json, text, type: r.headers.get('content-type') ?? '' };
  } finally { server.close(); }
}

describe('content studio: ownership', () => {
  it('lists only the caller\'s editions that a radar of theirs feeds', async () => {
    const r = await call('GET', '/editions');
    expect((r.json.data as Row[]).map((e) => e.edition_id)).toEqual(['ai-dev-roundup']);
    currentUser = 'other';
    expect((await call('GET', '/editions')).json.data).toEqual([]); // a radar:// feed without a subscription is nothing
  });

  it('answers 404 for another user\'s edition, an edition with no radar, and never calls the engine', async () => {
    currentUser = 'other';
    for (const [m, p, b] of [
      ['GET', '/ai-dev-roundup'], ['GET', '/ai-dev-roundup/slate'], ['GET', '/ai-dev-roundup/posts'],
      ['POST', '/ai-dev-roundup/generate', { numbers: '1' }], ['POST', '/ai-dev-roundup/assistant', { message: 'list the queue' }],
      ['GET', '/ai-dev-roundup/issue'], ['GET', '/ai-dev-roundup/feeds'], ['POST', '/ai-dev-roundup/posts/actions', { ids: [POST], action: 'approve' }],
      ['GET', '/theirs'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    currentUser = 'owner';
    expect((await call('GET', '/plain/slate')).status).toBe(404);
    expect(engine).not.toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
    expect(db.newsletter_edition_feeds_v2 ?? []).toHaveLength(0);
  });
});

describe('content studio: reads', () => {
  it('shows the newest week\'s slate with the post each topic became', async () => {
    const r = await call('GET', '/ai-dev-roundup/slate');
    const data = r.json.data as { week_of: string; topics: Row[] };
    expect(data.week_of).toBe('2026-11-02');
    expect(data.topics.map((t) => t.rank)).toEqual([1, 2]);
    expect(data.topics[0].post).toMatchObject({ display_number: 7, state: 'draft' });
    expect((await call('GET', '/ai-dev-roundup/slate?week=2026-10-26')).json.data).toMatchObject({ week_of: '2026-10-26' });
  });

  it('reads the edition\'s posts by status', async () => {
    expect(((await call('GET', '/ai-dev-roundup/posts?status=drafts')).json.data as Row[]).map((p) => p.id)).toEqual([POST]);
    expect((await call('GET', '/ai-dev-roundup/posts?status=queue')).json.data).toEqual([]);
    expect((await call('GET', '/ai-dev-roundup/posts?status=nope')).status).toBe(400);
  });
});

describe('content studio: ops go to the engine as the caller, on the edition', () => {
  it('queues drafting and charges per topic', async () => {
    const r = await call('POST', '/ai-dev-roundup/generate', { numbers: '1-3, 8' });
    expect(r.status).toBe(202);
    expect(engine.mock.calls[0]).toEqual(['studio', { op: 'generate', numbers: '1-3, 8', user_id: 'owner', edition_id: 'ai-dev-roundup', async: true }]);
    expect(deduct).toHaveBeenCalledWith('owner', 12, 'studio.generate:ai-dev-roundup');
    expect((await call('POST', '/ai-dev-roundup/generate', {})).status).toBe(400);
  });

  it('refuses drafting the caller cannot pay for', async () => {
    const r = await call('POST', '/ai-dev-roundup/generate', { numbers: 'all' }); // 24 x 3 > 50
    expect(r.status).toBe(402);
    expect(engine).not.toHaveBeenCalled();
  });

  it('revises (charged once), edits and acts synchronously, and maps engine refusals to HTTP', async () => {
    expect((await call('POST', `/ai-dev-roundup/posts/${POST}/revise`, { instruction: 'shorter' })).status).toBe(202);
    expect(engine.mock.calls[0][1]).toMatchObject({ op: 'revise', mode: 'revise', post_ids: [POST], instruction: 'shorter', async: true });
    expect(deduct).toHaveBeenCalledWith('owner', 3, 'studio.revise:ai-dev-roundup');
    expect((await call('PATCH', `/ai-dev-roundup/posts/${POST}`, { title: 'New' })).status).toBe(200);
    expect(engine.mock.calls[1][1]).toMatchObject({ op: 'update', action: 'edit', post_ids: [POST], changes: { title: 'New' }, async: false });
    expect((await call('PATCH', `/ai-dev-roundup/posts/${POST}`, { image_url: 'http://insecure/x.png' })).status).toBe(400);
    engine.mockResolvedValueOnce({ status: 'error', error: { code: 'ALREADY_POSTED', message: 'A posted post cannot be edited' } });
    const refused = await call('POST', '/ai-dev-roundup/posts/actions', { ids: [POST], action: 'approve' });
    expect(refused.status).toBe(409);
    expect((refused.json.error as Row).message).toBe('A posted post cannot be edited');
  });

  it('schedules with a validated mode', async () => {
    expect((await call('POST', '/ai-dev-roundup/posts/schedule', { ids: [POST], mode: 'slot' })).status).toBe(400);
    expect((await call('POST', '/ai-dev-roundup/posts/schedule', { ids: [POST], mode: 'slot', day: '2026-11-10', slot: 'afternoon' })).status).toBe(200);
    expect(engine.mock.calls[0][1]).toMatchObject({ op: 'schedule', post_ids: [POST], mode: 'slot', day: '2026-11-10', slot: 'afternoon' });
  });

  it('sets the next issue\'s stories in order', async () => {
    const items = [{ kind: 'topic', id: TOPIC }, { kind: 'post', id: POST }];
    expect((await call('PUT', '/ai-dev-roundup/issue', { items })).status).toBe(200);
    expect(engine.mock.calls[0][1]).toMatchObject({ op: 'issue', action: 'set', items, user_id: 'owner', edition_id: 'ai-dev-roundup' });
    expect((await call('PUT', '/ai-dev-roundup/issue', { items: [{ kind: 'x', id: TOPIC }] })).status).toBe(400);
  });
});

describe('content studio: the assistant', () => {
  it('routes on the studio surface with the edition pinned, and charges a queued generate per topic', async () => {
    hub.mockResolvedValue({ kind: 'queued', tool: 'studio', op: 'generate', job_id: 'j9', assistant_message: 'Drafting', params: { numbers: '1-5, 8', edition_id: 'ai-dev-roundup' } });
    const r = await call('POST', '/ai-dev-roundup/assistant', { message: 'generate 1-5 and 8' });
    expect(r.status).toBe(200);
    expect(hub.mock.calls[0][0]).toMatchObject({
      message: 'generate 1-5 and 8', userId: 'owner', conversationId: 'studio:ai-dev-roundup',
      context: { surface: 'content_studio', edition_id: 'ai-dev-roundup' },
    });
    expect(r.json.data).toMatchObject({ kind: 'queued', op: 'generate', jobId: 'j9', creditsCharged: 18 });
    expect(deduct).toHaveBeenCalledWith('owner', 18, 'studio.assistant.generate:ai-dev-roundup');
  });

  it('sends the Review list for ordinals, and charges a compound message for the steps it runs', async () => {
    // Found on DEV 2026-11-03: "make the second draft punchier and schedule it for Thursday afternoon".
    db.social_schedule_v2.push(
      { id: 'p8', user_id: 'owner', edition_id: 'ai-dev-roundup', display_number: 8, state: 'approved', title: 'Approved one' },
      { id: 'p9', user_id: 'owner', edition_id: 'ai-dev-roundup', display_number: 9, state: 'posted', title: 'Posted one' },
      { id: 'px', user_id: 'other', edition_id: 'ai-dev-roundup', display_number: 10, state: 'draft', title: 'Not mine' },
    );
    hub.mockResolvedValue({
      kind: 'queued', tool: 'studio', op: 'batch', job_id: 'j10', assistant_message: 'On it',
      params: { steps: [
        { op: 'revise', posts: '#8', instruction: 'punchier', mode: 'revise' },
        { op: 'schedule', posts: '8', mode: 'slot', day: 'thursday', slot: 'afternoon' },
      ] },
    });
    const r = await call('POST', '/ai-dev-roundup/assistant', { message: 'make the second draft punchier and schedule it for Thursday afternoon' });
    const posts = (hub.mock.calls[0][0] as { context: { studio_posts: Row[] } }).context.studio_posts;
    expect(posts.map((p) => p.display_number).sort()).toEqual([7, 8]); // the Review tab: drafts + approved, the caller's own
    expect(posts.find((p) => p.display_number === 8)).toEqual({ display_number: 8, title: 'Approved one', state: 'approved' });
    expect(r.json.data).toMatchObject({ kind: 'queued', op: 'batch', creditsCharged: 3 }); // one revise; scheduling is free
    expect(deduct).toHaveBeenCalledWith('owner', 3, 'studio.assistant.batch:ai-dev-roundup');
  });

  it('returns a sync op\'s result and refusal without charging', async () => {
    hub.mockResolvedValue({ kind: 'data', tool: 'studio', op: 'update', assistant_message: 'No post #9 in this edition',
      data: { status: 'error', error: { code: 'NOT_FOUND', message: 'No post #9 in this edition' } } });
    const r = await call('POST', '/ai-dev-roundup/assistant', { message: 'cancel 9' });
    expect(r.json.data).toMatchObject({ kind: 'data', op: 'update', error: 'No post #9 in this edition', creditsCharged: 0 });
    expect(deduct).not.toHaveBeenCalled();
  });
});

describe('content studio: RSS feeds', () => {
  it('makes a token on first read, serves only posted posts with the CTA stripped, and 404s an unknown token', async () => {
    const urls = (await call('GET', '/ai-dev-roundup/feeds')).json.data as { items: string; digest: string };
    const token = (db.newsletter_edition_feeds_v2[0].token as string);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(urls.items).toMatch(new RegExp(`/feeds/${token}/items\\.xml$`));
    db.social_schedule_v2.push(
      { id: 'p1', user_id: 'owner', edition_id: 'ai-dev-roundup', state: 'posted', external_id: 'roundup-1', title: 'Posted one',
        body_md: '', linkedin_content: 'Hook line\n🔗 Read: https://a\n💬 Want these every week? Comment \'newsletter\'\n#AI #Dev', scheduled_at: '2026-11-02T14:00:00Z', source_url: 'https://a' },
      { id: 'p2', user_id: 'owner', edition_id: 'ai-dev-roundup', state: 'pending', external_id: 'roundup-2', title: 'Not yet', linkedin_content: 'x', scheduled_at: '2099-01-01T14:00:00Z' },
      { id: 'p3', user_id: 'other', edition_id: 'ai-dev-roundup', state: 'posted', external_id: 'x', title: 'Not theirs', linkedin_content: 'x', scheduled_at: '2026-11-01T14:00:00Z' },
    );
    const items = await call('GET', `/${token}/items.xml`, undefined, '/feeds');
    expect(items.status).toBe(200);
    expect(items.type).toContain('application/rss+xml');
    expect(items.text).toContain('<title>Posted one</title>');
    expect(items.text).toContain('<link>https://a</link>');
    expect(items.text).not.toContain('Not yet');
    expect(items.text).not.toContain('Not theirs');
    expect(items.text).not.toMatch(/want these every week|#AI/i);
    const digest = await call('GET', `/${token}/digest.xml`, undefined, '/feeds');
    expect((digest.text.match(/<item>/g) ?? []).length).toBe(2); // one per week
    expect(digest.text).toContain('<guid isPermaLink="false">ai-dev-roundup-2026-11-02</guid>');
    expect(digest.text).toContain('img.youtube.com/vi/abc123/hqdefault.jpg');
    expect((await call('GET', '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/items.xml', undefined, '/feeds')).status).toBe(404);
    expect((await call('GET', '/short/items.xml', undefined, '/feeds')).status).toBe(404);
  });

  it('stops serving a feed whose edition is no longer a studio edition', async () => {
    db.newsletter_edition_feeds_v2 = [{ edition_id: 'ai-dev-roundup', user_id: 'owner', token: 'B'.repeat(32), enabled: true }];
    db.radar_subscriptions_v2 = [];
    expect((await call('GET', `/${'B'.repeat(32)}/items.xml`, undefined, '/feeds')).status).toBe(404);
  });
});
