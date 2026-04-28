import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// -----------------------------------------------------------------------------
// In-memory Supabase admin fake — covers exactly the chain the newsletter
// router uses (.from().select().eq().eq().eq().order(...).maybeSingle()/promise).
// -----------------------------------------------------------------------------

interface FakeEdition {
  id: string;
  display_name: string;
  subheader: string;
  genre: string;
  description: string | null;
  newsletter_name: string;
  primary_color: string;
  paper_color: string;
  enabled: boolean;
  user_id: string;
  created_at: string;
  updated_at: string;
}

interface FakeSend {
  id: string;
  user_id: string;
  send_date: string;
  edition_id: string | null;
  markdown_body: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
}

interface FakeState {
  editions: FakeEdition[];
  sends: FakeSend[];
  forceEditionsError?: string;
  forceSendsError?: string;
}

const state: FakeState = { editions: [], sends: [] };

function reset() {
  state.editions = [];
  state.sends = [];
  delete state.forceEditionsError;
  delete state.forceSendsError;
  // Default seed: ai-news edition owned by the test user.
  state.editions.push({
    id: 'ai-news',
    display_name: 'The Workbench',
    subheader: 'Dispatches from the Machine Room',
    genre: 'ai',
    description: null,
    newsletter_name: 'A CourseworxAI Weekly',
    primary_color: '#14288c',
    paper_color: '#fbf8f2',
    enabled: true,
    user_id: TEST_USER,
    created_at: '2026-04-25T00:00:00Z',
    updated_at: '2026-04-25T00:00:00Z',
  });
}

function buildSelectBuilder<T>(rowsFn: () => T[], errorFn: () => string | undefined) {
  const filters: Record<string, unknown> = {};
  const notFilters: Record<string, unknown> = {};
  let limitN: number | undefined;
  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    neq(col: string, val: unknown) { notFilters[col] = val; return builder; },
    order() { return builder; },
    limit(n: number) { limitN = n; return builder; },
    maybeSingle() {
      const err = errorFn();
      if (err) return Promise.resolve({ data: null, error: { message: err, code: '99' } });
      const matches = rowsFn().filter((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const k of Object.keys(notFilters)) {
          if ((r as unknown as Record<string, unknown>)[k] === notFilters[k]) return false;
        }
        return true;
      });
      return Promise.resolve({ data: matches[0] ?? null, error: null });
    },
    then(onFulfilled: (x: { data: T[] | null; error: unknown }) => unknown) {
      const err = errorFn();
      if (err) return Promise.resolve({ data: null, error: { message: err } }).then(onFulfilled);
      const matches = rowsFn().filter((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const k of Object.keys(notFilters)) {
          if ((r as unknown as Record<string, unknown>)[k] === notFilters[k]) return false;
        }
        return true;
      });
      const limited = limitN ? matches.slice(0, limitN) : matches;
      return Promise.resolve({ data: limited, error: null }).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table === 'newsletter_editions_v2') {
      return { select: () => buildSelectBuilder<FakeEdition>(() => state.editions, () => state.forceEditionsError) };
    }
    if (table === 'newsletter_sends_v2') {
      return { select: () => buildSelectBuilder<FakeSend>(() => state.sends, () => state.forceSendsError) };
    }
    throw new Error(`unexpected table: ${table}`);
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

// -----------------------------------------------------------------------------
// requireAuth fake — short-circuits to set req.userId so we don't need a real
// Supabase auth token. Mirrors what the real middleware does on success.
// -----------------------------------------------------------------------------
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// -----------------------------------------------------------------------------
// fetch mock — intercepts only calls to the n8n webhook + n8n public API URLs
// the route uses. Any other fetch (including the tests' own calls to their
// localhost test server) passes through to the real fetch.
// -----------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
let webhookResponseStatus = 200;
let webhookResponseBody: unknown = { executionId: 'exec-12345', editionId: 'ai-news' };
let webhookResponseRaw: string | null = null;
let webhookShouldThrow = false;
let executionResponseStatus = 200;
let executionResponseBody: unknown = {
  id: 'exec-12345',
  status: 'success',
  mode: 'webhook',
  startedAt: '2026-04-26T19:00:00Z',
  stoppedAt: '2026-04-26T19:25:00Z',
  data: { resultData: { lastNodeExecuted: 'final_notification' } },
};

const TEST_USER = '+14105914612';
const TEST_INGESTION_SECRET = 'test-ingestion-secret-123';
const TEST_N8N_API_KEY = 'test-n8n-api-key';
const TEST_WEBHOOK_URL = 'https://n8n.example/webhook/compose-newsletter-dev';

