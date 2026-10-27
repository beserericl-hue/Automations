/**
 * The post calendar API: a post is only scheduled to the caller's own channels, the range read
 * carries each channel's delivery, a posted post cannot be edited, cancel / requeue move between the
 * right states, and the radar endpoints hand the engine the right job (charged per drafted topic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const engine = vi.fn();
const deduct = vi.fn();
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.userId = 'u1'; req.subscriptionTier = { name: 'basic' }; req.creditsRemaining = 50; req.effectiveRole = 'user'; next();
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/engine-hub.js', () => ({ callEngineWriteTool: (...a: unknown[]) => engine(...a) }));
vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async () => 2 }));
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
      if (op === 'insert') {
        const row = { id: `id-${rows().length + 1}`, display_number: rows().length + 1, state: 'pending', attempts: 0, ...payload };
        rows().push(row);
        return [row];
      }
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
      gte: (c: string, v: string) => (f.push((r) => String(r[c]) >= v), q),
      lte: (c: string, v: string) => (f.push((r) => String(r[c]) <= v), q),
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.social_channels_v2 = [
    { user_id: 'u1', channel: 'website', kind: 'website', label: 'TechAhir website', enabled: true },
    { user_id: 'u1', channel: 'li_agile', kind: 'linkedin', label: 'Agile page', enabled: true },
    { user_id: 'u2', channel: 'li_other', kind: 'linkedin', label: 'Not mine', enabled: true },
  ];
  engine.mockReset().mockResolvedValue({ job_id: 'j1', status: 'queued' });
  deduct.mockReset().mockResolvedValue({ ok: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { socialCalendarRouter } = await import('../routes/social-calendar.js');
  const app = express(); app.use(express.json()); app.use('/api/social', socialCalendarRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/social${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

const POST = { title: 'Angels want product', body_md: '# Hi\n\nBody', channels: ['website', 'li_agile'], scheduled_date: '2026-11-03', slot: 'afternoon' };

describe('social calendar', () => {
  it('schedules a post to the caller\'s own channels as a manual, pending post', async () => {
    const r = await call('POST', '/posts', POST);
    expect(r.status).toBe(201);
    const row = db.social_schedule_v2[0];
    expect(row).toMatchObject({ user_id: 'u1', source: 'manual', state: 'pending', item_type: 'blog', category: 'INSIGHTS', slot: 'afternoon' });
    expect(String(row.external_id)).toMatch(/^sched-2026-11-03-afternoon-angels-want-product-/);
  });

  it('refuses a channel the caller does not have, or a post with no text', async () => {
    expect((await call('POST', '/posts', { ...POST, channels: ['li_other'] })).status).toBe(400);
    expect((await call('POST', '/posts', { ...POST, body_md: '', linkedin_content: '' })).status).toBe(400);
    expect(db.social_schedule_v2 ?? []).toHaveLength(0);
  });

  it('reads a range with each channel\'s delivery, and only the caller\'s posts', async () => {
    db.social_schedule_v2 = [
      { id: 'a', user_id: 'u1', scheduled_date: '2026-11-03', state: 'posted', title: 'A' },
      { id: 'b', user_id: 'u2', scheduled_date: '2026-11-03', state: 'pending', title: 'B' },
      { id: 'c', user_id: 'u1', scheduled_date: '2026-12-30', state: 'pending', title: 'C' },
    ];
    db.social_schedule_deliveries_v2 = [{ schedule_id: 'a', channel: 'website', status: 'published', public_url: 'https://x/a' }];
    const r = await call('GET', '/calendar?from=2026-11-01&to=2026-11-30');
    const data = r.json.data as Array<Row>;
    expect(data.map((p) => p.id)).toEqual(['a']);
    expect(data[0].deliveries).toEqual([{ schedule_id: 'a', channel: 'website', status: 'published', public_url: 'https://x/a' }]);
    expect((await call('GET', '/calendar?from=2026-01-01&to=2026-12-31')).status).toBe(400);
  });

  it('will not edit a post that has gone out', async () => {
    db.social_schedule_v2 = [{ id: 'a', user_id: 'u1', state: 'posted', title: 'A' }];
    expect((await call('PATCH', '/posts/a', { title: 'New' })).status).toBe(409);
    expect(db.social_schedule_v2[0].title).toBe('A');
  });

  it('cancels a pending post and requeues it with a fresh retry budget', async () => {
    db.social_schedule_v2 = [{ id: 'a', user_id: 'u1', state: 'pending', attempts: 2, title: 'A' }];
    expect((await call('POST', '/posts/a/cancel')).status).toBe(200);
    expect(db.social_schedule_v2[0].state).toBe('cancelled');
    expect((await call('POST', '/posts/a/cancel')).status).toBe(409);
    expect((await call('POST', '/posts/a/requeue')).status).toBe(200);
    expect(db.social_schedule_v2[0]).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('starts a radar run and a scheduling job on the engine, charging per drafted topic', async () => {
    expect((await call('POST', '/radar/dev/run', { force: true })).status).toBe(202);
    expect(engine.mock.calls[0]).toEqual(['ingestion', { op: 'radar', radar: 'dev', user_id: 'u1', force: true, async: true }]);
    const r = await call('POST', '/radar/trend/schedule', { numbers: '1-3, 8' });
    expect(r.status).toBe(202);
    expect(engine.mock.calls[1]).toEqual(['ingestion', { op: 'radar_schedule', radar: 'trend', user_id: 'u1', numbers: '1-3, 8', async: true }]);
    expect(deduct).toHaveBeenCalledWith('u1', 8, 'social.radar:trend');
    expect((await call('POST', '/radar/nope/run', {})).status).toBe(404);
  });

  it('shows the latest slate and which topics are already on the calendar', async () => {
    db.radar_topics_v2 = [
      { id: 't1', user_id: 'u1', radar: 'dev', week_of: '2026-11-02', rank: 1, title: 'One' },
      { id: 't2', user_id: 'u1', radar: 'dev', week_of: '2026-11-02', rank: 2, title: 'Two' },
    ];
    db.social_schedule_v2 = [{ id: 's', user_id: 'u1', radar_topic_id: 't2', display_number: 9, state: 'pending', scheduled_date: '2026-11-03', slot: 'morning' }];
    const r = await call('GET', '/radar/dev');
    const data = r.json.data as Row;
    expect((data.topics as Row[]).map((t) => t.id)).toEqual(['t1', 't2']);
    expect((data.queued as Record<string, Row>).t2.display_number).toBe(9);
  });
});
