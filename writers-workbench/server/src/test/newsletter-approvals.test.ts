/**
 * S5 (Compose Newsletter 2a) — in-app approvals API tests.
 *
 * Covers the two new authenticated endpoints on newsletterRouter:
 *   GET  /api/newsletter/approvals/open
 *   POST /api/newsletter/approvals/:token/resolve
 *
 * The shared resolveApproval() helper from server/src/lib/approvals.ts is
 * exercised through the route. The public /approvals/:token/resolve
 * endpoint already has its own behavioural test in approvals.test.ts and
 * was refactored to use the same helper, so end-state behaviour for both
 * surfaces is locked in.
 *
 * In-memory Supabase fake handles the chain shapes both endpoints use:
 *   - .from('newsletter_approvals_v2').select(...).eq().is().gt().order().limit()
 *   - .from('newsletter_approvals_v2').select('*').eq('token', t).maybeSingle()
 *   - .from('newsletter_approvals_v2').update(...).eq('token', t).is('resolved_at', null).select().maybeSingle()
 *
 * SSE pubsub is mocked to capture broadcasts; the n8n resume-URL fetch is
 * intercepted with a localhost-test-server passthrough so the suite's own
 * HTTP requests aren't accidentally caught.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------
const TEST_USER_OWNER = '+14105914612';
const TEST_USER_OTHER = '+17063338699';
const N8N_RESUME_URL = 'http://n8n.example/__resume__/abc';

let TEST_USER_ID = TEST_USER_OWNER;

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

const state: { rows: FakeApproval[]; forceLookupError?: string; forceUpdateError?: string } = { rows: [] };

function reset() {
  state.rows = [];
  delete state.forceLookupError;
  delete state.forceUpdateError;
  TEST_USER_ID = TEST_USER_OWNER;
}

function seed(overrides: Partial<FakeApproval> = {}): FakeApproval {
  const row: FakeApproval = {
    id: 'a-' + Math.random().toString(36).slice(2, 10),
    token: 'tok-' + Math.random().toString(36).slice(2, 14),
    user_id: TEST_USER_OWNER,
    execution_id: 'exec-100',
    resume_url: N8N_RESUME_URL,
    stage: 'stories',
    payload: { headline: 'h1' },
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
// Supabase fake — only the chains the new endpoints exercise.
// -----------------------------------------------------------------------------

interface Filter { kind: 'eq' | 'is' | 'gt'; col: string; val: unknown }

function buildQuery() {
  const filters: Filter[] = [];
  let limitN: number | undefined;

  function applyFilters(rows: FakeApproval[]): FakeApproval[] {
    return rows.filter((r) => {
      for (const f of filters) {
        const v = (r as unknown as Record<string, unknown>)[f.col];
        if (f.kind === 'eq' && v !== f.val) return false;
        if (f.kind === 'is' && f.val === null && v != null) return false;
        if (f.kind === 'gt' && !(typeof v === 'string' && typeof f.val === 'string' && v > f.val)) return false;
      }
      return true;
    });
  }

  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
    is(col: string, val: unknown) { filters.push({ kind: 'is', col, val }); return builder; },
    gt(col: string, val: unknown) { filters.push({ kind: 'gt', col, val }); return builder; },
    order() { return builder; },
    limit(n: number) { limitN = n; return builder; },
    maybeSingle() {
      if (state.forceLookupError) return Promise.resolve({ data: null, error: { message: state.forceLookupError, code: '99' } });
      const rows = applyFilters(state.rows);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then(onFulfilled: (x: { data: FakeApproval[] | null; error: unknown }) => unknown) {
      if (state.forceLookupError) return Promise.resolve({ data: null, error: { message: state.forceLookupError } }).then(onFulfilled);
      const rows = applyFilters(state.rows);
      const result = limitN ? rows.slice(0, limitN) : rows;
      return Promise.resolve({ data: result, error: null }).then(onFulfilled);
    },
  };
  return builder;
}

function buildUpdate(patch: Partial<FakeApproval>) {
  const filters: Filter[] = [];
  function applyFilters(rows: FakeApproval[]): FakeApproval[] {
    return rows.filter((r) => {
      for (const f of filters) {
        const v = (r as unknown as Record<string, unknown>)[f.col];
        if (f.kind === 'eq' && v !== f.val) return false;
        if (f.kind === 'is' && f.val === null && v != null) return false;
      }
      return true;
    });
  }
  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
    is(col: string, val: unknown) { filters.push({ kind: 'is', col, val }); return builder; },
    select() {
      // Apply patch + return the updated row(s).
      if (state.forceUpdateError) return { maybeSingle: () => Promise.resolve({ data: null, error: { message: state.forceUpdateError } }) };
      const matched = applyFilters(state.rows);
      for (const row of matched) Object.assign(row, patch);
      return { maybeSingle: () => Promise.resolve({ data: matched[0] ?? null, error: null }) };
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table !== 'newsletter_approvals_v2') throw new Error('unexpected table: ' + table);
    return {
      select: () => buildQuery(),
      update: (patch: Partial<FakeApproval>) => buildUpdate(patch),
    };
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

// -----------------------------------------------------------------------------
// requireAuth stub — sets userId from the test-controlled global so each
// test can flip the caller without remounting the route.
// -----------------------------------------------------------------------------
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER_ID;
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSuperuser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// -----------------------------------------------------------------------------
// SSE pubsub mock — capture broadcasts from resolveApproval().
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// fetch mock — intercept only the n8n resume URL; pass everything else through.
// -----------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let resumeStatus = 200;
let resumeShouldThrow = false;
const resumeCalls: Array<{ url: string; method: string; body: string }> = [];

beforeEach(() => {
  reset();
  sseBroadcasts.length = 0;
  resumeCalls.length = 0;
  resumeStatus = 200;
  resumeShouldThrow = false;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === N8N_RESUME_URL) {
      if (resumeShouldThrow) throw new Error('n8n unreachable');
      resumeCalls.push({
        url,
        method: init?.method || 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: resumeStatus });
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
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

// -----------------------------------------------------------------------------
// GET /api/newsletter/approvals/open
// -----------------------------------------------------------------------------
describe('GET /api/newsletter/approvals/open', () => {
  it('returns the caller\'s open approvals only', async () => {
    seed({ token: 'A', user_id: TEST_USER_OWNER });                                                   // visible
    seed({ token: 'B', user_id: TEST_USER_OTHER });                                                   // hidden — other user
    seed({ token: 'C', user_id: TEST_USER_OWNER, resolved_at: new Date().toISOString() });            // hidden — resolved
    seed({ token: 'D', user_id: TEST_USER_OWNER, expires_at: new Date(Date.now() - 60_000).toISOString() }); // hidden — expired
    TEST_USER_ID = TEST_USER_OWNER;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open`);
      expect(r.status).toBe(200);
      const j = await r.json() as { approvals: { token: string }[] };
      expect(j.approvals.map((a) => a.token)).toEqual(['A']);
    });
  });

  it('filters by execution_id', async () => {
    seed({ token: 'A', execution_id: 'exec-100' });
    seed({ token: 'B', execution_id: 'exec-200' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open?execution_id=exec-200`);
      const j = await r.json() as { approvals: { token: string }[] };
      expect(j.approvals.map((a) => a.token)).toEqual(['B']);
    });
  });

  it('filters by stage', async () => {
    seed({ token: 'S1', stage: 'stories' });
    seed({ token: 'S2', stage: 'subject_line' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open?stage=subject_line`);
      const j = await r.json() as { approvals: { token: string; stage: string }[] };
      expect(j.approvals.map((a) => a.token)).toEqual(['S2']);
    });
  });

  it('rejects bogus stage', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open?stage=bad-stage`);
      expect(r.status).toBe(400);
    });
  });

  it('attaches approval_url when APPROVAL_BASE_URL is set', async () => {
    process.env.APPROVAL_BASE_URL = 'https://wb.example';
    seed({ token: 'tok-XYZ' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open`);
      const j = await r.json() as { approvals: Array<{ token: string; approval_url: string | null }> };
      expect(j.approvals[0].approval_url).toBe('https://wb.example/approvals/tok-XYZ');
    });
    delete process.env.APPROVAL_BASE_URL;
  });

  it('omits approval_url when APPROVAL_BASE_URL not set', async () => {
    delete process.env.APPROVAL_BASE_URL;
    seed({ token: 'tok-XYZ-omits' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/open`);
      const j = await r.json() as { approvals: Array<{ approval_url: string | null; token: string }> };
      expect(j.approvals).toHaveLength(1);
      expect(j.approvals[0].approval_url).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// POST /api/newsletter/approvals/:token/resolve
// -----------------------------------------------------------------------------
describe('POST /api/newsletter/approvals/:token/resolve', () => {
  it('happy path: resolves, posts to n8n, broadcasts SSE, returns 200', async () => {
    const row = seed({ token: 'tok-happy01-' + 'a'.repeat(30) });
    TEST_USER_ID = TEST_USER_OWNER;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', feedback: 'lgtm' }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; resumed: boolean };
      expect(j).toEqual({ success: true, resumed: true });

      // Row mutated
      expect(row.resolved_at).not.toBeNull();
      expect(row.decision).toBe('approve');
      expect(row.feedback).toBe('lgtm');

      // n8n resume POSTed
      expect(resumeCalls).toHaveLength(1);
      expect(JSON.parse(resumeCalls[0].body)).toEqual({ decision: 'approve', feedback: 'lgtm' });

      // SSE broadcast fired
      const ev = sseBroadcasts.find((b) => (b.event as { event?: string }).event === 'newsletter.approval.resolved');
      expect(ev).toBeDefined();
      expect(ev!.userId).toBe(TEST_USER_OWNER);
      expect((ev!.event.data as Record<string, unknown>).resumed).toBe(true);
    });
  });

  it('403 when token belongs to another user', async () => {
    const row = seed({ token: 'tok-other000' + 'b'.repeat(30), user_id: TEST_USER_OTHER });
    TEST_USER_ID = TEST_USER_OWNER;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(403);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('FORBIDDEN');

      // No mutation, no n8n call, no broadcast
      expect(row.resolved_at).toBeNull();
      expect(resumeCalls).toHaveLength(0);
      expect(sseBroadcasts).toHaveLength(0);
    });
  });

  it('404 when token unknown', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/tok-NOPENOPENOPENOPENOPE0000/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(404);
    });
  });

  it('409 when already resolved', async () => {
    const row = seed({
      token: 'tok-resolved00' + 'c'.repeat(28),
      resolved_at: new Date(Date.now() - 60_000).toISOString(),
      decision: 'revise',
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(409);
      const j = await r.json() as { error: { code: string }; decision: string | null };
      expect(j.error.code).toBe('ALREADY_RESOLVED');
      expect(j.decision).toBe('revise');
    });
  });

  it('410 when expired', async () => {
    const row = seed({
      token: 'tok-expired000' + 'd'.repeat(28),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(410);
      expect(resumeCalls).toHaveLength(0);
    });
  });

  it('502 when n8n resume returns non-2xx — decision still persisted, SSE still broadcast', async () => {
    const row = seed({ token: 'tok-resumefail' + 'e'.repeat(28) });
    resumeStatus = 503;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(502);
      const j = await r.json() as { success: boolean; resumed: boolean; error: { code: string } };
      expect(j).toMatchObject({ success: true, resumed: false });
      expect(j.error.code).toBe('UPSTREAM_RESUME_FAILED');

      // DB row IS resolved
      expect(row.resolved_at).not.toBeNull();
      expect(row.decision).toBe('approve');

      // SSE event fires with resumed: false so the UI can still react.
      const ev = sseBroadcasts.find((b) => (b.event as { event?: string }).event === 'newsletter.approval.resolved');
      expect(ev).toBeDefined();
      expect((ev!.event.data as Record<string, unknown>).resumed).toBe(false);
    });
  });

  it('502 when n8n resume throws (network error) — same persistence guarantees', async () => {
    const row = seed({ token: 'tok-throws0000' + 'f'.repeat(28) });
    resumeShouldThrow = true;
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(502);
      expect(row.resolved_at).not.toBeNull();
    });
  });

  it('400 on invalid decision value', async () => {
    const row = seed({ token: 'tok-baddecisn0' + 'g'.repeat(28) });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('400 on malformed token (path param)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/short/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('500 on lookup error', async () => {
    seed({ token: 'tok-lookupfail' + 'h'.repeat(28) });
    state.forceLookupError = 'connection reset';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/tok-lookupfail${'h'.repeat(28)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(500);
    });
  });

  it('feedback defaults to empty string when omitted', async () => {
    const row = seed({ token: 'tok-nofeedback' + 'i'.repeat(28) });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/approvals/${row.token}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(r.status).toBe(200);
      expect(row.feedback).toBe('');
      expect(JSON.parse(resumeCalls[0].body).feedback).toBe('');
    });
  });
});
