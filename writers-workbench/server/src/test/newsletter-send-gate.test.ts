/**
 * The newsletter's final "Send to subscribers" gate (Eric, 2026-11-03), on the Workbench side:
 *   - the 'send' approval previews the issue the saga actually rendered and saved (not a template
 *     approximation), so the owner approves the real email;
 *   - it can be declined ('reject', which only the send gate accepts) and the decline reaches the engine;
 *   - "Send me a test copy" asks the engine to mail the CALLER's own address only, and only on an open
 *     send approval the caller owns; the copies sent are listed back;
 *   - the engine's new stages map to sensible run statuses and the stage callback accepts them.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../routes/session.js', () => ({ pushSseEvent: vi.fn(async () => undefined) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => { req.userId = 'owner'; req.effectiveRole = 'user'; next(); },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSuperuser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' = 'select';
    let payload: Row = {};
    let limit = Infinity;
    const run = () => {
      const hit = (db[table] ?? []).filter((r) => f.every((x) => x(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return hit; }
      return hit.slice(0, limit);
    };
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      gt: () => q,
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from, rpc: async () => ({ data: 4, error: null }) }) };
});

const ENGINE = 'http://engine.internal:8000';
const realFetch = globalThis.fetch;
let engineCalls: Array<{ url: string; body: Row }> = [];
let engineReply: { status: number; body: Row } = { status: 200, body: {} };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  process.env.NEWSLETTER_BACKEND = 'python';
  process.env.NEWSLETTER_SERVICE_URL = ENGINE;
  process.env.SERVICE_SHARED_SECRET = 'sss';
  engineCalls = [];
  engineReply = { status: 200, body: { to: 'owner@example.com', subject: '[TEST] Issue 7', message_id: 'postal-9', sent_at: '2026-11-03T18:00:00Z', recorded: true } };
  db.newsletter_approvals_v2 = [
    { token: 'tok-send-aaaaaaaaaaaaaaaa', user_id: 'owner', edition_id: 'ed', execution_id: 'ex1', stage: 'send', resolved_at: null, expires_at: FUTURE, payload: { send_id: 'send-1', subject: 'Issue 7', subscriber_count: 0 } },
    { token: 'tok-stories-aaaaaaaaaaaaa', user_id: 'owner', edition_id: 'ed', execution_id: 'ex1', stage: 'stories', resolved_at: null, expires_at: FUTURE, payload: { top_selected_stories: [] } },
    { token: 'tok-theirs-aaaaaaaaaaaaaa', user_id: 'other', edition_id: 'ed', execution_id: 'ex2', stage: 'send', resolved_at: null, expires_at: FUTURE, payload: { send_id: 'send-2' } },
  ];
  db.newsletter_sends_v2 = [
    { id: 'send-1', user_id: 'owner', html_body: '<html><body><h1>The real rendered issue #7</h1></body></html>', subject: 'Issue 7', status: 'draft', issue_number: 7 },
    { id: 'send-2', user_id: 'other', html_body: '<p>theirs</p>', subject: 'x', status: 'draft' },
  ];
  db.newsletter_templates_v2 = [{ id: 't', edition_id: 'ed', is_default: true, active: true, html: '<p>TEMPLATE {{preheader}}</p>', sample_data: {} }];
  db.newsletter_editions_v2 = [{ id: 'ed', newsletter_name: 'Ed' }];
  db.newsletter_owner_emails_v2 = [
    { id: 'c1', user_id: 'owner', execution_id: 'ex1', kind: 'test_copy', to_email: 'owner@example.com', subject: '[TEST] Issue 7', postal_message_id: 'postal-8', sent_at: '2026-11-03T17:00:00Z' },
    { id: 'c2', user_id: 'owner', execution_id: 'ex1', kind: 'slate', to_email: 'owner@example.com', subject: 'slate', postal_message_id: 'p', sent_at: '2026-11-03T17:00:00Z' },
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ENGINE)) {
      engineCalls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Row) : {} });
      return new Response(JSON.stringify(engineReply.body), { status: engineReply.status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
});

afterAll(() => { globalThis.fetch = realFetch; });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const { newsletterRouter } = await import('../routes/newsletter.js');
  const app = express(); app.use(express.json()); app.use('/api/newsletter', newsletterRouter);
  const server = app.listen(0);
  try {
    const r = await realFetch(`http://localhost:${(server.address() as AddressInfo).port}/api/newsletter${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Row };
  } finally { server.close(); }
}

describe('final send gate: preview', () => {
  it('shows the saved, rendered issue itself', async () => {
    const r = await call('GET', '/approvals/tok-send-aaaaaaaaaaaaaaaa/preview');
    expect(r.status).toBe(200);
    expect(r.json.html).toContain('The real rendered issue #7');
    expect(r.json.html).not.toContain('TEMPLATE');
    expect(r.json.rendered).toBe(true);
  });

  it('is 404 for another user\'s send approval', async () => {
    expect((await call('GET', '/approvals/tok-theirs-aaaaaaaaaaaaaa/preview')).status).toBe(404);
  });
});

describe('final send gate: decisions', () => {
  it('a reject on the send gate is recorded and passed to the engine', async () => {
    const r = await call('POST', '/approvals/tok-send-aaaaaaaaaaaaaaaa/resolve', { decision: 'reject', feedback: 'not this week' });
    expect(r.status).toBe(200);
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].url).toBe(`${ENGINE}/internal/newsletter/approvals/tok-send-aaaaaaaaaaaaaaaa/resolve`);
    expect(engineCalls[0].body).toMatchObject({ decision: 'reject' });
    expect(db.newsletter_approvals_v2[0]).toMatchObject({ decision: 'reject' });
  });

  it('a reject is refused on any other gate and nothing is resolved', async () => {
    const r = await call('POST', '/approvals/tok-stories-aaaaaaaaaaaaa/resolve', { decision: 'reject' });
    expect(r.status).toBe(400);
    expect(engineCalls).toHaveLength(0);
    expect(db.newsletter_approvals_v2[1].resolved_at).toBeNull();
  });

  it('the open-approvals list can filter on the send stage', async () => {
    const r = await call('GET', '/approvals/open?stage=send');
    expect(r.status).toBe(200);
  });
});

describe('final send gate: test copy', () => {
  it('asks the engine to mail the caller (session user) only, and reports the Postal id', async () => {
    const r = await call('POST', '/approvals/tok-send-aaaaaaaaaaaaaaaa/test-copy');
    expect(r.status).toBe(200);
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].url).toBe(`${ENGINE}/internal/newsletter/executions/ex1/test-copy`);
    expect(engineCalls[0].body).toEqual({ user_id: 'owner' });
    expect(r.json.data).toMatchObject({ to: 'owner@example.com', message_id: 'postal-9', recorded: true });
    // The gate is still open: a test copy decides nothing.
    expect(db.newsletter_approvals_v2[0].resolved_at).toBeNull();
  });

  it('is refused before the final gate, on someone else\'s run, and once decided', async () => {
    expect((await call('POST', '/approvals/tok-stories-aaaaaaaaaaaaa/test-copy')).status).toBe(409);
    expect((await call('POST', '/approvals/tok-theirs-aaaaaaaaaaaaaa/test-copy')).status).toBe(404);
    db.newsletter_approvals_v2[0].resolved_at = '2026-11-03T18:00:00Z';
    expect((await call('POST', '/approvals/tok-send-aaaaaaaaaaaaaaaa/test-copy')).status).toBe(409);
    expect(engineCalls).toHaveLength(0);
  });

  it('passes the engine\'s refusal through with its message', async () => {
    engineReply = { status: 429, body: { detail: JSON.stringify({ detail: { code: 'LIMIT', message: 'this issue has already sent 10 test copies' } }) } };
    const r = await call('POST', '/approvals/tok-send-aaaaaaaaaaaaaaaa/test-copy');
    expect(r.status).toBe(429);
    expect((r.json.error as Row).message).toContain('10 test copies');
  });

  it('lists the test copies sent for the run (not slate emails)', async () => {
    const r = await call('GET', '/approvals/tok-send-aaaaaaaaaaaaaaaa/test-copies');
    expect(r.status).toBe(200);
    expect((r.json.data as Row[]).map((x) => x.id)).toEqual(['c1']);
  });
});

describe('final send gate: run status', () => {
  it('maps the new stages: saved runs on to the send gate', async () => {
    const { mapSagaStageToStatus } = await import('../routes/newsletter.js');
    expect(mapSagaStageToStatus('saved', 'ok')).toBe('running');
    expect(mapSagaStageToStatus('awaiting_send_approval', 'ok')).toBe('waiting');
    expect(mapSagaStageToStatus('sending', 'ok')).toBe('running');
    expect(mapSagaStageToStatus('sent', 'ok')).toBe('success');
    expect(mapSagaStageToStatus('cancelled', 'ok')).toBe('success');
  });

  it('the stage callback accepts the send-gate stages', async () => {
    const { StageCallbackSchema } = await import('../schemas.js');
    for (const stage of ['awaiting_send_approval', 'sending', 'sent', 'cancelled']) {
      const ok = StageCallbackSchema.safeParse({ userId: 'u', executionId: 'e', editionId: 'ed', stage, ts: new Date().toISOString() });
      expect(ok.success, stage).toBe(true);
    }
  });
});
