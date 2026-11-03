/**
 * Book plans, top-ups, the saved card and evergreen auto-recharge (2026-11-03), server side. Stripe
 * and Supabase are in-memory fakes; the webhook is driven with real Stripe signatures.
 *
 * PASS: the Billing wallet lists Half Book (1,000 / $99), Full Book (2,000 / $199) and the top-ups;
 * "3 Full Books" is ONE payment of $597 on the saved card and +6,000 credits only when the webhook
 * says it was paid — once, however often it is delivered; with no card (or 3-D Secure) it goes to
 * Checkout, which saves the card; a saved card becomes the customer's AND the subscription's default;
 * auto-recharge fires exactly once per crossing even when several deductions race, is released by the
 * webhook grant, respects the monthly cap, and on a decline or an authentication request pauses,
 * says why, emails the user and never retries on its own; the purchase history comes from Stripe and
 * says which payments were credited.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import Stripe from 'stripe';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const UNIQUE: Record<string, string[]> = { user_subscriptions: ['user_id'], stripe_customers_v2: ['user_id'], stripe_events_v2: ['id'], billing_settings_v2: ['user_id'] };

/** PostgREST `or` filters this code uses: `col.is.null`, `col.eq.X`, `col.lt.X`. */
function orFilter(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [col, op, ...rest] = p.split('.');
    const v = rest.join('.');
    return (r: Row) => (op === 'is' && v === 'null' ? (r[col] ?? null) === null
      : op === 'eq' ? String(r[col]) === v
      : op === 'lt' ? r[col] != null && String(r[col]) < v : false);
  });
  return (r) => parts.some((p) => p(r));
}

vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: Row | Row[] = {};
    let conflict = '';
    const rows = () => (db[table] ??= []);
    const run = (): Row[] => {
      const list = Array.isArray(payload) ? payload : [payload];
      if (op === 'insert') {
        return list.map((p) => {
          if (table === 'credit_transactions' && p.stripe_payment_intent_id && p.transaction_type === 'purchase'
            && rows().some((r) => r.stripe_payment_intent_id === p.stripe_payment_intent_id && r.transaction_type === 'purchase')) {
            throw new Error('duplicate key value violates unique constraint');
          }
          const row = { id: `${table}-${rows().length + 1}`, created_at: new Date().toISOString(), ...p };
          rows().push(row);
          return row;
        });
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
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return hit.map((r) => ({ ...r })); }
      if (op === 'delete') { db[table] = rows().filter((r) => !hit.includes(r)); return hit; }
      return hit.map((r) => ({ ...r }));
    };
    const exec = () => { try { return { data: run(), error: null }; } catch (err) { return { data: null, error: { message: (err as Error).message } }; } };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      upsert: (p: Row | Row[], o?: { onConflict?: string }) => ((op = 'upsert'), (payload = p), (conflict = o?.onConflict ?? ''), q),
      delete: () => ((op = 'delete'), q),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, _o: string, v: unknown) => (f.push((r) => (r[c] ?? null) !== v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      gte: (c: string, v: string) => (f.push((r) => String(r[c]) >= v), q),
      or: (expr: string) => (f.push(orFilter(expr)), q),
      order: () => q, limit: () => q, range: () => q,
      single: () => { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      maybeSingle: () => { const r = exec(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(exec()).then(ok, bad),
    };
    return q;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'credits_add_v2') return { data: null, error: { message: `${fn} does not exist` } };
    const sub = (db.user_subscriptions ?? []).find((r) => r.user_id === args.p_user_id);
    const delta = Number(args.p_delta);
    if (!sub || Number(sub.credits_remaining) + delta < 0) return { data: null, error: null };
    sub.credits_remaining = Number(sub.credits_remaining) + delta;
    return { data: sub.credits_remaining, error: null };
  };
  return { getSupabaseAdmin: () => ({ from, rpc }) };
});

