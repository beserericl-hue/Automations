/**
 * The project page's Outline / Write / Rewrite buttons, sent to the engine by id.
 *
 * Asserted: each action reaches the right op with the project's real id and the chapter number, and
 * the author's notes as `author_notes` (they never reached the engine through the chat router);
 * "rewrite" writes the chapter again from its outline (the rewrite op needs the text and saves
 * nothing) and is charged as one; an outline is charged as a chapter brainstorm; and a project that is
 * not the user's, or a chapter that is not in the outline, starts nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const engine = vi.fn();
const deduct = vi.fn();
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => {
    req.userId = 'u1';
    req.subscriptionTier = { name: 'basic' };
    req.creditsRemaining = 100;
    req.effectiveRole = 'user';
    next();
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/engine-hub.js', () => ({ callEngineWriteTool: (...a: unknown[]) => engine(...a) }));
vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async (jobType: string) => ({ write_chapter: 5, brainstorm_chapter: 3, revise_outline: 3 } as Record<string, number>)[jobType] ?? 0 }));
vi.mock('../services/credits.js', () => ({ deductCredits: (...a: unknown[]) => deduct(...a) }));
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      maybeSingle: () => Promise.resolve({ data: (db[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

beforeEach(() => {
  engine.mockReset().mockResolvedValue({ job_id: 'job-1', status: 'queued' });
  deduct.mockReset().mockResolvedValue({ ok: true, balance_after: 90 });
  db.writing_projects_v2 = [
    { id: 'p1', user_id: 'u1', title: 'The Ossuary', deleted_at: null, outline: { chapters: [{ chapter_number: 0 }, { chapter_number: 4 }] } },
    { id: 'p3', user_id: 'u1', title: 'Blank', deleted_at: null, outline: {} },
  ];
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { chapterActionsRouter } = await import('../routes/chapter-actions.js');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', chapterActionsRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (base: string, path: string, body: unknown): Promise<{ status: number; json: any }> =>
  fetch(`${base}/api/projects${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

describe('chapter actions', () => {
  it('outline plans the chapter by id, with the author’s notes', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/p1/chapters/4/engine', { action: 'outline', notes: 'Open on the spring.' });
      expect(r.status).toBe(202);
      expect(r.json.jobId).toBe('job-1');
      expect(deduct).toHaveBeenCalledWith('u1', 3, 'chapter.outline:brainstorm_chapter');
      expect(engine).toHaveBeenCalledWith('chapter', {
        op: 'plan', project_id: 'p1', project_title: 'The Ossuary', chapter_number: 4, user_id: 'u1',
        author_notes: 'Open on the spring.', persist: true, async: true,
      });
    });
  });

  it('rewrite writes the chapter again from its outline, and is charged as a chapter write', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/p1/chapters/0/engine', { action: 'rewrite' });
      expect(r.status).toBe(202);
      const body = engine.mock.calls[0][1] as Row;
      expect(body.op).toBe('write');
      expect(body.chapter_number).toBe(0);
      expect(body.author_notes).toBeUndefined();
      expect(r.json.jobType).toBe('write_chapter');
      // Through the chat proxy a rewrite classified as free chat.
      expect(deduct).toHaveBeenCalledWith('u1', 5, 'chapter.rewrite:write_chapter');
    });
  });

  it('starts nothing for a chapter not in the outline, or a project that is not the user’s', async () => {
    await withServer(async (base) => {
      expect((await post(base, '/p1/chapters/9/engine', { action: 'write' })).json.error.code).toBe('NO_SUCH_CHAPTER');
      expect((await post(base, '/p2/chapters/4/engine', { action: 'write' })).status).toBe(404);
      expect(engine).not.toHaveBeenCalled();
      expect(deduct).not.toHaveBeenCalled();
    });
  });
});

describe('revise the whole outline', () => {
  it('sends the directive to brainstorm.revise-outline by project id, persisted, and charges revise_outline', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/p1/outline/revise', { directive: '  Interleave a 1650 timeline every third chapter.  ' });
      expect(r.status).toBe(202);
      expect(r.json).toMatchObject({ success: true, jobId: 'job-1', engineJob: true, jobType: 'revise_outline' });
      expect(engine).toHaveBeenCalledWith('brainstorm', {
        op: 'revise-outline', project_id: 'p1', project_title: 'The Ossuary', title: 'The Ossuary',
        directive: 'Interleave a 1650 timeline every third chapter.', user_id: 'u1', persist: true, async: true,
      });
      expect(deduct).toHaveBeenCalledWith('u1', 3, 'outline.revise:revise_outline');
    });
  });

  it('starts nothing for an empty directive, a project with no outline, or someone else’s project', async () => {
    await withServer(async (base) => {
      expect((await post(base, '/p1/outline/revise', { directive: ' ' })).json.error.code).toBe('VALIDATION_ERROR');
      const blank = await post(base, '/p3/outline/revise', { directive: 'Add a prologue.' });
      expect(blank.status).toBe(400);
      expect(blank.json.error.code).toBe('NO_OUTLINE');
      expect((await post(base, '/p2/outline/revise', { directive: 'Add a prologue.' })).status).toBe(404);
      expect(engine).not.toHaveBeenCalled();
      expect(deduct).not.toHaveBeenCalled();
    });
  });

  it('charges nothing when the engine cannot be reached', async () => {
    engine.mockRejectedValueOnce(new Error('engine write brainstorm 503'));
    await withServer(async (base) => {
      const r = await post(base, '/p1/outline/revise', { directive: 'Add a prologue.' });
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe('ENGINE_UNREACHABLE');
      expect(deduct).not.toHaveBeenCalled();
    });
  });
});
