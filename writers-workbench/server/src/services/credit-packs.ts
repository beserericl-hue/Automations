/**
 * Book plans, top-ups, the saved card and evergreen auto-recharge (owner decisions 2026-11-03;
 * migration 053). Builds on Sprint 9 (docs/stripe-billing.md): Stripe is the source of truth for
 * cards and payments, Supabase for access, and credits change ONLY in the signed webhook.
 *
 *   - A card is a Stripe PaymentMethod attached to the Stripe Customer and set as
 *     customer.invoice_settings.default_payment_method (and on the subscription, if there is one). It
 *     is collected by Stripe Checkout in `setup` mode; display fields are read from Stripe. Our DB
 *     stores no card data (stripe_customers_v2 already maps user -> customer).
 *   - One-off purchases (N books, a top-up): an on-session PaymentIntent on the default card, or
 *     Checkout when there is no card (or the bank wants 3-D Secure, which only Stripe's page can do
 *     without Stripe.js). Checkout saves the card for next time.
 *   - Auto-recharge: Stripe cannot see our balance, so the trigger is here (after a deduction). The
 *     charge is an off-session PaymentIntent on the default card; credits come from the webhook.
 *     Exactly once per crossing: a conditional UPDATE claims billing_settings_v2 before the
 *     PaymentIntent exists and only the webhook (or the failure) releases it. A decline or an
 *     authentication request pauses auto-recharge, records why, and emails the user — no retry loop.
 *   - Purchase history is read from Stripe (PaymentIntents + receipt URLs) joined to the ledger.
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from './supabase-admin.js';
import { appUrl, getStripeClient, isoFromUnix, paymentsReady } from './stripe.js';
import { existingCustomerId, getOrCreateStripeCustomer } from './stripe-sync.js';
import { logger } from '../lib/logger.js';

export type PackKind = 'book' | 'topup';

export interface CreditPack {
  id: string;
  name: string;
  kind: PackKind;
  display_name: string;
  description: string | null;
  credits: number;
  price_cents: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  active: boolean;
  sort_order: number;
}

/** Books per purchase: "3 books" is one payment. */
export const MAX_PACK_QUANTITY = 20;

const PACK_COLUMNS = 'id, name, kind, display_name, description, credits, price_cents, stripe_product_id, stripe_price_id, active, sort_order';

/** Active packs in display order. Empty when the table is not there yet (server ahead of 053). */
export async function listCreditPacks(): Promise<CreditPack[]> {
  const { data, error } = await getSupabaseAdmin().from('credit_packs_v2').select(PACK_COLUMNS).eq('active', true).order('sort_order');
  if (error) return [];
  return (data ?? []) as unknown as CreditPack[];
}

export async function findCreditPack(name: string): Promise<CreditPack | null> {
  const { data } = await getSupabaseAdmin().from('credit_packs_v2').select(PACK_COLUMNS).eq('name', name).eq('active', true).maybeSingle();
  return (data as unknown as CreditPack | null) ?? null;
}

/** What the client sees: no Stripe ids. */
export function publicPack(p: CreditPack): Pick<CreditPack, 'name' | 'kind' | 'display_name' | 'description' | 'credits' | 'price_cents'> {
  return { name: p.name, kind: p.kind, display_name: p.display_name, description: p.description, credits: p.credits, price_cents: p.price_cents };
}

export type PurchaseSource = 'checkout' | 'saved_card' | 'auto_recharge';

/** The metadata every credit payment carries. The webhook grants `credits` from it. */
export function creditMetadata(userId: string, pack: CreditPack, quantity: number, source: PurchaseSource): Record<string, string> {
  return {
    kind: 'credits',
    user_id: userId,
    credits: String(pack.credits * quantity),
    pack: pack.name,
    pack_kind: pack.kind,
    quantity: String(quantity),
    source,
  };
}

// ------------------------------------------------------------------------------------------------
// The card (a Stripe PaymentMethod)
// ------------------------------------------------------------------------------------------------