const sent: Array<{ to: string; subject: string }> = [];
vi.mock('../lib/email.js', () => ({ sendEmail: async (m: { to: string; subject: string }) => { sent.push(m); return { ok: true } } }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
let authAs: Row = {};
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => { Object.assign(req, { userId: 'u1', effectiveRole: 'user', subscriptionTier: { name: 'standard', credit_purchase_price_cents: 100 }, creditsRemaining: 150 }, authAs); next(); },
  requireAdmin: (_q: unknown, _s: unknown, n: () => void) => n(),
  requireSuperuser: (_q: unknown, _s: unknown, n: () => void) => n(),
  requireTierFeature: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

const WEBHOOK_SECRET = 'whsec_test_secret';
const PACKS = [
  { id: 'pk1', name: 'half_book', kind: 'book', display_name: 'Half Book', description: null, credits: 1000, price_cents: 9900, stripe_product_id: 'prod_h', stripe_price_id: 'price_half', active: true, sort_order: 10 },
  { id: 'pk2', name: 'full_book', kind: 'book', display_name: 'Full Book', description: null, credits: 2000, price_cents: 19900, stripe_product_id: 'prod_f', stripe_price_id: 'price_full', active: true, sort_order: 20 },
  { id: 'pk3', name: 'topup_250', kind: 'topup', display_name: 'Top-up 250', description: null, credits: 250, price_cents: 2900, stripe_product_id: null, stripe_price_id: null, active: true, sort_order: 30 },
  { id: 'pk4', name: 'topup_500', kind: 'topup', display_name: 'Top-up 500', description: null, credits: 500, price_cents: 5500, stripe_product_id: null, stripe_price_id: null, active: true, sort_order: 40 },
];

// ---- fake Stripe ------------------------------------------------------------------------------
const calls: Array<[string, Record<string, unknown>]> = [];
let defaultPm: string | null = 'pm_card';
/** How the next PaymentIntent confirm behaves. */
let piMode: 'succeed' | 'decline' | 'auth_required' | 'requires_action' = 'succeed';
const pis: Stripe.PaymentIntent[] = [];
const card = (id: string) => ({ id, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 } });
const fakeStripe = {
  webhooks: new Stripe('sk_test_fake').webhooks,
  customers: {
    create: async () => ({ id: 'cus_1' }),
    retrieve: async () => ({ id: 'cus_1', invoice_settings: { default_payment_method: defaultPm ? card(defaultPm) : null } }),
    update: async (_id: string, p: Record<string, unknown>) => {
      calls.push(['customers.update', p]);
      defaultPm = String((p.invoice_settings as Row).default_payment_method);
      return {};
    },
  },
  paymentMethods: {
    retrieve: async (id: string) => card(id),
    detach: async (id: string) => { calls.push(['paymentMethods.detach', { id }]); defaultPm = null; return {}; },
  },
  subscriptions: {
    list: async () => ({ data: [{ id: 'sub_1', status: 'active' }] }),
    update: async (id: string, p: Record<string, unknown>) => { calls.push(['subscriptions.update', { id, ...p }]); return {}; },
  },
  setupIntents: { retrieve: async () => ({ id: 'seti_1', status: 'succeeded', payment_method: 'pm_new' }) },
  paymentIntents: {
    create: async (p: Record<string, unknown>) => {
      calls.push(['paymentIntents.create', p]);
      const id = `pi_${pis.length + 1}`;
      if (piMode === 'decline' || piMode === 'auth_required') {
        const pi = { id, status: 'requires_payment_method', amount: p.amount, metadata: p.metadata, created: 1, last_payment_error: { message: 'Your card was declined.' } } as unknown as Stripe.PaymentIntent;
        pis.push(pi);
        throw Object.assign(new Error('Your card was declined.'), {
          type: 'StripeCardError', code: piMode === 'decline' ? 'card_declined' : 'authentication_required', decline_code: piMode === 'decline' ? 'insufficient_funds' : undefined, payment_intent: pi,
        });
      }
      const pi = { id, status: piMode === 'requires_action' ? 'requires_action' : 'succeeded', amount: p.amount, amount_received: p.amount, metadata: p.metadata, created: 1700000000,
        latest_charge: { status: 'succeeded', receipt_url: `https://pay.stripe.test/receipts/${id}` } } as unknown as Stripe.PaymentIntent;
      pis.push(pi);
      return pi;
    },
    cancel: async (id: string) => { calls.push(['paymentIntents.cancel', { id }]); const pi = pis.find((x) => x.id === id); if (pi) (pi as unknown as Row).status = 'canceled'; return pi; },
    retrieve: async (id: string) => ({ id, payment_method: 'pm_checkout' }),
    list: async () => ({ data: [...pis].reverse() }),
  },
  checkout: { sessions: {
    create: async (p: Record<string, unknown>) => { calls.push(['checkout.create', p]); return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }; },
    retrieve: async () => ({ id: 'cs_test_setup', mode: 'setup', customer: 'cus_1', setup_intent: 'seti_1', metadata: { kind: 'save_card', user_id: 'u1' } }),
  } },
};

