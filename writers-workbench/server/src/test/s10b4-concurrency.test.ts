/**
 * S10b-4 — Per-user concurrency gate + admin /api/admin/queues endpoint.
 *
 * The gate lives in n8n-worker's processor and uses Redis INCR/DECR on
 * per-user keys. Tests drive a fake Redis that records INCR/DECR calls
 * so we can assert the gate both admits under the cap and rejects over.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// --------------------------------------------------------------------
// Hoisted mocks — bullmq + ioredis + supabase are stubbed so we can
// exercise the processor and admin route without real infrastructure.

const mocks = vi.hoisted(() => ({
  // ioredis-ish stub with per-key counters
  counters: new Map<string, number>(),
  incrMock: vi.fn(async (key: string) => {
    const next = (mocks.counters.get(key) ?? 0) + 1;
    mocks.counters.set(key, next);
    return next;
  }),
  decrMock: vi.fn(async (key: string) => {
    const next = Math.max(0, (mocks.counters.get(key) ?? 0) - 1);
    mocks.counters.set(key, next);
    return next;
  }),
  expireMock: vi.fn(async () => 1),
  mgetMock: vi.fn(async (...keys: string[]) =>
    keys.map((k) => String(mocks.counters.get(k) ?? 0)),
  ),
  pingMock: vi.fn(async () => 'PONG'),
  quitMock: vi.fn(async () => 'OK'),
  onMock: vi.fn(),
  // BullMQ stubs
  queueGetJobCountsMock: vi.fn(async (..._types: string[]) => ({
    waiting: 2,
    active: 1,
    delayed: 0,
    completed: 5,
    failed: 1,
  })),
  moveToDelayedMock: vi.fn(async () => undefined),
  // Supabase chainable
  supabaseStub: { from: vi.fn() },
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    incr = mocks.incrMock;
    decr = mocks.decrMock;
    expire = mocks.expireMock;
    mget = mocks.mgetMock;
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    on = mocks.onMock;
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    name: string;
    getJobCounts = mocks.queueGetJobCountsMock;
    close = vi.fn();
    constructor(name: string, _opts: unknown) {
      this.name = name;
    }
  }
  class FakeWorker {
    public queueName: string;
    public processor: (job: unknown, token?: string) => unknown;
    on = vi.fn();
    close = vi.fn();
    constructor(queueName: string, processor: (job: unknown, token?: string) => unknown) {
      this.queueName = queueName;
      this.processor = processor;
    }
  }
  class FakeQueueEvents {
    on = vi.fn();
    close = vi.fn();
  }
  class DelayedError extends Error {
    constructor() {
      super('DelayedError');
      this.name = 'DelayedError';
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents, DelayedError };
});

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => mocks.supabaseStub,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization;
    if (hdr?.startsWith('Bearer ')) {
      req.userId = hdr.slice(7);
      req.userRole = 'admin';
    }
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

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
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function supabaseReturns(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    in: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
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
  mocks.counters.clear();
  mocks.incrMock.mockClear();
  mocks.decrMock.mockClear();
  mocks.expireMock.mockClear();
  mocks.moveToDelayedMock.mockClear();
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReset();
  process.env.REDIS_URL = 'redis://localhost:6379';
});

afterEach(() => {
  delete process.env.REDIS_URL;
});

// --------------------------------------------------------------------
// Per-user concurrency gate

describe('S10b-4: concurrency gate', () => {
  it('admits a job when under both caps', async () => {
    const { tryAcquireUserSlot } = await import('../lib/jobs/concurrency.js');
    const result = await tryAcquireUserSlot('+1', 'medium-ops');
    expect(result).toBe('ok');
    expect(mocks.counters.get('user_active_total:+1')).toBe(1);
  });

  it('rejects a 4th total job for the same user and rolls back the counter', async () => {
    const { tryAcquireUserSlot } = await import('../lib/jobs/concurrency.js');
    expect(await tryAcquireUserSlot('+1', 'medium-ops')).toBe('ok');
    expect(await tryAcquireUserSlot('+1', 'medium-ops')).toBe('ok');
    expect(await tryAcquireUserSlot('+1', 'medium-ops')).toBe('ok');
    const rejected = await tryAcquireUserSlot('+1', 'medium-ops');
    expect(rejected).toBe('total-full');
    // counter must NOT creep above the cap — tryAcquire rolled back the 4th incr
    expect(mocks.counters.get('user_active_total:+1')).toBe(3);
  });

  it('rejects a 2nd heavy job even when total cap has headroom', async () => {
    const { tryAcquireUserSlot } = await import('../lib/jobs/concurrency.js');
    expect(await tryAcquireUserSlot('+1', 'heavy-ops')).toBe('ok');
    const rejected = await tryAcquireUserSlot('+1', 'heavy-ops');
    expect(rejected).toBe('heavy-full');
    // heavy counter rolled back AND total counter rolled back
    expect(mocks.counters.get('user_active_heavy:+1')).toBe(1);
    expect(mocks.counters.get('user_active_total:+1')).toBe(1);
  });

  it('releaseUserSlot decrements both counters for heavy, only total for non-heavy', async () => {
    const { tryAcquireUserSlot, releaseUserSlot } = await import('../lib/jobs/concurrency.js');
    await tryAcquireUserSlot('+1', 'heavy-ops');
    await releaseUserSlot('+1', 'heavy-ops');
    expect(mocks.counters.get('user_active_total:+1')).toBe(0);
    expect(mocks.counters.get('user_active_heavy:+1')).toBe(0);
  });

  it('different users do not share slots', async () => {
    const { tryAcquireUserSlot } = await import('../lib/jobs/concurrency.js');
    for (let i = 0; i < 3; i++) await tryAcquireUserSlot('+1', 'medium-ops');
    // user +2 is a fresh bucket
    expect(await tryAcquireUserSlot('+2', 'medium-ops')).toBe('ok');
    expect(mocks.counters.get('user_active_total:+2')).toBe(1);
  });

  it('getUserCounts reports zero when user has no slots', async () => {
    const { getUserCounts } = await import('../lib/jobs/concurrency.js');
    const counts = await getUserCounts('+never-active');
    expect(counts).toEqual({ total: 0, heavy: 0 });
  });
});

// --------------------------------------------------------------------
// Worker processor behavior — delay + release

describe('S10b-4: n8n-worker with concurrency gate', () => {
  it('runs the processor and releases the slot on success', async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('medium-ops', { http }) as unknown as {
      processor: (job: unknown, token?: string) => Promise<unknown>;
    };
    const result = await worker.processor(
      {
        id: 'j1',
        data: {
          userId: '+1',
          jobType: 'chat',
          webhookUrl: 'https://example.test/hook',
          body: {},
        },
      },
      'tok',
    );
    expect((result as { ok: boolean }).ok).toBe(true);
    // acquired once, released once — net zero
    expect(mocks.counters.get('user_active_total:+1') ?? 0).toBe(0);
  });

  it('moves job to delayed and throws DelayedError when user is heavy-full', async () => {
    // Pre-load the counter so the gate immediately rejects.
    mocks.counters.set('user_active_heavy:+1', 1);
    mocks.counters.set('user_active_total:+1', 1);
    const http = vi.fn();
    const { createN8nWorker } = await import('../lib/jobs/n8n-worker.js');
    const worker = createN8nWorker('heavy-ops', { http }) as unknown as {
      processor: (job: unknown, token?: string) => Promise<unknown>;
    };
    const job = {
      id: 'j2',
      data: {
        userId: '+1',
        jobType: 'chat',
        webhookUrl: 'https://example.test/hook',
        body: {},
      },
      moveToDelayed: mocks.moveToDelayedMock,
    };

    await expect(worker.processor(job, 'tok-2')).rejects.toThrow(/DelayedError/);
    expect(mocks.moveToDelayedMock).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
    // Gate rollback left counters unchanged from the pre-loaded state
    expect(mocks.counters.get('user_active_heavy:+1')).toBe(1);
    expect(mocks.counters.get('user_active_total:+1')).toBe(1);
  });
});

// --------------------------------------------------------------------
// Admin queues endpoint

describe('S10b-4: GET /api/admin/queues', () => {
  it('returns queue counts, per-user limits, and top users', async () => {
    supabaseReturns({
      data: [
        { user_id: '+1', queue_name: 'heavy-ops' },
        { user_id: '+1', queue_name: 'medium-ops' },
        { user_id: '+2', queue_name: 'sync-ops' },
      ],
      error: null,
    });

    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp();
    app.use('/api/admin', adminRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/queues`, {
        headers: { Authorization: 'Bearer +admin' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          queues: Array<{ name: string; counts: Record<string, number>; settings: { concurrency: number } }>;
          perUserLimits: { totalPerUser: number; heavyPerUser: number };
          topUsers: Array<{ user_id: string; active_jobs: number }>;
          totalActive: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.queues).toHaveLength(4);
      expect(body.data.queues[0].counts.active).toBe(1);
      expect(body.data.perUserLimits.totalPerUser).toBe(3);
      expect(body.data.perUserLimits.heavyPerUser).toBe(1);
      expect(body.data.totalActive).toBe(3);
      expect(body.data.topUsers[0]).toEqual({ user_id: '+1', active_jobs: 2 });
    } finally {
      await s.close();
    }
  });

  it('returns 503 when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp();
    app.use('/api/admin', adminRouter);
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/queues`, {
        headers: { Authorization: 'Bearer +admin' },
      });
      expect(res.status).toBe(503);
    } finally {
      await s.close();
    }
  });
});
