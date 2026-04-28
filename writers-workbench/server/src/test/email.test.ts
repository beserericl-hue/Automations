/**
 * Tests for the Postal email client + /api/email/send route.
 *
 * fetch is stubbed; no real network. Validates:
 *   - DRY_RUN_EMAIL short-circuits the Postal call
 *   - Real call hits the right URL with X-Server-API-Key header
 *   - Postal error responses are surfaced as ok:false
 *   - Route: 401 without X-Email-Secret
 *   - Route: 400 on validation errors
 *   - Route: 429 when per-user rate limit trips
 *   - Route: 200 with message_id on success
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const realFetch = globalThis.fetch;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
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

beforeEach(() => {
  delete process.env.DRY_RUN_EMAIL;
  process.env.POSTAL_API_URL = 'https://postal-admin.example.test/api/v1';
  process.env.POSTAL_API_KEY = 'test-api-key';
  process.env.SENDER_EMAIL = 'eve@example.test';
  process.env.SENDER_NAME = 'Test Sender';
  process.env.REPLY_TO_EMAIL = 'support@example.test';
  process.env.EMAIL_SECRET = 'test-shared-secret';
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { __resetRateLimiterForTest } = await import('../routes/email.js');
  __resetRateLimiterForTest();
});

// --------------------------------------------------------------------
// lib/email.ts

describe('sendEmail (lib)', () => {
  it('DRY_RUN_EMAIL=true short-circuits without calling fetch', async () => {
    process.env.DRY_RUN_EMAIL = 'true';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendEmail } = await import('../lib/email.js');
    const result = await sendEmail({
      to: 'dest@example.test',
      subject: 'hi',
      html: '<p>hi</p>',
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('dry-run');
    expect(result.messageId).toMatch(/^dry-run-/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to Postal with the expected URL and headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { message_id: 'msg-123' } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendEmail } = await import('../lib/email.js');
    const result = await sendEmail({
      to: 'dest@example.test',
      subject: 'hi',
      html: '<p>hi</p>',
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sent');
    expect(result.messageId).toBe('msg-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://postal-admin.example.test/api/v1/send/message');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['X-Server-API-Key']).toBe('test-api-key');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.to).toEqual(['dest@example.test']);
    expect(body.subject).toBe('hi');
    expect(body.html_body).toBe('<p>hi</p>');
    expect(body.from).toBe('Test Sender <eve@example.test>');
    expect(body.reply_to).toBe('support@example.test');
  });

  it('returns ok:false when Postal returns status=error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', message: 'ValidationError' }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendEmail } = await import('../lib/email.js');
    const result = await sendEmail({ to: 'a@b.com', subject: 's', html: '<p/>' });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.error).toContain('ValidationError');
  });

  it('returns ok:false on HTTP 4xx/5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendEmail } = await import('../lib/email.js');
    const result = await sendEmail({ to: 'a@b.com', subject: 's', html: '<p/>' });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.error).toContain('500');
  });

  it('base64 attachments pass through to Postal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { message_id: 'msg-att' } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendEmail } = await import('../lib/email.js');
    await sendEmail({
      to: 'a@b.com',
      subject: 's',
      html: '<p/>',
      attachments: [{ name: 'x.pdf', contentType: 'application/pdf', data: 'YmFzZTY0' }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toEqual([{ name: 'x.pdf', content_type: 'application/pdf', data: 'YmFzZTY0' }]);
  });
});

// --------------------------------------------------------------------
// routes/email.ts

describe('POST /api/email/send', () => {
  it('401 when X-Email-Secret header is missing', async () => {
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const res = await realFetch(`http://localhost:${s.port}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'a@b.com', subject: 's', html: '<p/>' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('401 when X-Email-Secret is wrong', async () => {
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const res = await realFetch(`http://localhost:${s.port}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'wrong' },
        body: JSON.stringify({ to: 'a@b.com', subject: 's', html: '<p/>' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('400 on invalid body (missing required fields)', async () => {
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const res = await realFetch(`http://localhost:${s.port}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'test-shared-secret' },
        body: JSON.stringify({ subject: 'missing to' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('200 + message_id on valid send (dry-run)', async () => {
    process.env.DRY_RUN_EMAIL = 'true';
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const res = await realFetch(`http://localhost:${s.port}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'test-shared-secret' },
        body: JSON.stringify({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>', user_id: 'u1' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; message_id: string; mode: string };
      expect(body.success).toBe(true);
      expect(body.mode).toBe('dry-run');
      expect(body.message_id).toMatch(/^dry-run-/);
    } finally {
      await s.close();
    }
  });

  it('429 when the same user_id exceeds the per-minute rate limit', async () => {
    process.env.DRY_RUN_EMAIL = 'true';
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const makeCall = () =>
        realFetch(`http://localhost:${s.port}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'test-shared-secret' },
          body: JSON.stringify({ to: 'a@b.com', subject: 's', html: '<p/>', user_id: 'ratelimited-user' }),
        });

      // First 30 calls succeed
      for (let i = 0; i < 30; i++) {
        const r = await makeCall();
        expect(r.status).toBe(200);
      }

      // 31st is rate limited
      const r31 = await makeCall();
      expect(r31.status).toBe(429);
      expect(r31.headers.get('retry-after')).toBeTruthy();
    } finally {
      await s.close();
    }
  });

  it('rate limit is per user_id (different users do not share quota)', async () => {
    process.env.DRY_RUN_EMAIL = 'true';
    const { emailRouter } = await import('../routes/email.js');
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);
    try {
      const makeCall = (user_id: string) =>
        realFetch(`http://localhost:${s.port}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'test-shared-secret' },
          body: JSON.stringify({ to: 'a@b.com', subject: 's', html: '<p/>', user_id }),
        });

      // Exhaust user A
      for (let i = 0; i < 30; i++) await makeCall('userA');
      expect((await makeCall('userA')).status).toBe(429);
      // User B has its own quota
      expect((await makeCall('userB')).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('502 when Postal rejects the send', async () => {
    // Force real call path and stub fetch to return Postal error
    delete process.env.DRY_RUN_EMAIL;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', message: 'AccessDenied' }), { status: 200 }),
    );
    // For /api/email/send itself we need real fetch to reach the server.
    // So we only stub it AFTER we send the HTTP request — i.e. inject via
    // module-level global at the time the route runs. Simpler: go through
    // the route-under-test by calling it locally.
    const { emailRouter, __resetRateLimiterForTest } = await import('../routes/email.js');
    __resetRateLimiterForTest();
    const app = makeApp();
    app.use('/api/email', emailRouter);
    const s = startServer(app);

    // Install fetch dispatcher: localhost → real, everything else → mock
    globalThis.fetch = ((url: unknown, init?: unknown) => {
      const u = typeof url === 'string' ? url : String(url);
      if (u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')) {
        return realFetch(url as string, init as RequestInit);
      }
      return fetchMock(url, init);
    }) as unknown as typeof fetch;

    try {
      const res = await realFetch(`http://localhost:${s.port}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Email-Secret': 'test-shared-secret' },
        body: JSON.stringify({ to: 'a@b.com', subject: 's', html: '<p/>', user_id: 'err-user' }),
      });
      expect(res.status).toBe(502);
    } finally {
      await s.close();
    }
  });
});
