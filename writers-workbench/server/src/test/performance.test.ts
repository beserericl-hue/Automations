/**
 * S12-5 — GET /api/admin/performance endpoint.
 *
 * Verifies:
 *   - 401 without bearer
 *   - Aggregates token_usage_v2 rows with non-null execution_time_ms
 *   - Returns p50/p95/avg per workflow, recent samples, and totals
 *   - Honors ?days= and ?workflow= filters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({
  supabaseStub: { from: vi.fn() },
  lastQuery: {} as { since?: string; workflow?: string },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => mocks.supabaseStub,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization;
    if (!hdr?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    req.userId = hdr.slice(7);
    req.userRole = 'admin';
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

function makeApp(mountRouter: (app: express.Express) => void) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  mountRouter(app);
  return app;
}

function startServer(app: express.Express) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function installTimingStub(rows: Array<{
  workflow_name: string;
  execution_time_ms: number | null;
  queue_wait_ms: number | null;
  llm_time_ms: number | null;
  total_tokens: number;
  cost_usd: number;
  created_at: string;
}>) {
  mocks.lastQuery = {};
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.not = vi.fn(() => chain);
  chain.gte = vi.fn((_col: string, iso: string) => {
    mocks.lastQuery.since = iso;
    return chain;
  });
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.eq = vi.fn((_col: string, val: string) => {
    mocks.lastQuery.workflow = val;
    return chain;
  });
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
}

beforeEach(() => {
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReset();
});

describe('GET /api/admin/performance', () => {
  it('401 without bearer', async () => {
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/performance`);
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('returns p50/p95/avg per workflow with recent samples', async () => {
    const now = new Date().toISOString();
    installTimingStub([
      {
        workflow_name: 'Worker - Write Chapter V2 Dev',
        execution_time_ms: 120_000,
        queue_wait_ms: 2_000,
        llm_time_ms: 100_000,
        total_tokens: 8000,
        cost_usd: 0.25,
        created_at: now,
      },
      {
        workflow_name: 'Worker - Write Chapter V2 Dev',
        execution_time_ms: 180_000,
        queue_wait_ms: 3_500,
        llm_time_ms: 150_000,
        total_tokens: 12000,
        cost_usd: 0.37,
        created_at: now,
      },
      {
        workflow_name: 'Tool - Brainstorm Story V2 Dev',
        execution_time_ms: 45_000,
        queue_wait_ms: 1_000,
        llm_time_ms: 40_000,
        total_tokens: 3000,
        cost_usd: 0.08,
        created_at: now,
      },
    ]);

    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/performance?days=7`, {
        headers: { Authorization: 'Bearer +admin' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          total_runs: number;
          window_days: number;
          workflows: Array<{
            workflow_name: string;
            count: number;
            execution_ms: { avg: number; p50: number; p95: number };
          }>;
          recent: unknown[];
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.total_runs).toBe(3);
      expect(body.data.window_days).toBe(7);
      expect(body.data.workflows).toHaveLength(2);
      const chapter = body.data.workflows.find((w) => w.workflow_name.startsWith('Worker'));
      expect(chapter).toBeDefined();
      expect(chapter!.count).toBe(2);
      expect(chapter!.execution_ms.avg).toBe(150_000);
      expect(body.data.recent.length).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('honors the workflow filter', async () => {
    installTimingStub([]);
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(
        `http://localhost:${s.port}/api/admin/performance?workflow=Worker%20-%20Write%20Chapter%20V2%20Dev`,
        { headers: { Authorization: 'Bearer +admin' } },
      );
      expect(res.status).toBe(200);
      expect(mocks.lastQuery.workflow).toBe('Worker - Write Chapter V2 Dev');
    } finally {
      await s.close();
    }
  });

  it('clamps days to [1,90]', async () => {
    installTimingStub([]);
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/performance?days=9999`, {
        headers: { Authorization: 'Bearer +admin' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { window_days: number } };
      expect(body.data.window_days).toBe(90);
    } finally {
      await s.close();
    }
  });
});
