/**
 * Generate posts from a piece of content: the engine gets the piece's own text, the platforms asked
 * for, the project and the piece's id; it is charged as a social repurpose; a piece that is not the
 * user's, or has too little text, starts nothing.
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
vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async () => 3 }));
vi.mock('../services/credits.js', () => ({ deductCredits: (...a: unknown[]) => deduct(...a) }));
const LONG = 'Marcus carried the box down the bluff in the grey light. '.repeat(10);
vi.mock('../services/supabase-admin.js', () => {
  const rows = [
    { id: 'c1', user_id: 'u1', title: 'Chapter 4', content_text: LONG, content_type: 'chapter', project_id: 'p1', deleted_at: null },
    { id: 'c2', user_id: 'u1', title: 'Stub', content_text: 'Too short.', content_type: 'blog_post', project_id: null, deleted_at: null },
    { id: 'c3', user_id: 'other', title: 'Not mine', content_text: LONG, content_type: 'chapter', project_id: 'p9', deleted_at: null },
  ];
  const from = () => {
    const f: Array<(r: Record<string, unknown>) => boolean> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      maybeSingle: () => Promise.resolve({ data: rows.filter((r) => f.every((x) => x(r)))[0] ?? null }),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

beforeEach(() => { engine.mockReset().mockResolvedValue({ job_id: 'j1' }); deduct.mockReset().mockResolvedValue({ ok: true }); });

async function post(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { socialGenerateRouter } = await import('../routes/social-generate.js');
  const app = express(); app.use(express.json()); app.use('/api/content', socialGenerateRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/content/${id}/social`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

describe('POST /api/content/:id/social', () => {
  it('writes posts from the piece itself, saved against its project and the piece, and charges a repurpose', async () => {
    const r = await post('c1', { platforms: ['linkedin', 'facebook'] });
    expect(r.status).toBe(202);
    expect(r.json.jobId).toBe('j1');
    const [tool, body] = engine.mock.calls[0] as [string, Record<string, unknown>];
    expect(tool).toBe('media');
    expect(body).toMatchObject({ op: 'social-posts', platforms: ['linkedin', 'facebook'], user_id: 'u1', source_content_id: 'c1', project_id: 'p1', persist: true, async: true });
    expect(String(body.summary)).toMatch(/^Chapter 4\n\nMarcus carried the box/);
    expect(deduct).toHaveBeenCalledWith('u1', 3, 'content.social:social_repurpose');
  });

  it('defaults to X and LinkedIn', async () => {
    await post('c1', {});
    expect((engine.mock.calls[0][1] as Record<string, unknown>).platforms).toEqual(['twitter', 'linkedin']);
  });

  it('starts nothing for a piece with too little text, someone else\'s piece, or an unknown platform', async () => {
    expect((await post('c2', {})).status).toBe(409);
    expect((await post('c3', {})).status).toBe(404);
    expect((await post('c1', { platforms: ['myspace'] })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
  });
});
