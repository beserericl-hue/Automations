import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

/**
 * Two money-shaped defects.
 *
 * **I1 — `/credits/purchase` granted credits with no payment.** It took an `amount`, added that many
 * credits to the caller's own balance and wrote a `credit_transactions` row of type 'purchase'.
 * Any authenticated user could give themselves unlimited credits by calling their own API, and the
 * ledger recorded it as a sale. The docstring said payment was "deferred to Sprint 9"; the endpoint
 * was live the whole time. It now fails closed until a payment provider is configured.
 *
 * **I8 — no subscription meant 402 on everything.** Closing the tab on the "choose your plan" step
 * left a user with no `user_subscriptions` row, which `requireCredits` read as zero credits, so
 * every chat, export and chapter request answered 402 for an account that had done nothing wrong.
 * The trial is now provisioned on the first authenticated request that finds no subscription.
 */

interface SubRow {
  user_id: string;
  tier_id: string;
  status: string;
  credits_remaining: number;
  credits_used_this_period?: number;
  trial_start?: string | null;
  trial_end?: string | null;
}

interface TxRow {
  user_id: string;
  amount: number;
  transaction_type: string;
  description?: string;
}

const TRIAL_TIER = {
  id: 'tier-trial',
  name: 'trial',
  display_name: 'Trial',
  features: { kdp_export: false },
  monthly_credits: 200,
  credit_purchase_price_cents: 5,
  trial_days: 30,
  active: true,
  sort_order: 0,
};

const state = {
  subs: [] as SubRow[],
  txs: [] as TxRow[],
  tiers: [TRIAL_TIER] as Record<string, unknown>[],
  upsertFails: false,
};

function reset() {
  state.subs = [];
  state.txs = [];
  state.tiers = [TRIAL_TIER];
  state.upsertFails = false;
}

function builder(table: string) {
  const filters: { col: string; val: unknown; op: 'eq' | 'gt' }[] = [];
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(col: string, val: unknown) { filters.push({ col, val, op: 'eq' }); return b; },
    gt(col: string, val: unknown) { filters.push({ col, val, op: 'gt' }); return b; },
    order() { return b; },
    limit() { return b; },
    update() { return b; },
    insert(row: TxRow) {
      if (table === 'credit_transactions') state.txs.push(row);
      return Promise.resolve({ data: null, error: null });
    },
    // Like PostgREST: chainable `.select()`, and `ignoreDuplicates` leaves an existing row alone and
    // returns nothing for it.
    upsert(row: SubRow, opts?: { ignoreDuplicates?: boolean }) {
      let result: { data: unknown[] | null; error: { message: string } | null };
      if (state.upsertFails) {
        result = { data: null, error: { message: 'upsert failed' } };
      } else {
        const i = state.subs.findIndex((s) => s.user_id === row.user_id);
        if (i >= 0 && opts?.ignoreDuplicates) result = { data: [], error: null };
        else {
          if (i >= 0) state.subs[i] = { ...state.subs[i], ...row };
          else state.subs.push(row);
          result = { data: [{ id: 'sub' }], error: null };
        }
      }
      const done = Promise.resolve(result);
      return Object.assign(done, { select: () => done });
    },
    maybeSingle() {
      const rows = table === 'subscription_tiers' ? state.tiers : (state.subs as unknown as Record<string, unknown>[]);
      const match = rows.filter((r) =>
        filters.every((f) => (f.op === 'eq' ? r[f.col] === f.val : Number(r[f.col] ?? 0) > Number(f.val))),
      );
      return Promise.resolve({ data: match[0] ?? null, error: null });
    },
  };
  return b;
}

const fakeSupabase = { from: (t: string) => builder(t) };
vi.mock('../services/supabase-admin.js', () => ({ getSupabaseAdmin: () => fakeSupabase }));

beforeEach(() => {
  reset();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe('ensureTrialSubscription (I8)', () => {
  it('gives a subscription-less user the trial instead of leaving them at zero', async () => {
    const { ensureTrialSubscription } = await import('../services/credits.js');
    const out = await ensureTrialSubscription('+14105551234');

    expect(out?.credits_remaining).toBe(200);
    expect(out?.tier.name).toBe('trial');
    expect(state.subs).toHaveLength(1);
    expect(state.subs[0]!.status).toBe('active');
    expect(state.subs[0]!.trial_end).toBeTruthy();
  });

  it('records the grant in the ledger as a trial grant, not a purchase or a reset', async () => {
    const { ensureTrialSubscription } = await import('../services/credits.js');
    await ensureTrialSubscription('+14105551234');

    expect(state.txs).toHaveLength(1);
    expect(state.txs[0]!.transaction_type).toBe('trial_grant');
    expect(state.txs[0]!.amount).toBe(200);
  });

  it('is idempotent — a second call does not stack a second subscription', async () => {
    const { ensureTrialSubscription } = await import('../services/credits.js');
    await ensureTrialSubscription('+14105551234');
    await ensureTrialSubscription('+14105551234');
    expect(state.subs).toHaveLength(1);
  });

  it('picks the trial tier by trial_days, so renaming the tier cannot disable it', async () => {
    state.tiers = [{ ...TRIAL_TIER, name: 'free-look', display_name: 'Free Look' }];
    const { ensureTrialSubscription } = await import('../services/credits.js');
    const out = await ensureTrialSubscription('+14105551234');
    expect(out?.tier.name).toBe('free-look');
  });

  it('returns null rather than throwing when no trial tier is configured', async () => {
    state.tiers = [];
    const { ensureTrialSubscription } = await import('../services/credits.js');
    expect(await ensureTrialSubscription('+14105551234')).toBeNull();
  });

  it('returns null when the write fails, so the request still proceeds', async () => {
    state.upsertFails = true;
    const { ensureTrialSubscription } = await import('../services/credits.js');
    expect(await ensureTrialSubscription('+14105551234')).toBeNull();
  });
});

describe('POST /credits/purchase (I1)', () => {
  async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    // requireAuth is replaced: this is about the payment gate, not about auth.
    vi.doMock('../middleware/auth.js', () => ({
      requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        (req as express.Request & { userId: string }).userId = '+14105551234';
        (req as express.Request & { subscriptionTier: unknown }).subscriptionTier = {
          id: 'tier-trial', name: 'trial', display_name: 'Trial', features: {},
          monthly_credits: 200, credit_purchase_price_cents: 5,
        };
        next();
      },
      requireAdmin: (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
      requireSuperuser: (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
      requireTierFeature: () => (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
      requireCredits: () => (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
    }));
    vi.resetModules();
    const { creditsRouter } = await import('../routes/credits.js');
    const app = express();
    app.use(express.json());
    app.use('/api/credits', creditsRouter);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      return await fn(`http://localhost:${port}/api/credits`);
    } finally {
      server.close();
      vi.doUnmock('../middleware/auth.js');
    }
  }

  it('refuses to grant credits when no payment provider is configured', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 500 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('PAYMENTS_NOT_CONFIGURED');
      // and nothing was granted
      expect(state.txs.filter((t) => t.transaction_type === 'purchase')).toHaveLength(0);
      expect(state.subs).toHaveLength(0);
    });
  });

  it('still refuses when only a stripe key is present but no charge flow exists', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    await withServer(async (base) => {
      const res = await fetch(`${base}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50 }),
      });
      expect(res.status).toBe(503);
      expect(state.txs.filter((t) => t.transaction_type === 'purchase')).toHaveLength(0);
    });
  });
});
