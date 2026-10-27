/**
 * A failed subscription READ must never be treated as "this user has no subscription".
 *
 * DEV 2026-10-27: migration 039 added a second foreign key from user_subscriptions to
 * subscription_tiers, the middleware's `subscription_tiers!inner(...)` embed became ambiguous
 * (PGRST201), and the middleware read the error as "no row" and re-provisioned a 30-day trial over
 * the account's real plan on every request — 1,592 times in half an hour.
 *
 * PASS: a lookup error answers 503 and provisions nothing; a genuine "no row" still provisions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureTrial = vi.fn();
vi.mock('../services/credits.js', () => ({ ensureTrialSubscription: (...a: unknown[]) => ensureTrial(...a) }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let subResult: { data: unknown; error: unknown } = { data: null, error: null };
vi.mock('../services/supabase-admin.js', () => {
  const chain = (result: () => unknown) => {
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, is: () => q,
      maybeSingle: () => Promise.resolve(result()),
      single: () => Promise.resolve(result()),
    };
    return q;
  };
  return {
    getSupabaseAdmin: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'auth-1' } }, error: null }) },
      from: (table: string) => chain(() => {
        if (table === 'users_v2') return { data: { user_id: 'u1', role: 'user' }, error: null };
        if (table === 'user_subscriptions') return subResult;
        return { data: null, error: null };
      }),
    }),
  };
});

async function run(): Promise<{ status: number | null; nextCalled: boolean }> {
  const { requireAuth } = await import('../middleware/auth.js');
  let status: number | null = null;
  let nextCalled = false;
  const res = { status: (s: number) => { status = s; return res; }, json: () => res } as never;
  await requireAuth({ headers: { authorization: 'Bearer t' }, get: () => undefined } as never, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

beforeEach(() => {
  ensureTrial.mockReset().mockResolvedValue({ credits_remaining: 200, tier: { name: 'trial' } });
});

describe('requireAuth subscription lookup', () => {
  it('answers 503 and provisions nothing when the lookup errors', async () => {
    subResult = { data: null, error: { code: 'PGRST201', message: 'Could not embed because more than one relationship was found' } };
    const out = await run();
    expect(out.status).toBe(503);
    expect(out.nextCalled).toBe(false);
    expect(ensureTrial).not.toHaveBeenCalled();
  });

  it('still provisions the trial when there genuinely is no subscription', async () => {
    subResult = { data: null, error: null };
    const out = await run();
    expect(out.nextCalled).toBe(true);
    expect(ensureTrial).toHaveBeenCalledWith('u1');
  });
});