async function app() {
  const { resetStripeClient } = await import('../services/stripe.js');
  resetStripeClient(fakeStripe as unknown as Stripe);
  const { stripeWebhookRouter } = await import('../routes/stripe-webhook.js');
  const { billingRouter } = await import('../routes/billing.js');
  const a = express();
  a.use('/api/webhooks/stripe', stripeWebhookRouter);
  a.use(express.json());
  a.use('/api/billing', billingRouter);
  return a;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string): Promise<{ status: number; json: Json }> {
  const server = (await app()).listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } finally { server.close(); }
}
let evt = 0;
async function deliver(type: string, object: Record<string, unknown>, id = `evt_${++evt}`) {
  const payload = JSON.stringify({ object: 'event', livemode: false, id, type, data: { object } });
  const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return call('POST', '/api/webhooks/stripe', undefined, { 'stripe-signature': header }, payload);
}
const balance = () => Number(db.user_subscriptions[0].credits_remaining);
const purchases = () => (db.credit_transactions ?? []).filter((t) => t.transaction_type === 'purchase');
const createdPIs = () => calls.filter((c) => c[0] === 'paymentIntents.create');
const settings = () => db.billing_settings_v2?.[0] ?? {};

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.credit_packs_v2 = PACKS.map((p) => ({ ...p }));
  db.users_v2 = [{ user_id: 'u1', email: 'writer@example.test' }];
  db.user_subscriptions = [{ id: 'sub-row', user_id: 'u1', credits_remaining: 150, credits_used_this_period: 0 }];
  db.stripe_customers_v2 = [{ user_id: 'u1', stripe_customer_id: 'cus_1', mode: 'test' }];
  calls.length = 0;
  pis.length = 0;
  sent.length = 0;
  defaultPm = 'pm_card';
  piMode = 'succeed';
  authAs = {};
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterAll(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; });

