/**
 * S10b-3 — Chat proxy migration onto BullMQ + jobs API.
 *
 * These tests mock BullMQ, ioredis, and the Supabase admin client so the
 * routes can be exercised in-process without a real Redis or database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// --------------------------------------------------------------------
// Mocks — hoisted so they apply before the route modules import their
// own collaborators.

const mocks = vi.hoisted(() => ({
  pingMock: vi.fn(),
  quitMock: vi.fn(),
  onMock: vi.fn(),
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(),
  queueAddMock: vi.fn(async (_name: string, _data: unknown, _opts: unknown) => ({ id: 'bull-mock-id' })),
  queueGetJobMock: vi.fn(async (_id: string) => null as unknown),
  queueCloseMock: vi.fn(async () => undefined),
  supabaseStub: {
    from: vi.fn(),
  },
  fetchMock: vi.fn(),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    on = mocks.onMock;
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    name: string;
    opts: unknown;
    add = mocks.queueAddMock;
    getJob = mocks.queueGetJobMock;
    close = mocks.queueCloseMock;
    constructor(name: string, opts: unknown) {
      this.name = name;
      this.opts = opts;
    }
  }
  class FakeWorker {
    on = mocks.workerOnMock;
    close = mocks.workerCloseMock;
  }
  class FakeQueueEvents {
    on = vi.fn();
    close = vi.fn();
  }
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
});

// Service-role Supabase client — the routes and job-tracker both import
// this, so we hand them a chainable stub that returns whatever the
// current test configured.
vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => mocks.supabaseStub,
}));

// Auth middleware — stub out Supabase validation; treat Authorization:
// Bearer <phone> as the user's phone number for convenience.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization;
    if (!hdr?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    req.userId = hdr.slice(7);
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Server-side fetch (used by chat.ts to call n8n) is mocked by making
// the fake check URL: localhost goes to the real fetch so our test HTTP
// calls still reach the Express server, everything else hits the mock.
const realFetch = globalThis.fetch.bind(globalThis);

// --------------------------------------------------------------------
// Helpers

function makeApp() {
  const app = express();
  app.use(express.json());
  return app;
}

function startServer(app: express.Express) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Install a chainable Supabase stub. Each method returns `this` until the
 * caller `awaits` the builder; the resolved value is what tests supply.
 */
function supabaseReturns(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

// --------------------------------------------------------------------
// Setup / teardown

beforeEach(() => {
  mocks.queueAddMock.mockClear();
  mocks.queueGetJobMock.mockClear();
  mocks.queueCloseMock.mockClear();
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReset();
  mocks.fetchMock.mockReset();
  // Dispatch: test HTTP (localhost) → real fetch, everything else → mock
  globalThis.fetch = ((url: unknown, init?: unknown) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')) {
      return (realFetch as unknown as (...args: unknown[]) => Promise<Response>)(url, init);
    }
    return mocks.fetchMock(url, init);
  }) as unknown as typeof fetch;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.N8N_API_URL = 'https://n8n.example.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.REDIS_URL;
  delete process.env.N8N_API_URL;
  delete process.env.N8N_HUB_WEBHOOK_URL;
});

// --------------------------------------------------------------------
// Chat proxy: sync vs async routing

