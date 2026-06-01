/**
 * F2-8: GET /api/newsletter/execution/:id/status proxies to the Writer Engine
 * (gateway saga-state) when NEWSLETTER_BACKEND=python, instead of the n8n public API.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// Auth fake — set req.userId without a real JWT.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = '+14105914612';
    next();
  },
}));

// supabase-admin is imported at module load by routes/newsletter.ts; stub it so import succeeds.
vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => ({}),
}));

const ENGINE_URL = 'http://writer-engine-gateway.railway.internal:8000';
const SECRET = 'test-shared-secret';

const originalFetch = globalThis.fetch;
let lastEngineCall: { url: string; headers: Record<string, string> } | null = null;
let n8nCalled = false;
let engineStatePayload: unknown = { stage: 'awaiting_stories_approval', status: 'ok' };
let engineHttpStatus = 200;

beforeEach(() => {
  lastEngineCall = null;
  n8nCalled = false;
  engineStatePayload = { stage: 'awaiting_stories_approval', status: 'ok' };
  engineHttpStatus = 200;
  process.env.NEWSLETTER_BACKEND = 'python';
  process.env.NEWSLETTER_SERVICE_URL = ENGINE_URL;
  process.env.SERVICE_SHARED_SECRET = SECRET;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/internal/newsletter/executions/')) {
      lastEngineCall = { url, headers: (init?.headers as Record<string, string>) || {} };
      return new Response(JSON.stringify(engineStatePayload), { status: engineHttpStatus });
    }
    if (url.includes('/api/v1/executions/')) {
      n8nCalled = true;
      return new Response(JSON.stringify({ id: 'x', status: 'success' }), { status: 200 });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter.js');
  const app = express();
  app.use(express.json());
  app.use('/api/newsletter', mod.newsletterRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

describe('execution status — engine-backed (NEWSLETTER_BACKEND=python)', () => {
  it('reads engine saga-state, not n8n, and maps awaiting_* -> waiting', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-abc/status`);
      expect(r.status).toBe(200);
      const j = (await r.json()) as { success: boolean; status: string; mode: string; lastNodeExecuted: string };
      expect(j.success).toBe(true);
      expect(j.status).toBe('waiting');
      expect(j.mode).toBe('engine');
      expect(j.lastNodeExecuted).toBe('awaiting_stories_approval');
      expect(n8nCalled).toBe(false);
      expect(lastEngineCall?.url).toContain(`${ENGINE_URL}/internal/newsletter/executions/exec-abc/state`);
      expect(lastEngineCall?.headers['X-Service-Secret']).toBe(SECRET);
    });
  });

  it('maps saved -> success', async () => {
    engineStatePayload = { stage: 'saved', status: 'ok' };
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-abc/status`);
      const j = (await r.json()) as { status: string };
      expect(j.status).toBe('success');
    });
  });

  it('maps error -> error', async () => {
    engineStatePayload = { stage: 'error', status: 'error' };
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-abc/status`);
      const j = (await r.json()) as { status: string };
      expect(j.status).toBe('error');
    });
  });

  it('returns 404 when the engine has no such execution', async () => {
    engineHttpStatus = 404;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-missing/status`);
      expect(r.status).toBe(404);
    });
  });
});
