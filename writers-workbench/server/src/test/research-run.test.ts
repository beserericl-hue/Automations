/**
 * Research from the Research screens: the engine is asked for the topic, filed under the project's
 * title when there is one (the project's Research tab and the landing page find research that way),
 * and charged as research. A project that is not the user's starts nothing.
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
vi.mock('../services/supabase-admin.js', () => {
  const projects = [{ id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', title: 'The Ossuary', genre_slug: 'ancient-history', deleted_at: null }];
  const from = () => {
    const f: Array<(r: Record<string, unknown>) => boolean> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      maybeSingle: () => Promise.resolve({ data: projects.filter((r) => f.every((x) => x(r)))[0] ?? null }),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

beforeEach(() => { engine.mockReset().mockResolvedValue({ job_id: 'j1' }); deduct.mockReset().mockResolvedValue({ ok: true }); });

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { researchRunRouter } = await import('../routes/research-run.js');
  const app = express(); app.use(express.json()); app.use('/api/research', researchRunRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/research/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

describe('research run', () => {
  it('files a project’s research under its title, with the project id, and charges research', async () => {
    const r = await post({ topic: 'Piscataway burial practice before 1650', project_id: '11111111-1111-4111-8111-111111111111' });
    expect(r.status).toBe(202);
    expect(engine).toHaveBeenCalledWith('research', expect.objectContaining({
      op: 'run', topic: 'The Ossuary — Piscataway burial practice before 1650', project_id: '11111111-1111-4111-8111-111111111111',
      genre_slug: 'ancient-history', persist: true, async: true,
    }));
    expect(deduct).toHaveBeenCalledWith('u1', 2, 'research.run:research');
  });

  it('runs without a project, and refuses a project that is not the user’s', async () => {
    expect((await post({ topic: 'Roman aqueducts' })).status).toBe(202);
    expect(engine.mock.calls[0][1]).toMatchObject({ topic: 'Roman aqueducts' });
    expect((await post({ topic: 'x y z', project_id: '22222222-2222-4222-8222-222222222222' })).status).toBe(404);
    expect(engine).toHaveBeenCalledTimes(1);
  });
});