describe('POST /api/chat/proxy', () => {
  it('returns 401 without auth', async () => {
    const { chatRouter } = await import('../routes/chat.js');
    const app = makeApp();
    app.use('/api/chat', chatRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_message_request: 'list my projects', user_id: '+1' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('sync message ("list my projects") calls n8n directly and returns its body', async () => {
    mocks.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: 'here are your projects' }), { status: 200 }),
    );
    const { chatRouter } = await import('../routes/chat.js');
    const app = makeApp();
    app.use('/api/chat', chatRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +14105551234' },
        body: JSON.stringify({ user_message_request: 'list my projects', user_id: '+14105551234' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string; classification: { tier: string } };
      expect(body.mode).toBe('sync');
      expect(body.classification.tier).toBe('sync');
      expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
      expect(mocks.queueAddMock).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('async message ("write chapter 3") enqueues a job and returns {jobId}', async () => {
    // Supabase insert into job_queue_v2 succeeds with an id
    supabaseReturns({ data: { id: 'tracker-uuid' }, error: null });

    const { chatRouter } = await import('../routes/chat.js');
    const app = makeApp();
    app.use('/api/chat', chatRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +1' },
        body: JSON.stringify({ user_message_request: 'write chapter 3 of Dust', user_id: '+1' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        jobId: string;
        status: string;
        classification: { queue: string; jobType: string };
      };
      expect(body.mode).toBe('async');
      expect(body.jobId).toBe('bull-mock-id');
      expect(body.status).toBe('queued');
      expect(body.classification.queue).toBe('heavy-ops');
      expect(body.classification.jobType).toBe('write_chapter');
      expect(mocks.queueAddMock).toHaveBeenCalledTimes(1);
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('uses N8N_HUB_WEBHOOK_URL when set', async () => {
    process.env.N8N_HUB_WEBHOOK_URL = 'https://n8n.example.test/webhook/author_request_dev';
    mocks.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { chatRouter } = await import('../routes/chat.js');
    const app = makeApp();
    app.use('/api/chat', chatRouter);
    const s = startServer(app);
    try {
      await fetch(`http://localhost:${s.port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +1' },
        body: JSON.stringify({ user_message_request: 'list drafts', user_id: '+1' }),
      });
      expect(mocks.fetchMock).toHaveBeenCalledWith(
        'https://n8n.example.test/webhook/author_request_dev',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      await s.close();
    }
  });

  it('falls back to direct proxy when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    mocks.fetchMock.mockResolvedValue(new Response(JSON.stringify({ output: 'ok' }), { status: 200 }));
    const { chatRouter } = await import('../routes/chat.js');
    const app = makeApp();
    app.use('/api/chat', chatRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/chat/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +1' },
        body: JSON.stringify({ user_message_request: 'write chapter 1 of Foo', user_id: '+1' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe('sync-fallback');
      expect(mocks.queueAddMock).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});

// --------------------------------------------------------------------
// Jobs API

describe('GET /api/jobs', () => {
  it('returns 401 without auth', async () => {
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs`);
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('returns only the authenticated user\'s jobs', async () => {
    supabaseReturns({ data: [{ id: 'r1', user_id: '+1', job_id: 'b1' }], error: null });
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs`, {
        headers: { Authorization: 'Bearer +1' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; jobs: { user_id: string }[] };
      expect(body.success).toBe(true);
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].user_id).toBe('+1');
    } finally {
      await s.close();
    }
  });

  it('GET /api/jobs/stats returns counts by status', async () => {
    supabaseReturns({
      data: [
        { status: 'waiting' },
        { status: 'active' },
        { status: 'active' },
        { status: 'completed' },
      ],
      error: null,
    });
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs/stats`, {
        headers: { Authorization: 'Bearer +1' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { counts: Record<string, number>; total: number };
      expect(body.counts.waiting).toBe(1);
      expect(body.counts.active).toBe(2);
      expect(body.counts.completed).toBe(1);
      expect(body.total).toBe(4);
    } finally {
      await s.close();
    }
  });

  it('GET /api/jobs/:id returns 404 for another user\'s job', async () => {
    // scoped query returns null because user_id doesn't match
    supabaseReturns({ data: null, error: null });
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs/some-other-users-job`, {
        headers: { Authorization: 'Bearer +1' },
      });
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('GET /api/jobs/:id/status returns lightweight status fields', async () => {
    supabaseReturns({
      data: {
        id: 'row-1',
        job_id: 'b1',
        user_id: '+1',
        status: 'active',
        attempts: 1,
        duration_ms: null,
        completed_at: null,
        error_message: null,
        queue_name: 'heavy-ops',
        job_type: 'write_chapter',
        priority: 5,
        payload: {},
        result: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      },
      error: null,
    });
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs/b1/status`, {
        headers: { Authorization: 'Bearer +1' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; attempts: number };
      expect(body.status).toBe('active');
      expect(body.attempts).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('DELETE /api/jobs/:id refuses to cancel an already-completed job', async () => {
    supabaseReturns({
      data: {
        id: 'row-1',
        job_id: 'b1',
        user_id: '+1',
        status: 'completed',
        queue_name: 'medium-ops',
        job_type: 'brainstorm_story',
        priority: 3,
        attempts: 1,
        duration_ms: 123,
        completed_at: new Date().toISOString(),
        error_message: null,
        payload: {},
        result: {},
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      },
      error: null,
    });
    const { jobsRouter } = await import('../routes/jobs.js');
    const app = makeApp();
    app.use('/api/jobs', jobsRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/jobs/b1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer +1' },
      });
      expect(res.status).toBe(409);
      expect(mocks.queueGetJobMock).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});