beforeEach(() => {
  reset();
  fetchCalls = [];
  webhookResponseStatus = 200;
  webhookResponseBody = { executionId: 'exec-12345', editionId: 'ai-news' };
  webhookResponseRaw = null;
  webhookShouldThrow = false;
  executionResponseStatus = 200;
  executionResponseBody = {
    id: 'exec-12345',
    status: 'success',
    mode: 'webhook',
    startedAt: '2026-04-26T19:00:00Z',
    stoppedAt: '2026-04-26T19:25:00Z',
    data: { resultData: { lastNodeExecuted: 'final_notification' } },
  };

  process.env.N8N_NEWSLETTER_WEBHOOK_URL = TEST_WEBHOOK_URL;
  process.env.INGESTION_SECRET = TEST_INGESTION_SECRET;
  process.env.N8N_API_KEY = TEST_N8N_API_KEY;
  process.env.N8N_API_URL = 'https://n8n.example';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === TEST_WEBHOOK_URL) {
      if (webhookShouldThrow) throw new Error('network down');
      const body = typeof init?.body === 'string' ? init.body : '';
      const headers = (init?.headers as Record<string, string>) || {};
      fetchCalls.push({ url, method: init?.method || 'GET', headers, body });
      const init_ = { status: webhookResponseStatus };
      if (webhookResponseRaw !== null) {
        return new Response(webhookResponseRaw, init_);
      }
      return new Response(JSON.stringify(webhookResponseBody), init_);
    }
    if (url.startsWith('https://n8n.example/api/v1/executions/')) {
      fetchCalls.push({ url, method: init?.method || 'GET', headers: (init?.headers as Record<string, string>) || {}, body: '' });
      return new Response(JSON.stringify(executionResponseBody), { status: executionResponseStatus });
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/newsletter', mod.newsletterRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Newsletter editions endpoint (S2)', () => {
  it('returns the seeded edition for the authenticated user', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions`);
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; editions: Array<{ id: string; display_name: string }> };
      expect(j.success).toBe(true);
      expect(j.editions).toHaveLength(1);
      expect(j.editions[0].id).toBe('ai-news');
      expect(j.editions[0].display_name).toBe('The Workbench');
    });
  });

  it('does not return editions owned by other users', async () => {
    state.editions.push({
      id: 'romance-rec',
      display_name: 'Other Edition',
      subheader: 'x', genre: 'romance', description: null, newsletter_name: 'Other',
      primary_color: '#000', paper_color: '#fff', enabled: true,
      user_id: '+19999999999',
      created_at: '2026-04-25T00:00:00Z', updated_at: '2026-04-25T00:00:00Z',
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions`);
      const j = await r.json() as { editions: Array<{ id: string }> };
      expect(j.editions.map((e) => e.id)).toEqual(['ai-news']);
    });
  });

  it('does not return disabled editions', async () => {
    state.editions[0].enabled = false;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions`);
      const j = await r.json() as { editions: unknown[] };
      expect(j.editions).toHaveLength(0);
    });
  });
});

describe('Last-sent markdown endpoint (S2)', () => {
  it('returns null when the edition has no prior sends', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions/ai-news/last-sent-markdown`);
      expect(r.status).toBe(200);
      const j = await r.json() as { markdown: string | null };
      expect(j.markdown).toBeNull();
    });
  });

  it('returns the latest send markdown', async () => {
    state.sends.push({
      id: 's1', user_id: TEST_USER, send_date: '2026-04-25', edition_id: 'ai-news',
      markdown_body: '# Yesterday\n\nbody', status: 'sent',
      sent_at: '2026-04-25T08:00:00Z', created_at: '2026-04-25T07:00:00Z',
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions/ai-news/last-sent-markdown`);
      const j = await r.json() as { markdown: string };
      expect(j.markdown).toContain('# Yesterday');
    });
  });

  it('returns 400 for malformed edition id', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions/Not%20A%20Slug/last-sent-markdown`);
      expect(r.status).toBe(400);
    });
  });

  it('returns 404 for unknown edition', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/editions/nope/last-sent-markdown`);
      expect(r.status).toBe(404);
    });
  });
});

describe('Generate endpoint (S2)', () => {
  it('proxies the n8n webhook with the right headers and body, returns synchronous executionId', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edition_id: 'ai-news',
          send_date: '2026-04-26',
          previous_newsletter_content: '# prior\nbody',
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; executionId: string; editionId: string; started: boolean };
      expect(j.success).toBe(true);
      expect(j.executionId).toBe('exec-12345');
      expect(j.editionId).toBe('ai-news');
      expect(j.started).toBe(true);

      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0];
      expect(call.url).toBe(TEST_WEBHOOK_URL);
      expect(call.method).toBe('POST');
      expect(call.headers['X-Ingestion-Secret']).toBe(TEST_INGESTION_SECRET);
      expect(call.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(call.body);
      expect(body['Date']).toBe('2026-04-26');
      expect(body['Previous Newsletter Content']).toBe('# prior\nbody');
      expect(body['Edition Id']).toBe('ai-news');
    });
  });

  it('rejects body with bad send_date format (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'ai-news', send_date: 'not-a-date' }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('returns 404 for unknown edition', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'no-such-edition', send_date: '2026-04-26' }),
      });
      expect(r.status).toBe(404);
    });
  });

  it('returns 500 NOT_CONFIGURED when N8N_NEWSLETTER_WEBHOOK_URL is unset', async () => {
    delete process.env.N8N_NEWSLETTER_WEBHOOK_URL;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'ai-news', send_date: '2026-04-26' }),
      });
      expect(r.status).toBe(500);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('NOT_CONFIGURED');
    });
  });

  it('returns 502 when n8n returns non-2xx', async () => {
    webhookResponseStatus = 500;
    webhookResponseRaw = 'oh no';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'ai-news', send_date: '2026-04-26' }),
      });
      expect(r.status).toBe(502);
    });
  });

  it('returns 502 with UPSTREAM_MISSING_EXECUTION_ID when n8n response lacks executionId', async () => {
    webhookResponseBody = { editionId: 'ai-news' };
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'ai-news', send_date: '2026-04-26' }),
      });
      expect(r.status).toBe(502);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('UPSTREAM_MISSING_EXECUTION_ID');
    });
  });

  it('returns 502 when n8n fetch throws', async () => {
    webhookShouldThrow = true;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: 'ai-news', send_date: '2026-04-26' }),
      });
      expect(r.status).toBe(502);
    });
  });
});

describe('Execution status proxy (S2)', () => {
  it('strips n8n response to the documented shape', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-12345/status`);
      expect(r.status).toBe(200);
      const j = await r.json() as Record<string, unknown>;
      expect(j.success).toBe(true);
      expect(j.executionId).toBe('exec-12345');
      expect(j.status).toBe('success');
      expect(j.mode).toBe('webhook');
      expect(j.startedAt).toBe('2026-04-26T19:00:00Z');
      expect(j.stoppedAt).toBe('2026-04-26T19:25:00Z');
      expect(j.lastNodeExecuted).toBe('final_notification');
      // Should NOT include n8n's full data payload
      expect(j.data).toBeUndefined();
    });
  });

  it('rejects bad execution id (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/${encodeURIComponent('!!!bad!!!')}/status`);
      expect(r.status).toBe(400);
    });
  });

  it('returns 404 when n8n returns 404', async () => {
    executionResponseStatus = 404;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/missing/status`);
      expect(r.status).toBe(404);
    });
  });

  it('returns 502 when n8n returns 5xx', async () => {
    executionResponseStatus = 503;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-12345/status`);
      expect(r.status).toBe(502);
    });
  });

  it('returns 500 NOT_CONFIGURED when N8N_API_KEY is missing', async () => {
    delete process.env.N8N_API_KEY;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/execution/exec-12345/status`);
      expect(r.status).toBe(500);
    });
  });
});

// -----------------------------------------------------------------------------
// S3 — Stage-emit callback (POST /api/callback/newsletter-stage)
//
// Auth: shared-secret header X-Callback-Secret matching NEWSLETTER_CALLBACK_SECRET.
// Side effect: publishes a `newsletter.stage` SSE event to the user's channel.
//
// We build a separate mini-app that mounts ONLY the callback router so we
// don't exercise requireAuth on this path (the callback never sees a JWT).
// publishSseEvent is mocked to capture broadcasts in-memory rather than
// requiring Redis or a real EventEmitter subscriber.
// -----------------------------------------------------------------------------

const TEST_CALLBACK_SECRET = 'test-callback-secret-456';

const sseBroadcasts: Array<{ userId: string; event: Record<string, unknown> }> = [];
vi.mock('../lib/sse-pubsub.js', () => ({
  publishSseEvent: async (userId: string, event: Record<string, unknown>) => {
    sseBroadcasts.push({ userId, event });
    return 1;
  },
  subscribeSseEvents: async () => async () => undefined,
  closeSsePubsub: async () => undefined,
  resetSsePubsubForTest: () => undefined,
}));

async function withCallbackServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/callback', mod.newsletterCallbackRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

describe('Stage callback endpoint (S3)', () => {
  beforeEach(() => {
    sseBroadcasts.length = 0;
    process.env.NEWSLETTER_CALLBACK_SECRET = TEST_CALLBACK_SECRET;
  });

  it('accepts a valid POST and broadcasts a newsletter.stage event', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'gathering',
          detail: 'started ingestion search',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; broadcast: number };
      expect(j.success).toBe(true);
      expect(j.broadcast).toBe(1);

      expect(sseBroadcasts).toHaveLength(1);
      expect(sseBroadcasts[0].userId).toBe(TEST_USER);
      expect(sseBroadcasts[0].event.event).toBe('newsletter.stage');
      const data = sseBroadcasts[0].event.data as Record<string, unknown>;
      expect(data.stage).toBe('gathering');
      expect(data.executionId).toBe('exec-99');
      expect(data.editionId).toBe('ai-news');
      expect(data.detail).toBe('started ingestion search');
    });
  });

  it('returns 401 when X-Callback-Secret is missing', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'gathering',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(401);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('returns 401 when X-Callback-Secret is wrong', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': 'wrong',
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'gathering',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(401);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('returns 500 MISCONFIGURED when NEWSLETTER_CALLBACK_SECRET is unset', async () => {
    delete process.env.NEWSLETTER_CALLBACK_SECRET;
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'gathering',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(500);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('returns 400 when stage is not one of the whitelist values', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'NOT_A_STAGE',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(400);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('returns 400 when required fields are missing', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({ stage: 'gathering' }),
      });
      expect(r.status).toBe(400);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('returns 400 when ts is not a valid ISO datetime', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'gathering',
          ts: 'yesterday',
        }),
      });
      expect(r.status).toBe(400);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('accepts an empty detail (defaults to "")', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'segments_done',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(200);
      const data = sseBroadcasts[0].event.data as Record<string, unknown>;
      expect(data.detail).toBe('');
    });
  });

  it('accepts the "error" overlay stage', async () => {
    await withCallbackServer(async (base) => {
      const r = await fetch(`${base}/api/callback/newsletter-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callback-Secret': TEST_CALLBACK_SECRET,
        },
        body: JSON.stringify({
          userId: TEST_USER,
          executionId: 'exec-99',
          editionId: 'ai-news',
          stage: 'error',
          detail: 'pick_top_stories failed: Claude API 503',
          ts: '2026-04-26T20:00:00.000Z',
        }),
      });
      expect(r.status).toBe(200);
      const data = sseBroadcasts[0].event.data as Record<string, unknown>;
      expect(data.stage).toBe('error');
      expect(String(data.detail)).toContain('Claude API 503');
    });
  });
});

