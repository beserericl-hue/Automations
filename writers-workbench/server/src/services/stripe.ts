/**
 * The Stripe client (Sprint 9, S9-1). Lazy, like supabase-admin.ts.
 *
 * Mode comes from the key, never from a flag: an sk_test_ key is test mode and an sk_live_ key is
 * live mode, so a DEV service cannot charge a real card by mistake and a test customer id is never
 * sent to a live key (stripe_customers_v2.mode).
 */
import Stripe from 'stripe';

let _client: Stripe | null = null;

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('STRIPE_SECRET_KEY is not set: payments are not configured on this server');
    this.name = 'StripeNotConfiguredError';
  }
}

export function stripeConfigured(): boolean {
  return /^(sk|rk)_(test|live)_/.test((process.env.STRIPE_SECRET_KEY || '').trim());
}

/** Configured AND able to fulfil: payments are only taken when the webhook can grant what was paid for. */
export function paymentsReady(): boolean {
  return stripeConfigured() && Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim());
}

export function stripeMode(): 'test' | 'live' {
  return /^(sk|rk)_live_/.test((process.env.STRIPE_SECRET_KEY || '').trim()) ? 'live' : 'test';
}

export function getStripeClient(): Stripe {
  if (!_client) {
    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!stripeConfigured()) throw new StripeNotConfiguredError();
    _client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'Writers Workbench' } });
  }
  return _client;
}

/** For tests: forget the client so a changed environment is read again. */
export function resetStripeClient(client: Stripe | null = null): void {
  _client = client;
}

/** The app's public address, for Checkout's success / cancel / portal return URLs. */
export function appUrl(): string {
  const configured = (process.env.PUBLIC_APP_URL || process.env.ALLOWED_ORIGINS?.split(',')[0] || '').trim();
  return (configured || 'http://localhost:5173').replace(/\/$/, '');
}

/** A Stripe timestamp (seconds) as ISO, or null. */
export function isoFromUnix(value: number | null | undefined): string | null {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/**
 * The subscription's current period. Since API 2025-03-31 the period lives on each subscription
 * ITEM, not on the subscription; a single-price subscription has one item.
 */
export function subscriptionPeriod(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0];
  return { start: isoFromUnix(item?.current_period_start), end: isoFromUnix(item?.current_period_end) };
}

/** The subscription an invoice belongs to (API 2025+: under `parent.subscription_details`). */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const s = invoice.parent?.subscription_details?.subscription;
  if (!s) return null;
  return typeof s === 'string' ? s : s.id;
}