describe('book plans and top-ups', () => {
  it('the wallet lists Half Book 1,000/$99, Full Book 2,000/$199 and the top-ups, and the saved card from Stripe', async () => {
    const r = await call('GET', '/api/billing/wallet');
    expect(r.json.data.packs).toEqual([
      expect.objectContaining({ name: 'half_book', kind: 'book', credits: 1000, price_cents: 9900 }),
      expect.objectContaining({ name: 'full_book', kind: 'book', credits: 2000, price_cents: 19900 }),
      expect.objectContaining({ name: 'topup_250', kind: 'topup' }),
      expect.objectContaining({ name: 'topup_500', kind: 'topup' }),
    ]);
    expect(r.json.data.card).toEqual({ brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 });
    expect(JSON.stringify(r.json.data.packs)).not.toContain('price_full'); // no Stripe ids to the client
  });

  it('3 Full Books is one $597 payment on the saved card; +6,000 credits only from the webhook, once', async () => {
    const r = await call('POST', '/api/billing/purchase', { pack: 'full_book', quantity: 3 });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'succeeded', credits: 6000, total_cents: 59700 });
    const [, p] = createdPIs()[0];
    expect(p).toMatchObject({ amount: 59700, customer: 'cus_1', payment_method: 'pm_card', confirm: true,
      metadata: { kind: 'credits', user_id: 'u1', credits: '6000', pack: 'full_book', quantity: '3', source: 'saved_card' } });
    expect(balance()).toBe(150); // nothing granted by the route
    const pi = pis[0];
    await deliver('payment_intent.succeeded', pi as unknown as Row);
    await deliver('payment_intent.succeeded', pi as unknown as Row); // a second delivery
    expect(balance()).toBe(6150);
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]).toMatchObject({ amount: 6000, stripe_payment_intent_id: pi.id, metadata: expect.objectContaining({ pack: 'full_book', quantity: 3, source: 'saved_card' }) });
  });

  it('a Checkout purchase and its PaymentIntent event grant once between them', async () => {
    const meta = { kind: 'credits', user_id: 'u1', credits: '500', pack: 'topup_500', quantity: '1', source: 'checkout' };
    await deliver('checkout.session.completed', { id: 'cs_9', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_co', amount_total: 5500, customer: 'cus_1', metadata: meta });
    await deliver('payment_intent.succeeded', { id: 'pi_co', amount: 5500, amount_received: 5500, metadata: meta });
    expect(balance()).toBe(650);
    expect(purchases()).toHaveLength(1);
  });

  it('with no saved card it goes to Checkout (quantity on the pack Price) and asks Stripe to keep the card', async () => {
    defaultPm = null;
    const r = await call('POST', '/api/billing/purchase', { pack: 'half_book', quantity: 2 });
    expect(r.json.data).toMatchObject({ status: 'checkout', reason: 'no_card', credits: 2000, total_cents: 19800 });
    const [, s] = calls.find((c) => c[0] === 'checkout.create')!;
    expect(s).toMatchObject({ mode: 'payment', customer: 'cus_1', line_items: [{ price: 'price_half', quantity: 2 }],
      payment_intent_data: { setup_future_usage: 'off_session', metadata: expect.objectContaining({ credits: '2000' }) } });
    expect(createdPIs()).toHaveLength(0);
  });

  it('a bank asking for 3-D Secure cancels the attempt and sends the user to Checkout', async () => {
    piMode = 'requires_action';
    const r = await call('POST', '/api/billing/purchase', { pack: 'full_book', quantity: 1 });
    expect(r.json.data).toMatchObject({ status: 'checkout', reason: 'authentication_required' });
    expect(calls.some((c) => c[0] === 'paymentIntents.cancel')).toBe(true);
  });

  it('a declined card is a 402 with Stripe\'s reason and grants nothing', async () => {
    piMode = 'decline';
    const r = await call('POST', '/api/billing/purchase', { pack: 'topup_250', quantity: 1 });
    expect(r.status).toBe(402);
    expect(r.json.error.message).toMatch(/declined/);
    expect(balance()).toBe(150);
  });

  it('refuses a pack that is not on sale and a quantity over 20', async () => {
    expect((await call('POST', '/api/billing/purchase', { pack: 'free_lunch', quantity: 1 })).status).toBe(404);
    expect((await call('POST', '/api/billing/purchase', { pack: 'full_book', quantity: 21 })).status).toBe(400);
  });

  it('staff are never sent to buy anything', async () => {
    authAs = { effectiveRole: 'admin' };
    expect((await call('POST', '/api/billing/purchase', { pack: 'full_book', quantity: 1 })).status).toBe(403);
    expect((await call('POST', '/api/billing/card/setup')).status).toBe(403);
  });
});

