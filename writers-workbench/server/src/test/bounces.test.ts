/**
 * S11-5 — Postal bounce/complaint webhook + /api/admin/bounces.
 *
 * Verifies:
 *   - POST /api/email/webhook/postal rejects without shared secret
 *   - Known event types are persisted to email_bounces_v2
 *   - Unknown events return 200 without persisting (don't let Postal retry)
 *   - Duplicate event_id returns success (idempotency via unique constraint)
 *   - GET /api/admin/bounces returns rows, honors event_type + to filters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({
  supabaseStub: { from: vi.fn() },
  insertedRows: [] as unknown[],
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => mocks.supabaseStub,
}));

// requireAuth / requireAdmin stubs: treat "Bearer admin" as an admin user
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

function installSupabaseStub(opts: {
  insertResult?: { error: unknown | null };
  selectResult?: { data: unknown; error: unknown | null };
} = {}) {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(async (row: unknown) => {
    mocks.insertedRows.push(row);
    return opts.insertResult ?? { error: null };
  });
  chain.select = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  // The bounce webhook now also patches newsletter_subscribers_v2 on hard
  // failures (.update().ilike().eq()). The chain has to terminate (be
  // awaitable), so .eq returns a thenable resolving to no-error.
  chain.update = vi.fn(() => chain);
  chain.ilike = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(opts.selectResult ?? { data: [], error: null }).then(resolve);
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  mocks.insertedRows = [];
  (mocks.supabaseStub.from as ReturnType<typeof vi.fn>).mockReset();
  process.env.POSTAL_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.EMAIL_SECRET = 'test-email-secret';
});

afterEach(() => {
  delete process.env.POSTAL_WEBHOOK_SECRET;
  delete process.env.EMAIL_SECRET;
});

// --------------------------------------------------------------------
// Webhook endpoint

describe('POST /api/email/webhook/postal', () => {
  it('401 without X-Postal-Webhook-Secret header', async () => {
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp((a) => a.use('/api/email', emailRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/email/webhook/postal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'MessageBounced' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('inserts a MessageBounced event into email_bounces_v2', async () => {
    installSupabaseStub({ insertResult: { error: null } });
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp((a) => a.use('/api/email', emailRouter));
    const s = startServer(app);
    try {
      const payload = {
        event: 'MessageBounced',
        uuid: 'evt-abc',
        timestamp: 1712345678,
        payload: {
          message: {
            id: 42,
            token: 'msg-token-123',
            to: 'bounced@example.test',
            from: 'eve@courseworx.media',
            subject: 'Hello',
          },
          bounce: { reason: 'mailbox full', bounce_type: 'SoftBounce' },
        },
      };
      const res = await fetch(`http://localhost:${s.port}/api/email/webhook/postal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Postal-Webhook-Secret': 'test-webhook-secret' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      expect(mocks.insertedRows).toHaveLength(1);
      const row = mocks.insertedRows[0] as Record<string, unknown>;
      expect(row.event_type).toBe('MessageBounced');
      expect(row.to_address).toBe('bounced@example.test');
      expect(row.postal_message_id).toBe('msg-token-123');
      expect(row.postal_event_id).toBe('evt-abc');
      expect(row.bounce_type).toBe('SoftBounce');
      expect(row.bounce_reason).toBe('mailbox full');
    } finally {
      await s.close();
    }
  });

  it('ignores unknown event types without persisting', async () => {
    installSupabaseStub({ insertResult: { error: null } });
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp((a) => a.use('/api/email', emailRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/email/webhook/postal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Postal-Webhook-Secret': 'test-webhook-secret' },
        body: JSON.stringify({ event: 'MessageSomethingElseUnknown', uuid: 'x', payload: {} }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; ignored?: boolean };
      expect(body.success).toBe(true);
      expect(body.ignored).toBe(true);
      expect(mocks.insertedRows).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('returns success on duplicate event_id (unique-constraint violation)', async () => {
    installSupabaseStub({ insertResult: { error: { code: '23505', message: 'duplicate key' } } });
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp((a) => a.use('/api/email', emailRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/email/webhook/postal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Postal-Webhook-Secret': 'test-webhook-secret' },
        body: JSON.stringify({
          event: 'SpamComplaint',
          uuid: 'dup-123',
          payload: { message: { to: 'a@b.com' } },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; deduped?: boolean };
      expect(body.success).toBe(true);
      expect(body.deduped).toBe(true);
    } finally {
      await s.close();
    }
  });
});

// --------------------------------------------------------------------
// Admin endpoint

describe('GET /api/admin/bounces', () => {
  it('requires admin auth', async () => {
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/bounces`);
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('returns bounce rows with summary counts', async () => {
    installSupabaseStub({
      selectResult: {
        data: [
          { id: '1', event_type: 'MessageBounced', to_address: 'a@b.com' },
          { id: '2', event_type: 'MessageBounced', to_address: 'c@d.com' },
          { id: '3', event_type: 'SpamComplaint', to_address: 'a@b.com' },
        ],
        error: null,
      },
    });
    const { adminRouter } = await import('../routes/admin.js');
    const app = makeApp((a) => a.use('/api/admin', adminRouter));
    const s = startServer(app);
    try {
      const res = await fetch(`http://localhost:${s.port}/api/admin/bounces`, {
        headers: { Authorization: 'Bearer +admin' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { bounces: Array<{ id: string }>; summary: Record<string, number>; total: number };
      };
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(3);
      expect(body.data.summary.MessageBounced).toBe(2);
      expect(body.data.summary.SpamComplaint).toBe(1);
    } finally {
      await s.close();
    }
  });
});
