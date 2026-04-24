/**
 * S12-10 — POST /api/content/:id/rewrite-with-research
 *
 * Verifies:
 *   - 401 without bearer
 *   - 400 when research_focus is too short
 *   - 404 when chapter doesn't belong to the caller
 *   - 400 when content_type is not 'chapter'
 *   - 202 with jobId on happy path; job added to heavy-ops queue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({
  supabaseStub: { from: vi.fn() },
  chapterRow: null as Record<string, unknown> | null,
  projectRow: null as Record<string, unknown> | null,
  addedJobs: [] as Array<{ queue: string; jobName: string; data: unknown }>,
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
    req.userRole = 'user';
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../lib/queue.js', () => ({
  getNamedQueue: (name: string) => ({ name }),
}));

vi.mock('../lib/jobs/job-tracker.js', () => ({
  addTrackedJob: async (opts: { queue: { name: string }; jobName: string; data: unknown }) => {
    mocks.addedJobs.push({ queue: opts.queue.name, jobName: opts.jobName, data: opts.data });
    return { bullJobId: 'bull-job-1', trackerRowId: 'tracker-1' };
  },
}));

function makeApp(mountRouter: (a: express.Express) => void) {
  const app = express();
  app.use(express.json());
  mountRouter(app);
  return app;
}

function startServer(app: express.Express) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Install a supabase stub that serves the chapter row on first `.single()` and
 *  the project row on second, both with the configured outcome. */
function installContentStub() {
  const calls: string[] = [];
  mocks.supabaseStub.from = vi.fn((table: string) => {
    calls.push(table);
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.single = vi.fn(async () => {
      if (table === 'published_content_v2') {
        return mocks.chapterRow
          ? { data: mocks.chapterRow, error: null }
          : { data: null, error: { code: 'PGRST116' } };
      }
      if (table === 'writing_projects_v2') {
        return mocks.projectRow
          ? { data: mocks.projectRow, error: null }
          : { data: null, error: { code: 'PGRST116' } };
      }
      return { data: null, error: { code: 'UNKNOWN' } };
    });
    return chain;
  }) as unknown as typeof mocks.supabaseStub.from;
}

beforeEach(() => {
  mocks.addedJobs = [];
  mocks.chapterRow = null;
  mocks.projectRow = null;
  process.env.N8N_HUB_WEBHOOK_URL = 'https://n8n.test/webhook/author_request_dev';
  installContentStub();
});

describe('POST /api/content/:id/rewrite-with-research', () => {
  it('401 without bearer', async () => {
    const { contentActionsRouter } = await import('../routes/content-actions.js');
    const app = makeApp((a) => a.use('/api/content', contentActionsRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/content/abc/rewrite-with-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ research_focus: 'reconcile character identity in chapter 7' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('400 when research_focus is too short', async () => {
    const { contentActionsRouter } = await import('../routes/content-actions.js');
    const app = makeApp((a) => a.use('/api/content', contentActionsRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/content/abc/rewrite-with-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +user' },
        body: JSON.stringify({ research_focus: 'short' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('404 when chapter does not exist or is not mine', async () => {
    mocks.chapterRow = null;
    const { contentActionsRouter } = await import('../routes/content-actions.js');
    const app = makeApp((a) => a.use('/api/content', contentActionsRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/content/nonexistent/rewrite-with-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +user' },
        body: JSON.stringify({ research_focus: 'reconcile character identity in chapter 7' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('400 when content_type is not chapter', async () => {
    mocks.chapterRow = {
      id: 'abc',
      user_id: '+user',
      chapter_number: null,
      content_type: 'blog_post',
      project_id: 'proj-1',
    };
    const { contentActionsRouter } = await import('../routes/content-actions.js');
    const app = makeApp((a) => a.use('/api/content', contentActionsRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/content/abc/rewrite-with-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +user' },
        body: JSON.stringify({ research_focus: 'reconcile character identity in chapter 7' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_A_CHAPTER');
    } finally {
      await s.close();
    }
  });

  it('202 and enqueues heavy-ops job on happy path', async () => {
    mocks.chapterRow = {
      id: 'ch-abc',
      user_id: '+user',
      chapter_number: '7',
      content_type: 'chapter',
      project_id: 'proj-1',
    };
    mocks.projectRow = { title: 'The Invisible Wall', project_type: 'story' };

    const { contentActionsRouter } = await import('../routes/content-actions.js');
    const app = makeApp((a) => a.use('/api/content', contentActionsRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/content/ch-abc/rewrite-with-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer +user' },
        body: JSON.stringify({
          research_focus: 'reconcile Lucia character identity and timeline with chapters 1-2',
          use_qa_report: true,
          citation_mode: 'auto',
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { success: boolean; jobId?: string; queue?: string };
      expect(body.success).toBe(true);
      expect(body.jobId).toBe('bull-job-1');
      expect(body.queue).toBe('heavy-ops');
      expect(mocks.addedJobs).toHaveLength(1);
      const job = mocks.addedJobs[0];
      expect(job.queue).toBe('heavy-ops');
      expect(job.jobName).toBe('rewrite_chapter_with_research');
      const jobData = job.data as { body: { user_message_request: string } };
      expect(jobData.body.user_message_request).toContain('rewrite_chapter_with_research');
      expect(jobData.body.user_message_request).toContain('The Invisible Wall');
      expect(jobData.body.user_message_request).toContain('chapter 7');
    } finally {
      await s.close();
    }
  });
});
