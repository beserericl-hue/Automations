/**
 * F2-7 — resolveApproval engine-backed branch.
 *
 * When NEWSLETTER_BACKEND=python, resolveApproval (lib/approvals.ts) must POST
 * the decision to the Writer Engine's service-secret-authed resolve endpoint
 * rather than the n8n Wait-node resume_url. This suite mocks the three I/O deps
 * of resolveApproval (Supabase admin, SSE publish, global fetch) and asserts the
 * engine routing, the chosen_images forwarding, and the resume_failed paths.
 *
 * The n8n path + the full state-machine (forbidden / already_resolved / expired)
 * are covered in approvals.test.ts + newsletter-approvals.test.ts; this file is
 * scoped to the engine branch added in F2-7.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- mock the three I/O deps of resolveApproval ----------------------------
type Row = Record<string, unknown>;
let activeRow: Row | null;
let updateSucceeds: boolean;

vi.mock('../services/supabase-admin.js', () => {
  // Chainable PostgREST-ish stub. `.maybeSingle()` returns activeRow for the
  // initial lookup; the conditional update's `.select().maybeSingle()` returns
  // the row when updateSucceeds (i.e. resolved_at was still null).
  const makeBuilder = () => {
    let isUpdate = false;
    const builder: Record<string, unknown> = {
      from() {
        isUpdate = false;
        return builder;
      },
      select() {
        return builder;
      },
      update() {
        isUpdate = true;
        return builder;
      },
      eq() {
        return builder;
      },
      is() {
        return builder;
      },
      maybeSingle() {
        if (isUpdate) {
          return Promise.resolve({
            data: updateSucceeds ? { ...(activeRow as Row), resolved_at: new Date().toISOString() } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: activeRow, error: null });
      },
    };
    return builder;
  };
  return { getSupabaseAdmin: () => makeBuilder() };
});

vi.mock('../routes/session.js', () => ({
  pushSseEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { resolveApproval } from '../lib/approvals.js';

function seedRow(overrides: Row = {}): Row {
  activeRow = {
    id: 'row-1',
    token: 'tok_123',
    user_id: '+14105914612',
    execution_id: 'exec-1',
    resume_url: null,
    stage: 'stories',
    payload: {},
    created_at: new Date().toISOString(),
    resolved_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    decision: null,
    feedback: null,
    ...overrides,
  };
  return activeRow;
}

describe('resolveApproval — engine-backed (NEWSLETTER_BACKEND=python)', () => {
  const ENGINE_URL = 'http://writer-engine-gateway.railway.internal:8000';
  const SECRET = 'test-shared-secret';
  let fetchMock: ReturnType<typeof vi.fn>;
  let prevBackend: string | undefined;
  let prevUrl: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    updateSucceeds = true;
    prevBackend = process.env.NEWSLETTER_BACKEND;
    prevUrl = process.env.NEWSLETTER_SERVICE_URL;
    prevSecret = process.env.SERVICE_SHARED_SECRET;
    process.env.NEWSLETTER_BACKEND = 'python';
    process.env.NEWSLETTER_SERVICE_URL = ENGINE_URL;
    process.env.SERVICE_SHARED_SECRET = SECRET;
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env.NEWSLETTER_BACKEND = prevBackend;
    process.env.NEWSLETTER_SERVICE_URL = prevUrl;
    process.env.SERVICE_SHARED_SECRET = prevSecret;
    vi.unstubAllGlobals();
  });

  it('POSTs to the engine resolve endpoint, not resume_url', async () => {
    seedRow({ resume_url: null });
    const res = await resolveApproval({ token: 'tok_123', decision: 'approve', feedback: '' });
    expect(res.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENGINE_URL}/internal/newsletter/approvals/tok_123/resolve`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['X-Service-Secret']).toBe(SECRET);
  });

  it('forwards chosenImages as chosen_images for the image gate', async () => {
    seedRow({ resume_url: null, stage: 'image' });
    const chosen = { 'Story A': 'https://img/1.png' };
    await resolveApproval({ token: 'tok_123', decision: 'approve', feedback: '', chosenImages: chosen });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.chosen_images).toEqual(chosen);
  });

  it('marks resume_failed when the engine returns non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 } as Response);
    seedRow({ resume_url: null });
    const res = await resolveApproval({ token: 'tok_123', decision: 'approve', feedback: '' });
    expect(res.status).toBe('resume_failed');
  });

  it('marks resume_failed when engine env is unset (no fetch)', async () => {
    delete process.env.NEWSLETTER_SERVICE_URL;
    seedRow({ resume_url: null });
    const res = await resolveApproval({ token: 'tok_123', decision: 'approve', feedback: '' });
    expect(res.status).toBe('resume_failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