export interface CardView {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

function cardView(pm: Stripe.PaymentMethod | null | undefined): CardView | null {
  if (!pm || !pm.card) return null;
  return { id: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year };
}

/** The customer's default card, read from Stripe. */
export async function defaultCard(customerId: string): Promise<CardView | null> {
  const customer = await getStripeClient().customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
  if ('deleted' in customer && customer.deleted) return null;
  const pm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
  return typeof pm === 'string' ? cardView(await getStripeClient().paymentMethods.retrieve(pm)) : cardView(pm as Stripe.PaymentMethod | null);
}

/** Checkout in setup mode: Stripe collects the card; the webhook (or the return page) makes it the default. */
export async function startSaveCardCheckout(userId: string): Promise<string | null> {
  const customer = await getOrCreateStripeCustomer(userId);
  const session = await getStripeClient().checkout.sessions.create({
    mode: 'setup',
    customer,
    currency: 'usd',
    client_reference_id: userId,
    metadata: { kind: 'save_card', user_id: userId },
    setup_intent_data: { metadata: { kind: 'save_card', user_id: userId } },
    success_url: `${appUrl()}/billing?card=saved&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing?card=cancelled`,
  });
  return session.url;
}

/**
 * Make a PaymentMethod the default for the customer AND their subscription (so renewals use it).
 * `onlyIfNone`: used after a Checkout purchase — keep a default the user already chose.
 */
export async function setDefaultPaymentMethod(customerId: string, paymentMethodId: string, onlyIfNone = false): Promise<boolean> {
  const stripe = getStripeClient();
  if (onlyIfNone && (await defaultCard(customerId))) return false;
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  for (const s of subs.data) {
    if (['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)) {
      await stripe.subscriptions.update(s.id, { default_payment_method: paymentMethodId });
    }
  }
  return true;
}

/** A completed setup-mode Checkout: its card becomes the default. Idempotent. */
export async function applySavedCardSession(session: Stripe.Checkout.Session): Promise<string | null> {
  const userId = session.metadata?.user_id ?? null;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  if (!userId || !customerId || !siId) return null;
  const si = await getStripeClient().setupIntents.retrieve(siId);
  const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (si.status !== 'succeeded' || !pm) return null;
  await setDefaultPaymentMethod(customerId, pm);
  // A new card is the user's answer to "update your card": auto-recharge may run again.
  await getSupabaseAdmin().from('billing_settings_v2')
    .update({ auto_recharge_paused: false, auto_recharge_paused_reason: null, auto_recharge_paused_at: null,
      auto_recharge_last_event: `Card ending ${(await defaultCard(customerId))?.last4 ?? '????'} saved`, auto_recharge_last_event_at: new Date().toISOString() })
    .eq('user_id', userId).eq('auto_recharge_paused', true);
  logger.info({ userId, customerId }, 'billing: default card saved');
  return userId;
}

/** Remove the saved card from the customer (Stripe detach). Auto-recharge cannot run without one. */
export async function removeDefaultCard(userId: string): Promise<boolean> {
  const customerId = await existingCustomerId(userId);
  if (!customerId) return false;
  const card = await defaultCard(customerId);
  if (!card) return false;
  await getStripeClient().paymentMethods.detach(card.id);
  await getSupabaseAdmin().from('billing_settings_v2').update({ auto_recharge_enabled: false }).eq('user_id', userId);
  logger.info({ userId }, 'billing: default card removed');
  return true;
}

// ------------------------------------------------------------------------------------------------
// One-off purchases
// ------------------------------------------------------------------------------------------------

export async function startPackCheckout(userId: string, pack: CreditPack, quantity = 1): Promise<{ checkout_url: string | null; total_cents: number }> {
  const customer = await getOrCreateStripeCustomer(userId);
  const meta = creditMetadata(userId, pack, quantity, 'checkout');
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = pack.stripe_price_id
    ? { price: pack.stripe_price_id, quantity }
    : { quantity, price_data: { currency: 'usd', unit_amount: pack.price_cents, product_data: { name: `Writers Workbench — ${pack.display_name} (${pack.credits} credits)` } } };
  const session = await getStripeClient().checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: userId,
    line_items: [lineItem],
    metadata: meta,
    // Keep the card for one-click purchases and auto-recharge; the webhook makes it the default
    // when the customer has none.
    payment_intent_data: { metadata: meta, setup_future_usage: 'off_session' },
    success_url: `${appUrl()}/billing?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing?purchase=cancelled`,
  });
  return { checkout_url: session.url, total_cents: pack.price_cents * quantity };
}

