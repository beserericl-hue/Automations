/**
 * Credit pricing decisions of 2026-11-03, over HTTP.
 *
 *   3. repair, Q/A and humanize are charged (4 credits; humanize per started 100 words), checked
 *      before the work starts (402 like every priced op), charged once after it was accepted, never
 *      for admins, and not when the work did not start / the humanizer skipped.
 *   4. chat charges by the op the engine hub ROUTED to (a revise costs a revise, research costs
 *      research, a plain answer the chat rate), once, after routing; an unaffordable routed op is
 *      aborted and answered 402 — never run for free, never charged twice.
 *   5. the Brainstorm screen charges what a book brainstorm from chat charges.
 *   6. the superuser panel gets EVERY credit key from credit-costs.ts, rejects unknown keys and
 *      non-integers, stores only overrides, and reports what changed.
 *
 * Every assertion here fails on the code before this change (repair/QA/humanize/brainstorm-screen
 * charged nothing; chat charged the classifier's guess; the panel config listed 8 keys).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let auth: Row = {};
let stored: unknown = null;

vi.mock('../middleware/auth.js', () => {
  const requireAuth = (req: Row, _res: unknown, next: () => void) => {
    Object.assign(req, { userId: 'u1', effectiveRole: 'user', subscriptionTier: { name: 'trial' }, creditsRemaining: 100 }, auth);
    next();
  };
  return { requireAuth, requireSuperuser: (_q: unknown, _s: unknown, n: () => void) => n(), requireAdmin: (_q: unknown, _s: unknown, n: () => void) => n() };
});
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../lib/app-config.js', () => ({
  getGlobalJson: async () => stored,
  setGlobalConfig: async (_k: string, v: string) => { stored = JSON.parse(v); return {}; },
}));

const deducted: Array<{ amount: number; description: string }> = [];
let balance = 100;
vi.mock('../services/credits.js', () => ({
  deductCredits: async (_u: string, amount: number, description: string) => {
    if (balance < amount) return { ok: false, reason: 'INSUFFICIENT_CREDITS', message: 'no', balance_after: balance };
    balance -= amount;
    deducted.push({ amount, description });
    return { ok: true, balance_after: balance, transaction_id: `tx${deducted.length}` };
  },
}));

const engineWrite = vi.fn();
const engineSync = vi.fn();
const hub = vi.fn();
const aborted: string[] = [];
vi.mock('../lib/engine-hub.js', () => ({
  hubBackend: () => 'engine',
  callEngineWriteTool: (...a: unknown[]) => engineWrite(...a),
  callEngineWriteToolSync: (...a: unknown[]) => engineSync(...a),
  callEngineHub: (...a: unknown[]) => hub(...a),
  abortEngineJob: async (id: string) => { aborted.push(id); return { aborted: true }; },
  engineErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../services/supabase-admin.js', () => {
  const build = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    const rows = () => (db[table] ?? []).filter((r) => f.every((x) => x(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q, range: () => q,
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      update: () => q, insert: () => Promise.resolve({ error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => void) => ok({ data: rows(), error: null }),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from: (t: string) => build(t) }) };
});

async function server<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { contentActionsRouter } = await import('../routes/content-actions.js');
  const { contentToolsRouter } = await import('../routes/content-tools.js');
  const { brainstormRouter } = await import('../routes/brainstorm.js');
  const { chatRouter } = await import('../routes/chat.js');
  const { superuserRouter } = await import('../routes/superuser.js');
  const { requireAuth } = await import('../middleware/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/content', requireAuth as express.RequestHandler, contentActionsRouter);
  app.use('/api/content', contentToolsRouter);
  app.use('/api/brainstorm', brainstormRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/superuser', superuserRouter);
  const s = app.listen(0);
  try { return await fn(`http://localhost:${(s.address() as AddressInfo).port}`); } finally { s.close(); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

beforeEach(async () => {
  db.published_content_v2 = [{ id: 'c1', user_id: 'u1', project_id: 'p1', content_type: 'chapter', chapter_number: 3, title: 'Three', content_text: 'x', metadata: {}, deleted_at: null }];
  db.writing_projects_v2 = [{ id: 'p1', user_id: 'u1', title: 'Book', project_type: 'fiction' }];
  auth = {};
  balance = 100;
  stored = null;
  deducted.length = 0;
  aborted.length = 0;
  engineWrite.mockReset().mockResolvedValue({ job_id: 'job-1', status: 'queued' });
  engineSync.mockReset();
  hub.mockReset();
  const { clearCreditCostCache } = await import('../services/credit-costs.js');
  clearCreditCostCache();
});

describe('3. repair, Q/A and humanize are charged', () => {
  it.each([
    ['/api/content/c1/repair', undefined, 'repair_chapter'],
    ['/api/content/c1/rewrite-to-fix-qa', undefined, 'repair_chapter'],
    ['/api/content/c1/rewrite-with-research', { research_focus: 'flint knapping' }, 'repair_chapter'],
    ['/api/content/c1/run-qa', undefined, 'qa_chapter'],
  ])('%s charges 4 credits once, after the engine accepted it', async (path, body, key) => {
    await server(async (base) => {
      const r = await call(base, 'POST', path, body ?? {});
      expect(r.status).toBe(202);
      expect(r.json.creditsCharged).toBe(4);
      expect(deducted).toEqual([{ amount: 4, description: expect.stringContaining(key) }]);
      expect(balance).toBe(96);
    });
  });

  it('answers 402 with the standard body before starting anything when the balance is short', async () => {
    auth = { creditsRemaining: 3 };
    await server(async (base) => {
      for (const path of ['/api/content/c1/repair', '/api/content/c1/run-qa', '/api/content/c1/rewrite-to-fix-qa']) {
        const r = await call(base, 'POST', path, {});
        expect(r.status).toBe(402);
        expect(r.json.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', creditsRequired: 4, creditsRemaining: 3 });
      }
      expect(engineWrite).not.toHaveBeenCalled();
      expect(deducted).toHaveLength(0);
    });
  });

  it('admins are exempt; an engine failure charges nothing', async () => {
    auth = { effectiveRole: 'admin', creditsRemaining: 0 };
    await server(async (base) => {
      expect((await call(base, 'POST', '/api/content/c1/repair', {})).status).toBe(202);
      expect(deducted).toHaveLength(0);
      auth = {};
      engineWrite.mockRejectedValueOnce(new Error('engine down'));
      expect((await call(base, 'POST', '/api/content/c1/run-qa', {})).status).toBe(502);
      expect(deducted).toHaveLength(0);
    });
  });

  it('humanize charges 4 per started 100 words, and nothing when the humanizer skipped', async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    await server(async (base) => {
      engineSync.mockResolvedValueOnce({ text: 'y', changed: true, skipped: null, words: 250 });
      const r = await call(base, 'POST', '/api/content/c1/humanize', { text: words(250) });
      expect(r.status).toBe(200);
      expect(r.json.data.credits_charged).toBe(12); // 3 units x 4
      engineSync.mockResolvedValueOnce({ text: 'x', changed: false, skipped: 'STEALTHGPT_API_KEY not set', words: 40 });
      const s = await call(base, 'POST', '/api/content/c1/humanize', { text: words(40) });
      expect(s.json.data.credits_charged).toBe(0);
      expect(deducted.map((d) => d.amount)).toEqual([12]);
      auth = { creditsRemaining: 7 };
      const t = await call(base, 'POST', '/api/content/c1/humanize', { text: words(101) });
      expect(t.status).toBe(402);
      expect(t.json.error.creditsRequired).toBe(8);
    });
  });
});

describe('4. chat charges by the op the engine routed to', () => {
  const queued = (tool: string, op: string) => ({ kind: 'queued', tool, op, job_id: `job-${op}`, status: 'queued', assistant_message: 'ok' });

  it.each([
    // The classifier would call "make chapter 3 tighter" a write; the engine routed a revise.
    ['tighten the outline for chapter 3', queued('brainstorm', 'revise-outline'), 3],
    ['please look into Hopewell trade routes', queued('research', 'run'), 2],
    ['write chapter 4', queued('chapter', 'write'), 5],
    ['check chapter 3 for consistency', queued('chapter', 'qa'), 4],
    ['what is a story arc?', { kind: 'reply', assistant_message: 'An arc is…' }, 0],
    ['list my outlines', { kind: 'data', tool: 'library', op: 'list-outlines', data: {} }, 0],
  ])('"%s" is charged %#', async (message, response, expected) => {
    hub.mockResolvedValueOnce(response);
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/chat/proxy', { user_message_request: message, user_id: 'u1' });
      expect(r.status).toBe(200);
      expect(r.json.creditsCharged).toBe(expected);
      expect(deducted.reduce((n, d) => n + d.amount, 0)).toBe(expected);
      expect(deducted.length).toBe(expected > 0 ? 1 : 0); // once
    });
  });

  it('a fan-out is charged the sum of its ops in one deduction', async () => {
    hub.mockResolvedValueOnce({ kind: 'queued', job_id: 'j1', jobs: [
      { tool: 'chapter', op: 'write', job_id: 'j1' }, { tool: 'research', op: 'run', job_id: 'j2' }, { tool: 'media', op: 'cover-art', job_id: 'j3' },
    ] });
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/chat/proxy', { user_message_request: 'write ch 4 and also research X and also make a cover', user_id: 'u1' });
      expect(r.json.creditsCharged).toBe(5 + 2 + 10);
      expect(deducted).toHaveLength(1);
    });
  });

  it('an unaffordable routed op is aborted and answered 402, not run for free', async () => {
    auth = { creditsRemaining: 3 };
    balance = 3;
    hub.mockResolvedValueOnce(queued('chapter', 'write'));
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/chat/proxy', { user_message_request: 'hi there, write the next one', user_id: 'u1' });
      expect(r.status).toBe(402);
      expect(r.json.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', creditsRequired: 5 });
      expect(aborted).toEqual(['job-write']);
      expect(deducted).toHaveLength(0);
    });
  });

  it('admins are not charged for a routed op', async () => {
    auth = { effectiveRole: 'superuser' };
    hub.mockResolvedValueOnce(queued('chapter', 'write'));
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/chat/proxy', { user_message_request: 'write chapter 4', user_id: 'u1' });
      expect(r.json.creditsCharged).toBe(0);
      expect(deducted).toHaveLength(0);
    });
  });
});

describe('5. brainstorm price parity', () => {
  it('the Brainstorm screen costs what a book brainstorm from chat costs', async () => {
    engineWrite.mockImplementation(async (_tool: string, body: { op: string }) =>
      body.op === 'create-project' ? { payload: { result: { project_id: 'p9' } } } : { job_id: 'job-b', status: 'queued' });
    hub.mockResolvedValueOnce({ kind: 'queued', job_id: 'jb', jobs: [
      { tool: 'brainstorm', op: 'create-project', job_id: null }, { tool: 'brainstorm', op: 'story', job_id: 'jb' },
    ] });
    await server(async (base) => {
      const screen = await call(base, 'POST', '/api/brainstorm/submit', {
        title: 'The Mound', genre_slug: 'post-apocalyptic', story_arc: 'Three-Act Structure', content_text: 'A long enough concept for a story about a mound.',
      });
      expect(screen.status).toBe(200);
      const chat = await call(base, 'POST', '/api/chat/proxy', { user_message_request: 'brainstorm a book called The Mound', user_id: 'u1' });
      expect(screen.json.creditsCharged).toBe(3);
      expect(chat.json.creditsCharged).toBe(screen.json.creditsCharged);
    });
  });

  it('the Brainstorm screen refuses with 402 before creating anything when short', async () => {
    auth = { creditsRemaining: 2 };
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/brainstorm/submit', {
        title: 'The Mound', genre_slug: 'post-apocalyptic', story_arc: 'x', content_text: 'A long enough concept for a story.',
      });
      expect(r.status).toBe(402);
      expect(engineWrite).not.toHaveBeenCalled();
    });
  });
});

describe('6. superuser credit panel', () => {
  it('lists every credit key from credit-costs.ts with label, group and default', async () => {
    const { DEFAULT_CREDIT_COSTS } = await import('../services/credit-costs.js');
    await server(async (base) => {
      const r = await call(base, 'GET', '/api/superuser/config');
      expect(Object.keys(r.json.data.credit_costs).sort()).toEqual(Object.keys(DEFAULT_CREDIT_COSTS).sort());
      expect(r.json.data.credit_cost_catalog).toHaveLength(Object.keys(DEFAULT_CREDIT_COSTS).length);
      expect(r.json.data.credit_cost_catalog).toContainEqual(expect.objectContaining({ key: 'humanize_passage', default: 4, unit: 'per 100 words' }));
      expect(r.json.data.credit_costs.qa_chapter).toBe(4);
    });
  });

  it('validates (non-negative integers, known keys), stores only overrides, and reports the change', async () => {
    await server(async (base) => {
      expect((await call(base, 'PUT', '/api/superuser/config', { credit_costs: { qa_chapter: -1 } })).status).toBe(400);
      expect((await call(base, 'PUT', '/api/superuser/config', { credit_costs: { qa_chapter: 2.5 } })).status).toBe(400);
      expect((await call(base, 'PUT', '/api/superuser/config', { credit_costs: { made_up: 3 } })).status).toBe(400);
      const ok = await call(base, 'PUT', '/api/superuser/config', { credit_costs: { qa_chapter: 6, write_chapter: 5 } });
      expect(ok.status).toBe(200);
      expect(ok.json.data.changes).toEqual([{ key: 'qa_chapter', from: 4, to: 6 }]);
      expect(stored).toMatchObject({ credit_costs: { qa_chapter: 6 } });
      expect((stored as { credit_costs: Row }).credit_costs).not.toHaveProperty('write_chapter');
      // The new price is what the next Q/A is charged.
      expect((await call(base, 'POST', '/api/content/c1/run-qa', {})).json.creditsCharged).toBe(6);
    });
  });
});