// -----------------------------------------------------------------------------
// S6 — GET /api/newsletter/sends
// Powers the Home page's "Next scheduled" tile and the "Recent runs" table.
// -----------------------------------------------------------------------------

describe('GET /api/newsletter/sends (S6)', () => {
  beforeEach(() => {
    state.sends.push(
      { id: 's1', user_id: TEST_USER,         send_date: '2026-04-25', edition_id: 'ai-news', markdown_body: null, status: 'sent',      sent_at: '2026-04-25T08:00:00Z', created_at: '2026-04-25T07:00:00Z' },
      { id: 's2', user_id: TEST_USER,         send_date: '2026-04-26', edition_id: 'ai-news', markdown_body: null, status: 'scheduled', sent_at: null,                    created_at: '2026-04-25T22:00:00Z' },
      { id: 's3', user_id: TEST_USER,         send_date: '2026-04-26', edition_id: 'ai-news', markdown_body: null, status: 'failed',    sent_at: null,                    created_at: '2026-04-26T02:00:00Z' },
      { id: 's4', user_id: '+19999999999',    send_date: '2026-04-26', edition_id: 'romance', markdown_body: null, status: 'sent',      sent_at: '2026-04-26T08:00:00Z', created_at: '2026-04-26T07:00:00Z' },
    );
  });

  it('returns the caller\'s sends only', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends`);
      expect(r.status).toBe(200);
      const j = await r.json() as { sends: Array<{ id: string; user_id: string }> };
      expect(j.sends.every((s) => s.user_id === TEST_USER)).toBe(true);
      expect(j.sends.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
    });
  });

  it('filters by status=scheduled with limit=1 (Next scheduled tile pattern)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends?status=scheduled&limit=1`);
      const j = await r.json() as { sends: Array<{ id: string; status: string }> };
      expect(j.sends).toHaveLength(1);
      expect(j.sends[0].id).toBe('s2');
      expect(j.sends[0].status).toBe('scheduled');
    });
  });

  it('limit param caps the response', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends?limit=2`);
      const j = await r.json() as { sends: unknown[] };
      expect(j.sends.length).toBeLessThanOrEqual(2);
    });
  });

  it('rejects bad status value (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends?status=NOT_A_REAL_STATUS`);
      expect(r.status).toBe(400);
    });
  });

  it('rejects out-of-range limit (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends?limit=999`);
      expect(r.status).toBe(400);
    });
  });

  it('filters by edition_id', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/sends?edition_id=ai-news`);
      const j = await r.json() as { sends: Array<{ id: string }> };
      expect(j.sends.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
    });
  });
});