describe('the saved card (a Stripe PaymentMethod)', () => {
  it('is collected by Checkout in setup mode and becomes the customer and subscription default', async () => {
    const r = await call('POST', '/api/billing/card/setup');
    expect(r.json.data.checkout_url).toContain('checkout.stripe.test');
    expect(calls.find((c) => c[0] === 'checkout.create')![1]).toMatchObject({ mode: 'setup', customer: 'cus_1', metadata: { kind: 'save_card', user_id: 'u1' } });
    await deliver('checkout.session.completed', { id: 'cs_s', mode: 'setup', customer: 'cus_1', setup_intent: 'seti_1', metadata: { kind: 'save_card', user_id: 'u1' } });
    expect(calls).toContainEqual(['customers.update', { invoice_settings: { default_payment_method: 'pm_new' } }]);
    expect(calls).toContainEqual(['subscriptions.update', { id: 'sub_1', default_payment_method: 'pm_new' }]);
  });

  it('remove detaches it at Stripe and switches auto-recharge off', async () => {
    db.billing_settings_v2 = [{ user_id: 'u1', auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_pack: 'topup_500', auto_recharge_paused: false }];
    const r = await call('DELETE', '/api/billing/card');
    expect(r.json.data.removed).toBe(true);
    expect(calls).toContainEqual(['paymentMethods.detach', { id: 'pm_card' }]);
    expect(settings().auto_recharge_enabled).toBe(false);
  });

  it('a new card un-pauses auto-recharge', async () => {
    db.billing_settings_v2 = [{ user_id: 'u1', auto_recharge_enabled: true, auto_recharge_paused: true, auto_recharge_paused_reason: 'declined' }];
    await deliver('checkout.session.completed', { id: 'cs_s2', mode: 'setup', customer: 'cus_1', setup_intent: 'seti_1', metadata: { kind: 'save_card', user_id: 'u1' } });
    expect(settings()).toMatchObject({ auto_recharge_paused: false, auto_recharge_paused_reason: null });
  });
});

