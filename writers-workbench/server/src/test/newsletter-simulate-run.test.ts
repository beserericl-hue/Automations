/**
 * S9 — simulate-run smoke test (server).
 *
 * Mounts only the test-only fixture router and asserts that hitting it
 * fans out the canonical 9-stage + 4-approval event vocabulary through
 * the SSE pubsub. The router itself defends "test mode only" by being
 * dynamically imported in index.ts when NODE_ENV === 'test' — here we
 * mount it directly because we're inside vitest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const broadcasts: Array<{ userId: string; event: Record<string, unknown> }> = [];

vi.mock('../lib/sse-pubsub.js', () => ({
  publishSseEvent: async (userId: string, event: Record<string, unknown>) => {
    broadcasts.push({ userId, event });
    return 1;
  },
  subscribeSseEvents: async () => async () => undefined,
  closeSsePubsub: async () => undefined,
  resetSsePubsubForTest: () => undefined,
}));

beforeEach(() => {
  broadcasts.length = 0;
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/test-newsletter.js');
  const app = express();
  app.use(express.json());
  app.use('/api/test/newsletter', mod.testNewsletterRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

describe('POST /api/test/newsletter/simulate-run', () => {
  it('emits all 9 stages + 2 approval-created + 2 approval-resolved events', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/test/newsletter/simulate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: 'exec-smoke', gapMs: 0 }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { scheduled: number };
      expect(j.scheduled).toBe(9);

      // Wait for the background fan-out to finish. With gapMs=0 it
      // schedules awaits between events but they resolve immediately;
      // a single tick is enough.
      await new Promise((r) => setTimeout(r, 100));

      // 9 stages + 2 created + 2 resolved = 13 broadcasts.
      expect(broadcasts.length).toBe(13);

      const stageEvents = broadcasts.filter((b) => b.event.event === 'newsletter.stage');
      expect(stageEvents).toHaveLength(9);
      expect(stageEvents.map((e) => (e.event.data as { stage: string }).stage)).toEqual([
        'gathering',
        'selecting_stories',
        'awaiting_stories_approval',
        'stories_approved',
        'awaiting_subject_approval',
        'subject_approved',
        'writing_segment',
        'segments_done',
        'saved',
      ]);

      const created = broadcasts.filter((b) => b.event.event === 'newsletter.approval.created');
      expect(created).toHaveLength(2);
      expect(created.map((e) => (e.event.data as { stage: string }).stage)).toEqual(['stories', 'subject_line']);

      const resolved = broadcasts.filter((b) => b.event.event === 'newsletter.approval.resolved');
      expect(resolved).toHaveLength(2);
      expect(resolved.every((e) => (e.event.data as { resumed: boolean }).resumed === true)).toBe(true);
    });
  });

  it('scopes events to the supplied executionId', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/api/test/newsletter/simulate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: 'exec-scoped', gapMs: 0 }),
      });
      await new Promise((r) => setTimeout(r, 100));
      const stageEvents = broadcasts.filter((b) => b.event.event === 'newsletter.stage');
      expect(stageEvents.every((e) => (e.event.data as { executionId: string }).executionId === 'exec-scoped')).toBe(true);
    });
  });

  it('routes events to the supplied userId', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/api/test/newsletter/simulate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: 'exec-1', userId: '+19999999999', gapMs: 0 }),
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(broadcasts.every((b) => b.userId === '+19999999999')).toBe(true);
    });
  });

  it('completes the full vocabulary within 2 seconds at default gap', async () => {
    await withServer(async (base) => {
      const start = Date.now();
      await fetch(`${base}/api/test/newsletter/simulate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: 'exec-pace' }), // default gapMs=50
      });
      // Wait for fan-out; 9 events × 50ms ≈ 450ms upper bound
      await new Promise((r) => setTimeout(r, 800));
      const elapsedMs = Date.now() - start;
      expect(broadcasts.length).toBe(13);
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  it('payloads carry the canonical user_id from the fixture by default', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/api/test/newsletter/simulate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: 'exec-default-user', gapMs: 0 }),
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(broadcasts.every((b) => b.userId === '+14105914612')).toBe(true);
    });
  });
});
