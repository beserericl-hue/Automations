/**
 * Sprint 9 (S9-9): Stripe payments, server side. Stripe and Supabase are in-memory fakes; the
 * webhook is driven with real Stripe signatures (stripe.webhooks.generateTestHeaderString).
 *
 * PASS: signatures are checked on the raw body; each event is processed once; a subscription's
 * checkout grants the tier and its credits once; invoice.paid resets credits once per invoice; three
 * failed payments suspend the account; cancellation keeps access to the period end; a credit pack
 * adds credits only through the webhook, once per payment; failures answer 500 so Stripe retries;
 * paid tiers cannot be activated without paying; staff accounts are never sent to Checkout; a reader
 * order is placed with RPI only after payment.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import Stripe from 'stripe';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const UNIQUE: Record<string, string[]> = {
  user_subscriptions: ['user_id'],
  stripe_customers_v2: ['user_id'],
  stripe_events_v2: ['id'],
  print_offers_v2: ['project_id', 'volume_index', 'edition'],
};

vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: Row | Row[] = {};
    let conflict = '';
    let limit = Infinity;
    const rows = () => (db[table] ??= []);
    const run = (): Row[] => {
      const list = Array.isArray(payload) ? payload : [payload];
      if (op === 'insert') {
        const made: Row[] = [];
        for (const p of list) {
          if (table === 'credit_transactions' && p.reference_id && ['monthly_reset', 'trial_grant'].includes(String(p.transaction_type))
            && rows().some((r) => r.user_id === p.user_id && r.transaction_type === p.transaction_type && r.reference_id === p.reference_id)) {
            throw new Error('duplicate key value violates unique constraint "uq_credit_tx_grant_reference"');
          }
          if (table === 'credit_transactions' && p.stripe_payment_intent_id && p.transaction_type === 'purchase'
            && rows().some((r) => r.stripe_payment_intent_id === p.stripe_payment_intent_id && r.transaction_type === 'purchase')) {
            throw Object.assign(new Error('duplicate key value violates unique constraint'), { dup: true });
          }
          const row = { id: `${table}-${rows().length + 1}`, ...p };
          rows().push(row);
          made.push(row);
        }
        return made;
      }
      if (op === 'upsert') {
        const keys = (conflict || UNIQUE[table]?.join(',') || 'id').split(',');
        return list.map((p) => {
          const hit = rows().find((r) => keys.every((k) => r[k] === p[k]));
          if (hit) return Object.assign(hit, p);
          const row = { id: `${table}-${rows().length + 1}`, ...p };
          rows().push(row);
          return row;
        });
      }
      const hit = rows().filter((r) => f.every((x) => x(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return hit; }
      if (op === 'delete') { db[table] = rows().filter((r) => !hit.includes(r)); return hit; }
      // A database returns copies: a caller holding a row must not see a later write through it.
      return hit.slice(0, limit).map((r) => ({ ...r }));
    };
    const exec = () => {
      try { return { data: run(), error: null }; } catch (err) { return { data: null, error: { message: (err as Error).message } }; }
    };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      upsert: (p: Row | Row[], o?: { onConflict?: string }) => ((op = 'upsert'), (payload = p), (conflict = o?.onConflict ?? ''), q),
      delete: () => ((op = 'delete'), q),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (f.push((r) => r[c] !== v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, _o: string, v: unknown) => (f.push((r) => (r[c] ?? null) !== v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      gte: (c: string, v: string) => (f.push((r) => String(r[c]) >= v), q),
      lte: (c: string, v: string) => (f.push((r) => String(r[c]) <= v), q),
      lt: (c: string, v: string) => (f.push((r) => String(r[c]) < v), q),
      order: () => q,
      range: () => q,
      limit: (n: number) => ((limit = n), q),
      single: () => { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      maybeSingle: () => { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(exec()).then(ok, bad),
    };
    return q;
  };
  // migration 039's credits_add_v2: one statement, refuses to go below zero.
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'credits_add_v2') return { data: null, error: { message: `${fn} does not exist` } };
    const sub = (db.user_subscriptions ?? []).find((r) => r.user_id === args.p_user_id);
    const delta = Number(args.p_delta);
    if (!sub || Number(sub.credits_remaining) + delta < 0) return { data: null, error: null };
    sub.credits_remaining = Number(sub.credits_remaining) + delta;
    if (args.p_count_usage) sub.credits_used_this_period = Number(sub.credits_used_this_period ?? 0) - delta;
    return { data: sub.credits_remaining, error: null };
  };
  const storage = { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://files.test/${path}` }, error: null }) }) };
  return { getSupabaseAdmin: () => ({ from, rpc, storage }) };
});

const sent: Array<{ to: string; subject: string }> = [];
vi.mock('../lib/email.js', () => ({ sendEmail: async (m: { to: string; subject: string }) => { sent.push(m); return { ok: true, mode: 'dry-run' }; } }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const rpiCreate = vi.fn();
vi.mock('../lib/rpi-print.js', async (orig) => {
  const real = await orig<typeof import('../lib/rpi-print.js')>();
  return { ...real, createOrder: (...a: unknown[]) => rpiCreate(...a), shippingOptions: async () => [
    { methodName: 'Ground', methodClassification: 'standard', estimatedShipDateUTC: null, estimatedDeliveryDateUTC: null, price: 7.5, currency: 'USD' },
  ] };
});
let authAs: Row = {};
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => { Object.assign(req, { userId: 'u1', effectiveRole: 'user', subscriptionTier: { name: 'trial', credit_purchase_price_cents: 100 }, creditsRemaining: 10 }, authAs); next(); },
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireSuperuser: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireTierFeature: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const WEBHOOK_SECRET = 'whsec_test_secret';
const PRO = { id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', name: 'pro', display_name: 'Professional', monthly_credits: 500, monthly_price_cents: 4999, annual_price_cents: 49900,
  credit_purchase_price_cents: 100, stripe_product_id: 'prod_pro', stripe_price_monthly_id: 'price_pro_m', stripe_price_annual_id: 'price_pro_y',
  publicly_selectable: true, active: true, trial_days: 0, features: {}, sort_order: 2 };
const STD = { ...PRO, id: 'f6623f21-95a8-4598-9659-bf09b240cc2f', name: 'standard', display_name: 'Standard', monthly_credits: 100, monthly_price_cents: 1999, annual_price_cents: 19900,
  stripe_price_monthly_id: 'price_std_m', stripe_price_annual_id: 'price_std_y', sort_order: 1 };
const TRIAL = { ...PRO, id: 'ef610ed6-bba6-43cc-88af-385ad7b2caef', name: 'trial', display_name: 'Trial', monthly_credits: 200, monthly_price_cents: 0, annual_price_cents: 0,
  stripe_price_monthly_id: null, stripe_price_annual_id: null, trial_days: 30, sort_order: 0 };

const end = Math.floor(Date.now() / 1000) + 30 * 86400;
function subscription(over: Partial<Stripe.Subscription> = {}, price = 'price_pro_m'): Stripe.Subscription {
  return {
    id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false, metadata: { user_id: 'u1' },
    latest_invoice: 'in_1', schedule: null,
    items: { object: 'list', data: [{ id: 'si_1', price: { id: price, recurring: { interval: 'month', interval_count: 1 }, unit_amount: 4999 }, current_period_start: end - 30 * 86400, current_period_end: end }] },
    ...over,
  } as unknown as Stripe.Subscription;
}

const stripeCalls: Array<[string, unknown]> = [];
let currentSub = subscription();
const fakeStripe = {
  webhooks: new Stripe('sk_test_fake').webhooks,
  subscriptions: { retrieve: async () => currentSub, update: async (_id: string, p: unknown) => { stripeCalls.push(['subscriptions.update', p]); return currentSub; }, cancel: async () => currentSub },
  customers: { create: async (p: unknown) => { stripeCalls.push(['customers.create', p]); return { id: 'cus_1' }; } },
  checkout: { sessions: { create: async (p: Record<string, unknown>) => { stripeCalls.push(['checkout.create', p]); return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }; } } },
};

async function app() {
  const { resetStripeClient } = await import('../services/stripe.js');
  resetStripeClient(fakeStripe as unknown as Stripe);
  const { stripeWebhookRouter } = await import('../routes/stripe-webhook.js');
  const { billingRouter } = await import('../routes/billing.js');
  const { accountRouter } = await import('../routes/account.js');
  const a = express();
  a.use('/api/webhooks/stripe', stripeWebhookRouter);
  a.use(express.json());
  a.use('/api/billing', billingRouter);
  a.use('/api/account', accountRouter);
  return a;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) {
  const server = (await app()).listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } finally { server.close(); }
}

async function deliver(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ object: 'event', livemode: false, ...event });
  const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret });
  return call('POST', '/api/webhooks/stripe', undefined, { 'stripe-signature': header }, payload);
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.subscription_tiers = [TRIAL, STD, PRO].map((t) => ({ ...t }));
  db.users_v2 = [{ user_id: 'u1', email: 'reader@example.test', display_name: 'Una One', phone_number: '+15550001', supabase_auth_uid: 'auth-1' }];
  db.user_subscriptions = [{ id: 'sub-row', user_id: 'u1', tier_id: 'ef610ed6-bba6-43cc-88af-385ad7b2caef', status: 'active', billing_cycle: 'none', credits_remaining: 150, credits_used_this_period: 50, payment_failures: 0 }];
  db.stripe_customers_v2 = [{ user_id: 'u1', stripe_customer_id: 'cus_1', mode: 'test' }];
  db.user_account_meta_v2 = [{ user_id: 'u1', account_status: 'active' }];
  sent.length = 0;
  stripeCalls.length = 0;
  currentSub = subscription();
  authAs = {};
  rpiCreate.mockReset().mockResolvedValue({ customerOrderId: 'ww-x' });
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterAll(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; });

const sub = () => db.user_subscriptions[0];
const creditTx = () => (db.credit_transactions ?? []);

describe('stripe client', () => {
  it('refuses clearly without a key, and reads the mode from the key', async () => {
    const { getStripeClient, resetStripeClient, stripeMode, StripeNotConfiguredError } = await import('../services/stripe.js');
    resetStripeClient(null);
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => getStripeClient()).toThrow(StripeNotConfiguredError);
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    expect(stripeMode()).toBe('live');
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(stripeMode()).toBe('test');
  });
});

describe('webhook', () => {
  it('rejects a tampered payload and an unsigned one', async () => {
    expect((await deliver({ id: 'evt_bad', type: 'invoice.paid', data: { object: {} } }, 'whsec_wrong')).status).toBe(400);
    expect((await call('POST', '/api/webhooks/stripe', undefined, {}, '{}')).status).toBe(400);
    expect(db.stripe_events_v2 ?? []).toHaveLength(0);
  });

  it('checkout.session.completed activates the tier and grants its credits once', async () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'subscription', subscription: 'sub_1', metadata: { kind: 'subscription', user_id: 'u1' } } } };
    expect((await deliver(event)).status).toBe(200);
    expect(sub()).toMatchObject({ tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', status: 'active', billing_cycle: 'monthly', stripe_subscription_id: 'sub_1', credits_remaining: 500 });
    // The same event again, and invoice.paid for the same invoice: nothing granted twice.
    expect((await deliver(event)).json.duplicate).toBe(true);
    await deliver({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } } } } });
    expect(creditTx().filter((t) => t.transaction_type === 'monthly_reset')).toHaveLength(1);
    expect(db.stripe_events_v2.map((e) => e.status)).toEqual(['processed', 'processed']);
  });

  it('two deliveries for the same invoice at the same moment grant once', async () => {
    Object.assign(sub(), { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', stripe_subscription_id: 'sub_1', credits_remaining: 3 });
    const paid = { id: 'evt_r1', type: 'invoice.paid', data: { object: { id: 'in_r', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } } } } };
    const checkout = { id: 'evt_r2', type: 'checkout.session.completed', data: { object: { id: 'cs_r', mode: 'subscription', subscription: 'sub_1', metadata: { user_id: 'u1' } } } };
    currentSub = subscription({ latest_invoice: 'in_r' } as Partial<Stripe.Subscription>);
    await Promise.all([deliver(paid), deliver(checkout)]);
    expect(creditTx().filter((t) => t.transaction_type === 'monthly_reset' && t.reference_id === 'in_r')).toHaveLength(1);
    expect(sub().credits_remaining).toBe(500);
  });

  it('invoice.paid for a new period resets the credits once', async () => {
    Object.assign(sub(), { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', stripe_subscription_id: 'sub_1', credits_remaining: 3 });
    const event = { id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_2', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } } } };
    await deliver(event);
    await deliver({ ...event, id: 'evt_3b' }); // a different event about the same invoice
    expect(sub().credits_remaining).toBe(500);
    expect(creditTx()).toHaveLength(1);
  });

  it('a paid proration invoice (an upgrade) does not reset the balance', async () => {
    Object.assign(sub(), { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', stripe_subscription_id: 'sub_1', credits_remaining: 725 });
    await deliver({ id: 'evt_pr', type: 'invoice.paid', data: { object: { id: 'in_pr', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: 'sub_1' } } } } });
    expect(sub().credits_remaining).toBe(725);
    expect(creditTx()).toHaveLength(0);
  });

  it('a failed payment is past_due; the third suspends the account and says so by email', async () => {
    currentSub = subscription({ status: 'past_due' });
    for (let i = 1; i <= 3; i++) {
      await deliver({ id: `evt_f${i}`, type: 'invoice.payment_failed', data: { object: { id: `in_f${i}`, parent: { subscription_details: { subscription: 'sub_1' } } } } });
      expect(sub().status).toBe('past_due');
      expect(db.user_account_meta_v2[0].account_status).toBe(i < 3 ? 'active' : 'suspended');
    }
    expect(sub().payment_failures).toBe(3);
    expect(sent.at(-1)?.subject).toMatch(/paused/);
  });

  it('an admin lock is never lifted or replaced by billing', async () => {
    db.user_account_meta_v2[0].account_status = 'locked';
    await deliver({ id: 'evt_l', type: 'checkout.session.completed', data: { object: { id: 'cs_l', mode: 'subscription', subscription: 'sub_1', metadata: { user_id: 'u1' } } } });
    expect(db.user_account_meta_v2[0].account_status).toBe('locked');
  });

  it('cancellation keeps access until the paid period ends, and suspends once it has', async () => {
    await deliver({ id: 'evt_c1', type: 'customer.subscription.deleted', data: { object: subscription({ status: 'canceled' }) } });
    expect(sub().status).toBe('cancelled');
    expect(db.user_account_meta_v2[0].account_status).toBe('active');
    const ended = subscription({ status: 'canceled' });
    (ended.items.data[0] as unknown as Row).current_period_end = Math.floor(Date.now() / 1000) - 60;
    await deliver({ id: 'evt_c2', type: 'customer.subscription.deleted', data: { object: ended } });
    expect(db.user_account_meta_v2[0].account_status).toBe('suspended');
  });

  it('an upgrade via subscription.updated raises credits to the new allowance, never lowering them', async () => {
    Object.assign(sub(), { tier_id: 'f6623f21-95a8-4598-9659-bf09b240cc2f', stripe_subscription_id: 'sub_1', credits_remaining: 80 });
    await deliver({ id: 'evt_u', type: 'customer.subscription.updated', data: { object: subscription() } });
    expect(sub()).toMatchObject({ tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', credits_remaining: 500 });
  });

  it('a credit pack is added by the webhook, once per payment', async () => {
    const event = { id: 'evt_p', type: 'checkout.session.completed', data: { object: {
      id: 'cs_p', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 2500,
      metadata: { kind: 'credits', user_id: 'u1', credits: '25' } } } };
    await deliver(event);
    await deliver({ ...event, id: 'evt_p2' });
    expect(sub().credits_remaining).toBe(175);
    const purchase = creditTx().filter((t) => t.transaction_type === 'purchase');
    expect(purchase).toHaveLength(1);
    expect(purchase[0]).toMatchObject({ stripe_payment_intent_id: 'pi_1', amount: 25, balance_after: 175 });
  });

  it('answers 500 when processing fails, so Stripe retries, and records the failure', async () => {
    const event = { id: 'evt_x', type: 'checkout.session.completed', data: { object: { id: 'cs_x', mode: 'payment', payment_status: 'paid', metadata: { kind: 'credits', user_id: 'u1', credits: '5' } } } };
    expect((await deliver(event)).status).toBe(500);
    expect(db.stripe_events_v2[0]).toMatchObject({ id: 'evt_x', status: 'failed' });
  });
});

describe('billing routes', () => {
  it('starts Checkout for a paid tier with the right price, customer and return URLs', async () => {
    const r = await call('POST', '/api/billing/checkout', { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'annual' });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ checkout_url: 'https://checkout.stripe.test/cs_test_1' });
    const [, params] = stripeCalls.find((c) => c[0] === 'checkout.create')! as [string, Record<string, unknown>];
    expect(params).toMatchObject({ mode: 'subscription', customer: 'cus_1', line_items: [{ price: 'price_pro_y', quantity: 1 }] });
    expect(String(params.success_url)).toContain('/billing/success?session_id={CHECKOUT_SESSION_ID}');
  });

  it('never charges staff or the comp tier', async () => {
    authAs = { effectiveRole: 'superuser' };
    expect((await call('POST', '/api/billing/checkout', { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'monthly' })).status).toBe(403);
    authAs = { subscriptionTier: { name: 'free_full', credit_purchase_price_cents: 100 } };
    expect((await call('POST', '/api/billing/checkout', { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'monthly' })).status).toBe(403);
    expect(stripeCalls).toHaveLength(0);
  });

  it('refuses to start payments when the webhook cannot fulfil them', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await call('POST', '/api/billing/checkout', { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'monthly' })).status).toBe(503);
  });

  it('a downgrade is scheduled for the period end; an upgrade is charged now', async () => {
    Object.assign(sub(), { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'monthly', stripe_subscription_id: 'sub_1' });
    const schedules: unknown[] = [];
    Object.assign(fakeStripe, { subscriptionSchedules: {
      create: async () => ({ id: 'sched_1', phases: [{ start_date: 1, end_date: end }] }),
      update: async (_id: string, p: unknown) => { schedules.push(p); return {}; },
    } });
    const down = await call('POST', '/api/billing/change', { tier_id: 'f6623f21-95a8-4598-9659-bf09b240cc2f', billing_cycle: 'monthly' });
    expect(down.json.data).toMatchObject({ change: 'downgrade' });
    expect(sub().pending_tier_id).toBe('f6623f21-95a8-4598-9659-bf09b240cc2f');
    expect(JSON.stringify(schedules[0])).toContain('price_std_m');
    // Pro monthly -> Pro annual is cheaper per month, so it would wait for the period end too.
    // A real upgrade: Standard -> Pro.
    Object.assign(sub(), { tier_id: 'f6623f21-95a8-4598-9659-bf09b240cc2f', pending_tier_id: null });
    const up = await call('POST', '/api/billing/change', { tier_id: '4b66a358-8593-4bbd-a4fd-8b93488a3079', billing_cycle: 'monthly' });
    expect(up.json.data).toMatchObject({ change: 'upgrade', effective: 'now' });
    expect(stripeCalls.find((c) => c[0] === 'subscriptions.update')?.[1]).toMatchObject({ proration_behavior: 'always_invoice' });
  });

  it('a paid tier can no longer be activated for free through /account/subscribe', async () => {
    const r = await call('POST', '/api/account/subscribe', { tier_name: 'pro', billing_cycle: 'monthly' });
    expect(r.status).toBe(402);
    expect(sub().tier_id).toBe('ef610ed6-bba6-43cc-88af-385ad7b2caef');
  });
});

describe('credits', () => {
  it('a deduction that would go below zero is refused in one statement', async () => {
    const { deductCredits } = await import('../services/credits.js');
    const ok = await deductCredits('u1', 100, 'chapter');
    expect(ok).toMatchObject({ ok: true, balance_after: 50 });
    const over = await deductCredits('u1', 100, 'chapter');
    expect(over).toMatchObject({ ok: false, reason: 'INSUFFICIENT_CREDITS' });
    expect(sub().credits_remaining).toBe(50);
  });

  it('monthlyCents normalises annual and monthly prices', async () => {
    const { monthlyCents } = await import('../routes/billing-admin.js');
    expect(monthlyCents({ unit_amount: 49900, recurring: { interval: 'year', interval_count: 1 } } as never)).toBe(4158);
    expect(monthlyCents({ unit_amount: 4999, recurring: { interval: 'month', interval_count: 1 } } as never)).toBe(4999);
  });
});

describe('reader print orders', () => {
  beforeEach(() => {
    db.print_orders_v2 = [{ id: 'proof-1', user_id: 'author', project_id: 'p1', sku: 'SKU', page_count: 300, spine_in: 0.7, interior_path: 'a/i.pdf',
      outside_path: 'a/c.pdf', preview_path: null, edition: 'softcover_matte', volume_index: 1, quote: { unit_price: 6.1 }, status: 'DRAFT' }];
    db.print_offers_v2 = [{ id: '11111111-1111-1111-1111-111111111111', user_id: 'author', project_id: 'p1', volume_index: 1, edition: 'softcover_matte',
      source_order_id: 'proof-1', price_cents: 1999, currency: 'usd', enabled: true }];
  });

  it('the order pages let the form go on to Stripe Checkout, under the app CSP', async () => {
    const { withStripeFormAction } = await import('../routes/book-print.js');
    expect(withStripeFormAction("default-src 'self';form-action 'self';img-src 'self'")).toBe("default-src 'self';form-action 'self' https://checkout.stripe.com;img-src 'self'");
    expect(withStripeFormAction("default-src 'self'")).toContain("form-action 'self' https://checkout.stripe.com");
  });

  it('the reader form is checked on the server', async () => {
    const { readForm } = await import('../routes/book-print.js');
    expect(readForm({ offer_id: 'x' }).error).toMatch(/edition/);
    const ok = readForm({ offer_id: '11111111-1111-1111-1111-111111111111', quantity: '2', name: 'Ann Reader', email: 'ann@example.test',
      address1: '1 Main St', city: 'Baltimore', regionCode: 'md', postal: '21201', country: 'US' });
    expect(ok.error).toBeUndefined();
    expect(ok.destination?.regionCode).toBe('MD');
    expect(readForm({ ...ok.values, quantity: '50' }).error).toMatch(/between 1 and/);
  });

  it('checkout prices on the server, and the order goes to RPI only after payment', async () => {
    const { startReaderCheckout, fulfilReaderPrintOrder } = await import('../services/reader-print.js');
    const { url, orderId } = await startReaderCheckout({
      slug: 'the-ossuary', projectId: 'p1', offerId: '11111111-1111-1111-1111-111111111111', quantity: 2,
      destination: { name: 'Ann Reader', address1: '1 Main St', city: 'Baltimore', regionCode: 'MD', postal: '21201', country: 'US' },
      shippingClassification: 'standard', buyerEmail: 'ann@example.test', bookTitle: 'The Ossuary',
    });
    expect(url).toContain('checkout.stripe.test');
    const order = db.print_orders_v2.find((r) => r.id === orderId)!;
    expect(order).toMatchObject({ status: 'AWAITING_PAYMENT', order_kind: 'reader', amount_total_cents: 2 * 1999 + 750, interior_path: 'a/i.pdf' });
    expect(rpiCreate).not.toHaveBeenCalled();
    const session = { id: 'cs_test_1', payment_status: 'paid', amount_total: 4748, payment_intent: 'pi_r', metadata: { kind: 'reader_print', order_id: orderId } };
    await fulfilReaderPrintOrder(session as never);
    expect(rpiCreate).toHaveBeenCalledTimes(1);
    expect(order.status).toBe('RECEIVED');
    expect(sent.map((m) => m.to)).toContain('ann@example.test');
    await fulfilReaderPrintOrder(session as never); // a webhook retry
    expect(rpiCreate).toHaveBeenCalledTimes(1);
  });

  it('a paid order RPI refuses stays PAID for the retry, never lost', async () => {
    const { startReaderCheckout, fulfilReaderPrintOrder, retryPaidReaderOrders } = await import('../services/reader-print.js');
    const { orderId } = await startReaderCheckout({
      slug: 's', projectId: 'p1', offerId: '11111111-1111-1111-1111-111111111111', quantity: 1,
      destination: { name: 'A', address1: '1', city: 'C', regionCode: 'MD', postal: '1', country: 'US' },
      shippingClassification: 'standard', buyerEmail: 'a@example.test', bookTitle: 'T',
    });
    rpiCreate.mockRejectedValueOnce(new Error('RPI down'));
    await fulfilReaderPrintOrder({ id: 'cs', payment_status: 'paid', amount_total: 2749, payment_intent: 'pi', metadata: { kind: 'reader_print', order_id: orderId } } as never);
    const order = db.print_orders_v2.find((r) => r.id === orderId)!;
    expect(order.status).toBe('PAID');
    expect(String(order.last_event)).toMatch(/RPI down/);
    expect(await retryPaidReaderOrders()).toEqual({ retried: 1, placed: 1 });
    expect(order.status).toBe('RECEIVED');
  });
});