describe('evergreen auto-recharge', () => {
  async function enable(threshold = 100, pack = 'topup_500', cap: number | null = null) {
    return call('PUT', '/api/billing/auto-recharge', { enabled: true, threshold, pack, monthly_cap_cents: cap });
  }
  async function deduct(n: number) {
    const { deductCredits } = await import('../services/credits.js');
    return deductCredits('u1', n, 'test');
  }
  async function wired() {
    const { onBalanceLowered } = await import('../services/credits.js');
    const { maybeAutoRecharge, setAutoRechargePauseNotifier } = await import('../services/credit-packs.js');
    const { autoRechargePausedEmail } = await import('../routes/stripe-webhook.js');
    const fired: Array<Promise<unknown>> = [];
    onBalanceLowered((u, b) => { const p = maybeAutoRecharge(u, b); fired.push(p); return p; });
    setAutoRechargePauseNotifier(autoRechargePausedEmail);
    return async () => { await new Promise((r) => setTimeout(r, 0)); await Promise.all(fired); };
  }

  it('cannot be switched on without a saved card', async () => {
    defaultPm = null;
    const r = await enable();
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('NO_CARD');
  });

  it('fires exactly once when several deductions cross the threshold together; the webhook grant releases it', async () => {
    await app(); // installs the fake Stripe client
    expect((await enable(100, 'topup_500')).status).toBe(200);
    const settle = await wired();
    await Promise.all([deduct(30), deduct(30), deduct(30)]); // 150 -> 60, all three below 100
    await settle();
    expect(createdPIs()).toHaveLength(1);
    expect(createdPIs()[0][1]).toMatchObject({ amount: 5500, off_session: true, confirm: true, payment_method: 'pm_card',
      metadata: expect.objectContaining({ source: 'auto_recharge', credits: '500', pack: 'topup_500' }) });
    expect(settings().auto_recharge_claimed_at).not.toBeNull();
    // Another deduction before the credits land: still claimed, no second charge.
    await deduct(5);
    await settle();
    expect(createdPIs()).toHaveLength(1);
    // Stripe says paid: +500, claim released.
    await deliver('payment_intent.succeeded', pis[0] as unknown as Row);
    expect(balance()).toBe(55 + 500);
    expect(settings().auto_recharge_claimed_at).toBeNull();
    expect(purchases()[0]).toMatchObject({ description: expect.stringContaining('Auto-recharge'), metadata: expect.objectContaining({ source: 'auto_recharge' }) });
    // A later crossing fires again.
    await deduct(500);
    await settle();
    expect(createdPIs()).toHaveLength(2);
  });

  it('a declined off-session charge pauses it, says why, emails the user, and never retries by itself', async () => {
    await app();
    await enable(100, 'topup_250');
    const settle = await wired();
    piMode = 'decline';
    await deduct(80);
    await settle();
    expect(createdPIs()).toHaveLength(1);
    expect(settings()).toMatchObject({ auto_recharge_paused: true, auto_recharge_claimed_at: null });
    expect(String(settings().auto_recharge_paused_reason)).toMatch(/declined.*insufficient_funds/);
    expect(sent).toEqual([expect.objectContaining({ to: 'writer@example.test', subject: expect.stringMatching(/Auto-recharge is paused/) })]);
    await deduct(10);
    await settle();
    expect(createdPIs()).toHaveLength(1); // no loop
    const w = await call('GET', '/api/billing/wallet');
    expect(w.json.data.auto_recharge).toMatchObject({ paused: true, paused_reason: expect.stringMatching(/declined/) });
  });

  it('an authentication request (3-D Secure, off session) pauses it the same way', async () => {
    await app();
    await enable(100, 'topup_250');
    const settle = await wired();
    piMode = 'auth_required';
    await deduct(80);
    await settle();
    expect(settings()).toMatchObject({ auto_recharge_paused: true });
    expect(String(settings().auto_recharge_paused_reason)).toMatch(/authentication required/);
  });

  it('a Stripe-reported failure later (payment_intent.payment_failed) pauses it too', async () => {
    db.billing_settings_v2 = [{ user_id: 'u1', auto_recharge_enabled: true, auto_recharge_paused: false }];
    await deliver('payment_intent.payment_failed', { id: 'pi_x', amount: 2900, metadata: { kind: 'credits', user_id: 'u1', credits: '250', source: 'auto_recharge' }, last_payment_error: { message: 'Your card has insufficient funds.' } });
    expect(settings()).toMatchObject({ auto_recharge_paused: true, auto_recharge_paused_reason: 'Your card has insufficient funds.' });
  });

  it('respects the monthly cap', async () => {
    await app();
    await enable(100, 'topup_500', 5000); // $50 cap, the pack is $55
    const settle = await wired();
    await deduct(80);
    await settle();
    expect(createdPIs()).toHaveLength(0);
    expect(String(settings().auto_recharge_last_event)).toMatch(/monthly cap/);
    expect(settings().auto_recharge_claimed_at).toBeNull();
  });
});

describe('purchase history (Stripe, joined to the ledger)', () => {
  it('lists credit payments with credits, amount, receipt and whether they were credited', async () => {
    await call('POST', '/api/billing/purchase', { pack: 'full_book', quantity: 3 });
    await call('POST', '/api/billing/purchase', { pack: 'topup_250', quantity: 1 });
    await deliver('payment_intent.succeeded', pis[0] as unknown as Row);
    const r = await call('GET', '/api/billing/purchases');
    expect(r.json.data).toEqual([
      expect.objectContaining({ id: 'pi_2', kind: 'topup', credits: 250, amount_cents: 2900, credited: false, receipt_url: 'https://pay.stripe.test/receipts/pi_2' }),
      expect.objectContaining({ id: 'pi_1', kind: 'book', quantity: 3, credits: 6000, amount_cents: 59700, credited: true, status: 'paid' }),
    ]);
  });
});