export type PurchaseOutcome =
  | { status: 'succeeded' | 'processing'; payment_intent: string; total_cents: number; credits: number }
  | { status: 'checkout'; checkout_url: string | null; total_cents: number; credits: number; reason: 'no_card' | 'authentication_required' }
  | { status: 'failed'; message: string; payment_intent?: string };

/**
 * Buy `quantity` of a pack. With a saved card: an on-session PaymentIntent confirmed now (credits
 * arrive by webhook in seconds). Without one, or when the bank asks for authentication: Checkout.
 */
export async function purchasePack(userId: string, pack: CreditPack, quantity: number): Promise<PurchaseOutcome> {
  const customer = await getOrCreateStripeCustomer(userId);
  const card = await defaultCard(customer);
  const total = pack.price_cents * quantity;
  const credits = pack.credits * quantity;
  if (!card) {
    const c = await startPackCheckout(userId, pack, quantity);
    return { status: 'checkout', checkout_url: c.checkout_url, total_cents: total, credits, reason: 'no_card' };
  }
  const stripe = getStripeClient();
  try {
    const pi = await stripe.paymentIntents.create({
      amount: total,
      currency: 'usd',
      customer,
      payment_method: card.id,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      confirm: true,
      description: `${quantity} x ${pack.display_name} (${credits} credits)`,
      metadata: creditMetadata(userId, pack, quantity, 'saved_card'),
    });
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      return { status: pi.status === 'succeeded' ? 'succeeded' : 'processing', payment_intent: pi.id, total_cents: total, credits };
    }
    if (pi.status === 'requires_action') {
      await stripe.paymentIntents.cancel(pi.id).catch(() => undefined);
      const c = await startPackCheckout(userId, pack, quantity);
      return { status: 'checkout', checkout_url: c.checkout_url, total_cents: total, credits, reason: 'authentication_required' };
    }
    return { status: 'failed', message: `The payment did not go through (${pi.status}).`, payment_intent: pi.id };
  } catch (err) {
    const e = err as { type?: string; message?: string; payment_intent?: { id?: string } };
    if (e.type === 'StripeCardError') return { status: 'failed', message: e.message ?? 'The card was declined.', payment_intent: e.payment_intent?.id };
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------
// Purchase history (Stripe, joined to the ledger)
// ------------------------------------------------------------------------------------------------

export interface PurchaseRow {
  id: string;
  date: string | null;
  kind: 'book' | 'topup' | 'auto_recharge' | 'custom';
  pack: string | null;
  quantity: number;
  credits: number;
  amount_cents: number;
  status: string;
  credited: boolean;
  receipt_url: string | null;
  failure: string | null;
}

export async function purchaseHistory(userId: string): Promise<PurchaseRow[]> {
  const customerId = await existingCustomerId(userId);
  if (!customerId) return [];
  const list = await getStripeClient().paymentIntents.list({ customer: customerId, limit: 50, expand: ['data.latest_charge'] });
  const credit = list.data.filter((pi) => pi.metadata?.kind === 'credits');
  const ids = credit.map((pi) => pi.id);
  const credited = new Set<string>();
  if (ids.length) {
    const { data } = await getSupabaseAdmin().from('credit_transactions').select('stripe_payment_intent_id')
      .eq('user_id', userId).eq('transaction_type', 'purchase').in('stripe_payment_intent_id', ids);
    for (const r of (data ?? []) as Array<{ stripe_payment_intent_id: string }>) credited.add(r.stripe_payment_intent_id);
  }
  return credit
    // A saved-card attempt cancelled for 3-D Secure (then bought through Checkout) is not a purchase.
    .filter((pi) => !(pi.status === 'canceled' && pi.metadata?.source === 'saved_card'))
    .map((pi) => {
      const charge = (typeof pi.latest_charge === 'object' ? pi.latest_charge : null) as Stripe.Charge | null;
      const m = pi.metadata ?? {};
      const kind = m.source === 'auto_recharge' ? 'auto_recharge' : m.pack_kind === 'book' ? 'book' : m.pack ? 'topup' : 'custom';
      const failed = pi.last_payment_error?.message ?? (charge?.status === 'failed' ? charge.failure_message ?? 'failed' : null);
      return {
        id: pi.id,
        date: isoFromUnix(pi.created),
        kind,
        pack: m.pack ?? null,
        quantity: Number(m.quantity ?? 1),
        credits: Number(m.credits ?? 0),
        amount_cents: pi.amount,
        status: credited.has(pi.id) ? 'paid' : pi.status === 'succeeded' ? 'paid (crediting)' : failed ? 'failed' : pi.status,
        credited: credited.has(pi.id),
        receipt_url: charge?.receipt_url ?? null,
        failure: failed,
      } satisfies PurchaseRow;
    });
}

// ------------------------------------------------------------------------------------------------
// Evergreen auto-recharge
// ------------------------------------------------------------------------------------------------

export interface AutoRechargeSettings {
  auto_recharge_enabled: boolean;
  auto_recharge_threshold: number;
  auto_recharge_pack: string | null;
  auto_recharge_monthly_cap_cents: number | null;
  auto_recharge_paused: boolean;
  auto_recharge_paused_reason: string | null;
  auto_recharge_paused_at: string | null;
  auto_recharge_claimed_at: string | null;
  auto_recharge_claim_pi: string | null;
  auto_recharge_last_event: string | null;
  auto_recharge_last_event_at: string | null;
}

const SETTINGS_COLUMNS =
  'auto_recharge_enabled, auto_recharge_threshold, auto_recharge_pack, auto_recharge_monthly_cap_cents, auto_recharge_paused, ' +
  'auto_recharge_paused_reason, auto_recharge_paused_at, auto_recharge_claimed_at, auto_recharge_claim_pi, auto_recharge_last_event, auto_recharge_last_event_at';

export const DEFAULT_AUTO_RECHARGE: AutoRechargeSettings = {
  auto_recharge_enabled: false, auto_recharge_threshold: 100, auto_recharge_pack: 'topup_500', auto_recharge_monthly_cap_cents: null,
  auto_recharge_paused: false, auto_recharge_paused_reason: null, auto_recharge_paused_at: null, auto_recharge_claimed_at: null,
  auto_recharge_claim_pi: null, auto_recharge_last_event: null, auto_recharge_last_event_at: null,
};

export async function getAutoRecharge(userId: string): Promise<AutoRechargeSettings> {
  const { data } = await getSupabaseAdmin().from('billing_settings_v2').select(SETTINGS_COLUMNS).eq('user_id', userId).maybeSingle();
  return { ...DEFAULT_AUTO_RECHARGE, ...((data as unknown as Partial<AutoRechargeSettings>) ?? {}) };
}

export async function saveAutoRecharge(
  userId: string,
  patch: { enabled: boolean; threshold: number; pack: string; monthly_cap_cents: number | null },
): Promise<AutoRechargeSettings> {
  const row: Record<string, unknown> = {
    user_id: userId,
    auto_recharge_enabled: patch.enabled,
    auto_recharge_threshold: patch.threshold,
    auto_recharge_pack: patch.pack,
    auto_recharge_monthly_cap_cents: patch.monthly_cap_cents,
  };
  // Switching it on again is the user's "resume": clear the pause and any stale claim.
  if (patch.enabled) Object.assign(row, { auto_recharge_paused: false, auto_recharge_paused_reason: null, auto_recharge_paused_at: null });
  const { error } = await getSupabaseAdmin().from('billing_settings_v2').upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  return getAutoRecharge(userId);
}

/** A claim older than this is considered abandoned (the server died between claim and Stripe). */
export const CLAIM_STALE_MS = 15 * 60_000;

/** Successful auto-recharge spend this calendar month (UTC), from the ledger. */
async function autoRechargeSpendThisMonth(userId: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { data } = await getSupabaseAdmin().from('credit_transactions').select('metadata')
    .eq('user_id', userId).eq('transaction_type', 'purchase').gte('created_at', start.toISOString());
  return ((data ?? []) as Array<{ metadata: Record<string, unknown> | null }>)
    .filter((r) => r.metadata?.source === 'auto_recharge')
    .reduce((n, r) => n + Number(r.metadata?.price_paid_cents ?? 0), 0);
}

async function noteEvent(userId: string, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  await getSupabaseAdmin().from('billing_settings_v2')
    .update({ auto_recharge_last_event: event.slice(0, 500), auto_recharge_last_event_at: new Date().toISOString(), ...extra })
    .eq('user_id', userId);
}

/** Pause after a failed off-session charge. Never retried automatically; the user is told. */
export async function pauseAutoRecharge(userId: string, reason: string, notify?: (userId: string, reason: string) => Promise<void>): Promise<void> {
  await getSupabaseAdmin().from('billing_settings_v2').update({
    auto_recharge_paused: true,
    auto_recharge_paused_reason: reason.slice(0, 500),
    auto_recharge_paused_at: new Date().toISOString(),
    auto_recharge_claimed_at: null,
    auto_recharge_claim_pi: null,
    auto_recharge_last_event: `Paused: ${reason}`.slice(0, 500),
    auto_recharge_last_event_at: new Date().toISOString(),
  }).eq('user_id', userId);
  logger.warn({ userId, reason }, 'billing: auto-recharge paused');
  if (notify) await notify(userId, reason).catch((err) => logger.warn({ err }, 'billing: auto-recharge pause email not sent'));
}

/** The webhook granted (or Stripe failed) the recharge: release the claim so the next crossing can fire. */
export async function releaseAutoRechargeClaim(userId: string, paymentIntentId: string, event: string): Promise<void> {
  await getSupabaseAdmin().from('billing_settings_v2')
    .update({ auto_recharge_claimed_at: null, auto_recharge_claim_pi: null, auto_recharge_last_event: event.slice(0, 500), auto_recharge_last_event_at: new Date().toISOString() })
    // The webhook can beat the line that records the claim's PaymentIntent id, so an unrecorded
    // claim (claim_pi still null) is this payment's too.
    .eq('user_id', userId).or(`auto_recharge_claim_pi.eq.${paymentIntentId},auto_recharge_claim_pi.is.null`);
}

let pauseNotifier: ((userId: string, reason: string) => Promise<void>) | undefined;
/** The email sender for "auto-recharge paused" (wired in index.ts, so this module needs no mailer). */
export function setAutoRechargePauseNotifier(fn: (userId: string, reason: string) => Promise<void>): void {
  pauseNotifier = fn;
}

/**
 * After a deduction left `balance`: buy the user's auto-recharge pack if they are below their
 * threshold. Returns what happened (for tests and logs). Never throws.
 *
 * Once per crossing: the claim is one UPDATE ... WHERE claimed_at IS NULL (or stale) — of N concurrent
 * deductions exactly one gets a row back. The claim is held until the webhook grants the credits
 * (releaseAutoRechargeClaim), so deductions in between, still below the threshold, do not buy again.
 */
export async function maybeAutoRecharge(userId: string, balance: number): Promise<string> {
  try {
    if (!paymentsReady()) return 'payments-off';
    const s = await getAutoRecharge(userId);
    if (!s.auto_recharge_enabled || s.auto_recharge_paused || !s.auto_recharge_pack) return 'off';
    if (balance >= s.auto_recharge_threshold) return 'above-threshold';
    const sb = getSupabaseAdmin();
    const now = new Date();
    const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
    const { data: claimed } = await sb.from('billing_settings_v2')
      .update({ auto_recharge_claimed_at: now.toISOString(), auto_recharge_claim_pi: null })
      .eq('user_id', userId).eq('auto_recharge_enabled', true).eq('auto_recharge_paused', false)
      .or(`auto_recharge_claimed_at.is.null,auto_recharge_claimed_at.lt.${stale}`)
      .select('user_id');
    if (!claimed || claimed.length === 0) return 'already-claimed';

    const release = async (event: string) => {
      await sb.from('billing_settings_v2').update({ auto_recharge_claimed_at: null, auto_recharge_claim_pi: null }).eq('user_id', userId);
      await noteEvent(userId, event);
    };
    const pack = await findCreditPack(s.auto_recharge_pack);
    if (!pack) {
      await release(`Skipped: pack ${s.auto_recharge_pack} is not on sale`);
      return 'no-pack';
    }
    if (s.auto_recharge_monthly_cap_cents) {
      const spent = await autoRechargeSpendThisMonth(userId);
      if (spent + pack.price_cents > s.auto_recharge_monthly_cap_cents) {
        await release(`Skipped: monthly cap reached ($${(spent / 100).toFixed(2)} of $${(s.auto_recharge_monthly_cap_cents / 100).toFixed(2)})`);
        return 'cap-reached';
      }
    }
    const customerId = await existingCustomerId(userId);
    const card = customerId ? await defaultCard(customerId) : null;
    if (!customerId || !card) {
      await pauseAutoRecharge(userId, 'No saved card', pauseNotifier);
      return 'no-card';
    }
    try {
      const pi = await getStripeClient().paymentIntents.create({
        amount: pack.price_cents,
        currency: 'usd',
        customer: customerId,
        payment_method: card.id,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        off_session: true,
        confirm: true,
        description: `Auto-recharge: ${pack.display_name} (${pack.credits} credits)`,
        metadata: creditMetadata(userId, pack, 1, 'auto_recharge'),
      }, { idempotencyKey: `auto-recharge:${userId}:${now.toISOString()}` });
      // Only while the claim is still held: if the webhook already granted and released it, leave it.
      await sb.from('billing_settings_v2').update({ auto_recharge_claim_pi: pi.id }).eq('user_id', userId).not('auto_recharge_claimed_at', 'is', null);
      await noteEvent(userId, `Recharging ${pack.credits} credits (balance ${balance} < ${s.auto_recharge_threshold})`);
      logger.info({ userId, pi: pi.id, status: pi.status, pack: pack.name, balance }, 'billing: auto-recharge charged');
      if (pi.status === 'requires_action') {
        await pauseAutoRecharge(userId, 'Your bank asked to confirm the payment (authentication required)', pauseNotifier);
        return 'requires-action';
      }
      return pi.status;
    } catch (err) {
      const e = err as { type?: string; code?: string; message?: string; decline_code?: string };
      const reason = e.code === 'authentication_required'
        ? 'Your bank asked to confirm the payment (authentication required)'
        : `The card was declined${e.decline_code ? ` (${e.decline_code})` : ''}: ${e.message ?? 'payment failed'}`;
      await pauseAutoRecharge(userId, reason, pauseNotifier);
      return e.code === 'authentication_required' ? 'requires-action' : 'declined';
    }
  } catch (err) {
    logger.error({ err, userId }, 'billing: auto-recharge check failed');
    return 'error';
  }
}
