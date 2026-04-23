import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// -----------------------------------------------------------------------------
// In-memory Supabase admin fake (same pattern as ingestion.test.ts).
// Covers just the chain subset approvals.ts touches.
// -----------------------------------------------------------------------------

interface FakeApproval {
  id: string;
  token: string;
  user_id: string;
  execution_id: string;
  resume_url: string;
  stage: 'stories' | 'subject_line';
  payload: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
  decision: 'approve' | 'revise' | null;
  feedback: string | null;
}

interface FakeState {
  rows: FakeApproval[];
  validUserIds: Set<string>;
  forceInsertError?: string;
  forceLookupError?: string;
  forceUpdateError?: string;
}

const state: FakeState = {
  rows: [],
  validUserIds: new Set(['+14105914612']),
};

function reset() {
  state.rows = [];
  state.validUserIds = new Set(['+14105914612']);
  delete state.forceInsertError;
  delete state.forceLookupError;
  delete state.forceUpdateError;
}

function buildSelectBuilder() {
  const filters: Record<string, unknown> = {};
  const nulls = new Set<string>();

  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    is(col: string, val: unknown) { if (val === null) nulls.add(col); return builder; },
    maybeSingle() {
      if (state.forceLookupError) {
        return Promise.resolve({ data: null, error: { message: state.forceLookupError } });
      }
      const row = state.rows.find((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const n of nulls) {
          if ((r as unknown as Record<string, unknown>)[n] !== null) return false;
        }
        return true;
      });
      return Promise.resolve({ data: row || null, error: null });
    },
    select() { return builder; },
  };
  return builder;
}

function buildUpdateBuilder(updates: Partial<FakeApproval>) {
  const filters: Record<string, unknown> = {};
  const nulls = new Set<string>();

  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    is(col: string, val: unknown) { if (val === null) nulls.add(col); return builder; },
    select() { return builder; },
    maybeSingle() {
      if (state.forceUpdateError) {
        return Promise.resolve({ data: null, error: { message: state.forceUpdateError } });
      }
      const idx = state.rows.findIndex((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const n of nulls) {
          if ((r as unknown as Record<string, unknown>)[n] !== null) return false;
        }
        return true;
      });
      if (idx < 0) return Promise.resolve({ data: null, error: null });
      state.rows[idx] = { ...state.rows[idx], ...updates };
      return Promise.resolve({ data: state.rows[idx], error: null });
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table !== 'newsletter_approvals_v2') throw new Error(`Unexpected table: ${table}`);
    return {
      select(_cols: string) { return buildSelectBuilder(); },
      async insert(row: Partial<FakeApproval>) {
        if (state.forceInsertError) return { error: { message: state.forceInsertError, code: '99' } };
        if (row.user_id && !state.validUserIds.has(row.user_id)) {
          return { error: { message: 'FK violation', code: '23503' } };
        }
        state.rows.push({
          id: 'row-' + Math.random().toString(36).slice(2),
          token: row.token!,
          user_id: row.user_id!,
          execution_id: row.execution_id!,
          resume_url: row.resume_url!,
          stage: row.stage!,
          payload: row.payload as Record<string, unknown>,
          created_at: new Date().toISOString(),
          resolved_at: null,
          expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          decision: null,
          feedback: null,
        });
        return { error: null };
      },
      update(updates: Partial<FakeApproval>) { return buildUpdateBuilder(updates); },
    };
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

// -----------------------------------------------------------------------------
// fetch() mocking — we need to verify the resume POST is issued.
// -----------------------------------------------------------------------------
const fetchCalls: Array<{ url: string; method: string; body: string }> = [];
let fetchResponseStatus = 200;
let fetchShouldThrow = false;

