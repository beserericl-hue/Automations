/**
 * F2-9: POST /api/newsletter/cron/editions/run-due — backend-aware cadence trigger.
 * Computes due editions and enqueues each via the engine (NEWSLETTER_BACKEND=python)
 * or the n8n compose webhook.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// --- minimal Supabase admin fake: editions table + per-edition last-send lookup ---
interface Edition { id: string; user_id: string; cadence: string; cadence_send_time: string | null; created_at: string }
let editionsRows: Edition[] = [];
let lastSendByEdition: Record<string, { created_at: string } | null> = {};

vi.mock('../services/supabase-admin.js', () => {
  const makeBuilder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select() { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      neq() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      // editions list resolves the whole query (awaited directly)
      then(resolve: (v: unknown) => void) {
        if (table === 'newsletter_editions_v2') {
          resolve({ data: editionsRows, error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
      maybeSingle() {
        if (table === 'newsletter_sends_v2') {
          const eid = filters['edition_id'] as string;
          return Promise.resolve({ data: lastSendByEdition[eid] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  };
  return { getSupabaseAdmin: () => ({ from: (t: string) => makeBuilder(t) }) };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalFetch = globalThis.fetch;
let enqueueCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

const SECRET = 'test-ingest';
const ENGINE_URL = 'http://engine.internal:8000';
const WEBHOOK_URL = 'https://n8n.example/webhook/compose-newsletter-dev';

beforeEach(() => {
  editionsRows = [];
  lastSendByEdition = {};
  enqueueCalls = [];
  process.env.INGESTION_SECRET = SECRET;
  process.env.NEWSLETTER_SERVICE_URL = ENGINE_URL;
  process.env.SERVICE_SHARED_SECRET = 'svc-secret';
  process.env.N8N_NEWSLETTER_WEBHOOK_URL = WEBHOOK_URL;
  delete process.env.NEWSLETTER_BACKEND;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    enqueueCalls.push({ url, headers: (init?.headers as Record<string, string>) || {}, body: String(init?.body ?? '') });
    if (url.includes('/internal/newsletter/generate')) {
      return new Response(JSON.stringify({ execution_id: 'eng-exec-1', result: 'queued' }), { status: 200 });
    }
    if (url === WEBHOOK_URL) {
      return new Response(JSON.stringify({ executionId: 'n8n-exec-1' }), { status: 200 });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
});

afterAll(() => { globalThis.fetch = originalFetch; });

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter-edition-extras.js');
  const app = express();
  app.use(express.json());
  app.use('/api/newsletter/cron', mod.editionExtrasCronRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

const longAgo = '2026-01-01T00:00:00Z';

describe('POST /cron/editions/run-due (F2-9)', () => {
  it('401s without the ingestion secret', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/cron/editions/run-due`, { method: 'POST' });
      expect(r.status).toBe(401);
    });
  });

  it('enqueues due editions via the engine when NEWSLETTER_BACKEND=python', async () => {
    process.env.NEWSLETTER_BACKEND = 'python';
    editionsRows = [{ id: 'ai-news', user_id: '+1', cadence: 'daily', cadence_send_time: null, created_at: longAgo }];
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/cron/editions/run-due`, {
        method: 'POST', headers: { 'X-Ingestion-Secret': SECRET },
      });
      const j = await r.json() as { backend: string; due: number; enqueued: number; results: Array<{ enqueued: boolean; execution_id?: string }> };
      expect(j.backend).toBe('python');
      expect(j.due).toBe(1);
      expect(j.enqueued).toBe(1);
      expect(j.results[0].execution_id).toBe('eng-exec-1');
      expect(enqueueCalls.some((c) => c.url.includes('/internal/newsletter/generate'))).toBe(true);
      expect(enqueueCalls.every((c) => !c.url.includes('/webhook/'))).toBe(true);
    });
  });

  it('enqueues via the n8n webhook by default (n8n backend)', async () => {
    editionsRows = [{ id: 'ai-news', user_id: '+1', cadence: 'weekly', cadence_send_time: null, created_at: longAgo }];
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/cron/editions/run-due`, {
        method: 'POST', headers: { 'X-Ingestion-Secret': SECRET },
      });
      const j = await r.json() as { backend: string; enqueued: number };
      expect(j.backend).toBe('n8n');
      expect(j.enqueued).toBe(1);
      expect(enqueueCalls.some((c) => c.url === WEBHOOK_URL)).toBe(true);
    });
  });

  it('skips editions that are not yet due', async () => {
    editionsRows = [{ id: 'ai-news', user_id: '+1', cadence: 'monthly', cadence_send_time: null, created_at: new Date().toISOString() }];
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/cron/editions/run-due`, {
        method: 'POST', headers: { 'X-Ingestion-Secret': SECRET },
      });
      const j = await r.json() as { due: number; enqueued: number };
      expect(j.due).toBe(0);
      expect(j.enqueued).toBe(0);
    });
  });
});
