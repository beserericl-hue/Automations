/**
 * GET /api/newsletter/view/:editionId/:sendDate — public "view in browser".
 *
 * Serves newsletter_sends_v2.html_body as text/html so the email permalink renders
 * (Supabase Storage force-serves user HTML as text/plain, so a storage URL can't).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const mocks = vi.hoisted(() => ({ row: null as null | { html_body: string; subject: string } }));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: mocks.row, error: null }));
    return { from: vi.fn(() => chain) };
  },
}));

async function server() {
  const { newsletterRouter } = await import('../routes/newsletter.js');
  const app = express();
  app.use('/api/newsletter', newsletterRouter);
  const s = app.listen(0);
  const addr = s.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, close: () => new Promise<void>((r) => s.close(() => r())) };
}

beforeEach(() => {
  mocks.row = null;
});

describe('GET /api/newsletter/view/:editionId/:sendDate', () => {
  it('serves html_body as text/html', async () => {
    mocks.row = { html_body: '<!doctype html><h1>Hello</h1>', subject: 'S' };
    const s = await server();
    try {
      const res = await fetch(`http://localhost:${s.port}/api/newsletter/view/ai-news/2026-05-31`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<h1>Hello</h1>');
    } finally {
      await s.close();
    }
  });

  it('400s on a malformed send date', async () => {
    const s = await server();
    try {
      const res = await fetch(`http://localhost:${s.port}/api/newsletter/view/ai-news/not-a-date`);
      expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('404s (as html) when no send exists', async () => {
    mocks.row = null;
    const s = await server();
    try {
      const res = await fetch(`http://localhost:${s.port}/api/newsletter/view/ai-news/2026-05-31`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
    } finally {
      await s.close();
    }
  });
});