const originalFetch = globalThis.fetch;
beforeEach(() => {
  reset();
  fetchCalls.length = 0;
  fetchResponseStatus = 200;
  fetchShouldThrow = false;
  process.env.APPROVAL_SECRET = TEST_SECRET;
  process.env.APPROVAL_BASE_URL = TEST_BASE_URL;
  // Re-install fetch stub. Scope it: only intercept calls to the fake n8n
  // resume URL (seedRow uses http://localhost:9999/__n8n_resume__). Everything
  // else — especially the tests' own calls to their localhost test server —
  // passes through to the real fetch.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('__n8n_resume__')) {
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }
    if (fetchShouldThrow) throw new Error('network fail');
    fetchCalls.push({
      url,
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(null, { status: fetchResponseStatus });
  }) as typeof fetch;
});

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------
const TEST_SECRET = 'test-approval-secret-xyz';
const TEST_BASE_URL = 'http://localhost:9999';

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/approvals.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/approvals', mod.approvalsApiRouter);
  app.use('/approvals', express.urlencoded({ extended: true }));
  app.use('/approvals', mod.approvalsPublicRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

function seedRow(overrides: Partial<FakeApproval> = {}): FakeApproval {
  const row: FakeApproval = {
    id: 'row-' + Math.random().toString(36).slice(2),
    token: 'smoke-token-' + Math.random().toString(36).slice(2),
    user_id: '+14105914612',
    execution_id: 'exec-1',
    resume_url: 'http://localhost:9999/__n8n_resume__',
    stage: 'stories',
    payload: { stories: [{ title: 's1' }, { title: 's2' }] },
    created_at: new Date().toISOString(),
    resolved_at: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    decision: null,
    feedback: null,
    ...overrides,
  };
  state.rows.push(row);
  return row;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Approvals backend (S9)', () => {
  it('POST /api/approvals/create rejects without X-Approval-Secret (401)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: '+14105914612', stage: 'stories', payload: {},
          resume_url: 'http://x/resume', execution_id: 'e1',
        }),
      });
      expect(r.status).toBe(401);
    });
  });

  it('POST /api/approvals/create with valid body returns token + approval_url', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Approval-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', stage: 'stories',
          payload: { stories: [{ title: 't1' }] },
          resume_url: 'http://n8n/resume',
          execution_id: 'e1',
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; token: string; approval_url: string };
      expect(j.success).toBe(true);
      expect(j.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
      expect(j.approval_url).toBe(`${TEST_BASE_URL}/approvals/${j.token}`);
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0].stage).toBe('stories');
    });
  });

  it('POST /api/approvals/create rejects invalid stage (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Approval-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', stage: 'bogus',
          payload: {}, resume_url: 'http://n8n/resume', execution_id: 'e1',
        }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('POST /api/approvals/create rejects unknown user_id with 400 FK_VIOLATION', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Approval-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+19999999999', stage: 'stories',
          payload: {}, resume_url: 'http://n8n/resume', execution_id: 'e1',
        }),
      });
      expect(r.status).toBe(400);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('FK_VIOLATION');
    });
  });

  it('POST /api/approvals/create returns 500 if APPROVAL_BASE_URL not set', async () => {
    delete process.env.APPROVAL_BASE_URL;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Approval-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', stage: 'stories',
          payload: {}, resume_url: 'http://n8n/resume', execution_id: 'e1',
        }),
      });
      expect(r.status).toBe(500);
    });
  });

  it('GET /approvals/:token renders form with payload when open', async () => {
    const row = seedRow();
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('Newsletter approval');
      // Payload JSON is HTML-escaped, so check for either form
      expect(html).toMatch(/&quot;title&quot;:\s*&quot;s1&quot;/);
      expect(html).toContain('action="/approvals/' + row.token + '/resolve"');
    });
  });

  it('GET /approvals/:token returns 400 for malformed token', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/not%20a%20token!`);
      expect(r.status).toBe(400);
    });
  });

  it('GET /approvals/:token returns 404 for unknown token', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/nosuchtokenhere12345678`);
      expect(r.status).toBe(404);
    });
  });

  it('GET /approvals/:token returns 410 for expired row', async () => {
    const row = seedRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}`);
      expect(r.status).toBe(410);
      expect(await r.text()).toContain('Approval expired');
    });
  });

  it('GET /approvals/:token renders already-resolved page for resolved row', async () => {
    const row = seedRow({ resolved_at: new Date().toISOString(), decision: 'approve' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Already resolved');
    });
  });

  it('POST resolve with decision=approve records row + POSTs resume + renders thank-you', async () => {
    const row = seedRow();
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', feedback: 'looks great' }).toString(),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Decision recorded');

      // DB updated
      expect(state.rows[0].decision).toBe('approve');
      expect(state.rows[0].feedback).toBe('looks great');
      expect(state.rows[0].resolved_at).not.toBeNull();

      // Resume POST happened
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(row.resume_url);
      expect(fetchCalls[0].method).toBe('POST');
      expect(JSON.parse(fetchCalls[0].body)).toEqual({ decision: 'approve', feedback: 'looks great' });
    });
  });

  it('POST resolve with decision=revise is accepted too', async () => {
    const row = seedRow();
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'revise', feedback: 'swap story 3 for something AI-agent related' }).toString(),
      });
      expect(r.status).toBe(200);
      expect(state.rows[0].decision).toBe('revise');
    });
  });

  it('POST resolve double-submit returns 409 already resolved', async () => {
    const row = seedRow();
    await withServer(async (base) => {
      // First submit
      const r1 = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', feedback: '' }).toString(),
      });
      expect(r1.status).toBe(200);

      // Second submit on the now-resolved row
      const r2 = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', feedback: '' }).toString(),
      });
      expect(r2.status).toBe(409);
      // fetch called only once (the first resolve); the 2nd request short-circuits
      expect(fetchCalls).toHaveLength(1);
    });
  });

  it('POST resolve on expired row returns 410 without firing resume', async () => {
    const row = seedRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', feedback: '' }).toString(),
      });
      expect(r.status).toBe(410);
      expect(fetchCalls).toHaveLength(0);
    });
  });

  it('POST resolve rejects invalid decision value (400)', async () => {
    const row = seedRow();
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'maybe', feedback: '' }).toString(),
      });
      expect(r.status).toBe(400);
    });
  });

  it('POST resolve returns 502 when n8n resume fails', async () => {
    const row = seedRow();
    fetchResponseStatus = 500;
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', feedback: '' }).toString(),
      });
      expect(r.status).toBe(502);
      // But DB was still updated — decision isn't lost
      expect(state.rows[0].decision).toBe('approve');
      expect(state.rows[0].resolved_at).not.toBeNull();
    });
  });

  it('POST resolve handles network exception on n8n resume with 502', async () => {
    const row = seedRow();
    fetchShouldThrow = true;
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'revise', feedback: 'try again' }).toString(),
      });
      expect(r.status).toBe(502);
      expect(state.rows[0].decision).toBe('revise');
    });
  });

  it('POST resolve with malformed token returns 400', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/approvals/../../../etc/passwd/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve',
      });
      // Either Express' route-matcher rejects the path or our guard does; both are OK
      expect([400, 404]).toContain(r.status);
    });
  });
});

// Restore fetch after the suite
import { afterAll } from 'vitest';
afterAll(() => { globalThis.fetch = originalFetch; });
