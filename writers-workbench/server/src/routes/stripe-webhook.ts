/**
 * POST /api/webhooks/stripe — every entitlement change comes through here (Sprint 9, S9-4).
 *
 * The client never grants anything: a Checkout "success" page only shows what this handler has
 * already written. The body must reach constructEvent byte-for-byte, so the route takes its own raw
 * parser and is mounted BEFORE express.json() in index.ts.
 *
 * Each event is recorded in stripe_events_v2 first. A retry of an event already `processed` is
 * answered 200 and skipped; a failure is recorded and answered 500 so Stripe retries it.
 */
import express, { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { getStripeClient, stripeConfigured } from '../services/stripe.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import {
  applyStripeSubscription,
  grantPeriodCredits,
  grantPurchasedCredits,
  handleInvoiceFailed,
  handleInvoicePaid,
  handleSubscriptionDeleted,
  loadTier,
} from '../services/billing.js';
import { fulfilReaderPrintOrder, readerOrderPaymentFailed } from '../services/reader-print.js';
import { applySavedCardSession, pauseAutoRecharge, releaseAutoRechargeClaim, setDefaultPaymentMethod } from '../services/credit-packs.js';
import { sendEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

export const stripeWebhookRouter = Router();

async function emailUser(userId: string, subject: string, html: string): Promise<void> {
  const { data } = await getSupabaseAdmin().from('users_v2').select('email').eq('user_id', userId).maybeSingle();
  if (!data?.email) return;
  await sendEmail({ to: data.email, subject, html });
}

async function paymentFailedEmail(userId: string, failures: number): Promise<void> {
  const last = failures >= 3;
  await emailUser(
    userId,
    last ? 'Your Writers Workbench account is paused: payment failed' : 'Your payment failed',
    `<p>We could not take the payment for your Writers Workbench plan${failures > 1 ? ` (attempt ${failures})` : ''}.</p>` +
      `<p>${last ? 'Your account is paused until the payment goes through.' : 'Stripe will try again in a few days.'} ` +
      `You can update your card from the Billing page.</p>`,
  );
}

export async function autoRechargePausedEmail(userId: string, reason: string): Promise<void> {
  await emailUser(
    userId,
    'Auto-recharge is paused: please update your card',
    `<p>We tried to recharge your Writers Workbench credits automatically, but the payment did not go through.</p>` +
      `<p>${reason}.</p><p>Auto-recharge is paused and will not try again until you update your card on the Billing page and switch it back on.</p>`,
  );
}

/** A credit payment's metadata -> the grant (any source: Checkout, saved card, auto-recharge). */
async function grantFromPaymentIntent(pi: Stripe.PaymentIntent): Promise<string | null> {
  const m = pi.metadata ?? {};
  if (m.kind !== 'credits') return null;
  const userId = m.user_id;
  const credits = Number(m.credits ?? 0);
  if (!userId || !credits) throw new Error(`credit payment ${pi.id} is missing user or credits`);
  await grantPurchasedCredits(userId, credits, pi.amount_received || pi.amount, pi.id, {
    pack: m.pack, quantity: m.quantity ? Number(m.quantity) : undefined, source: m.source,
  });
  if (m.source === 'auto_recharge') await releaseAutoRechargeClaim(userId, pi.id, `Recharged ${credits} credits`);
  return userId;
}

/** What one event does. Returns the user it concerned (for the log), or null. */
export async function processStripeEvent(event: Stripe.Event): Promise<string | null> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const kind = session.metadata?.kind;
      if (kind === 'reader_print') return fulfilReaderPrintOrder(session);
      if (session.mode === 'setup' && kind === 'save_card') return applySavedCardSession(session);
      if (session.mode === 'subscription' && session.subscription) {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await getStripeClient().subscriptions.retrieve(subId);
        const applied = await applyStripeSubscription(sub);
        if (!applied) return null;
        // The first period's allowance. invoice.paid for the same invoice grants nothing twice.
        const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
        await grantPeriodCredits(applied.userId, applied.tier, invoiceId ?? `checkout-${session.id}`,
          `Subscribed to ${applied.tier.display_name}`);
        return applied.userId;
      }
      if (session.mode === 'payment' && kind === 'credits' && session.payment_status === 'paid') {
        const userId = session.metadata?.user_id;
        const credits = Number(session.metadata?.credits ?? 0);
        const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (!userId || !credits || !pi) throw new Error(`credit checkout ${session.id} is missing user, credits or payment`);
        await grantPurchasedCredits(userId, credits, session.amount_total ?? 0, pi, {
          pack: session.metadata?.pack,
          quantity: session.metadata?.quantity ? Number(session.metadata.quantity) : undefined,
          source: session.metadata?.source,
        });
        // The card Checkout saved (setup_future_usage) becomes the default if the user has none yet.
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (customerId && session.metadata?.pack) {
          try {
            const intent = await getStripeClient().paymentIntents.retrieve(pi);
            const pm = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
            if (pm) await setDefaultPaymentMethod(customerId, pm, true);
          } catch (err) {
            logger.warn({ err }, 'stripe webhook: default card not set after checkout');
          }
        }
        return userId;
      }
      return null;
    }
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === 'reader_print') return readerOrderPaymentFailed(session, 'checkout expired');
      return null;
    }
    case 'invoice.paid':
      return handleInvoicePaid(event.data.object as Stripe.Invoice);
    case 'invoice.payment_failed':
      return handleInvoiceFailed(event.data.object as Stripe.Invoice, paymentFailedEmail);
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const applied = await applyStripeSubscription(sub);
      if (!applied) return null;
      // An upgrade mid-period (or a scheduled downgrade arriving) changes the tier: the new tier's
      // allowance applies now, never lowering a balance the user already has. Not on `created`:
      // a new subscription's first allowance is granted by checkout.session.completed, once.
      if (event.type === 'customer.subscription.updated' && applied.previousTierId && applied.previousTierId !== applied.tier.id) {
        const prev = await loadTier(applied.previousTierId);
        const upgrade = (prev?.monthly_credits ?? 0) < applied.tier.monthly_credits;
        await grantPeriodCredits(applied.userId, applied.tier, `tier-change-${event.id}`,
          `Changed plan to ${applied.tier.display_name}`, upgrade ? 'atLeast' : 'reset');
        await getSupabaseAdmin().from('user_subscriptions')
          .update({ pending_tier_id: null, pending_billing_cycle: null, pending_change_at: null })
          .eq('user_id', applied.userId).eq('pending_tier_id', applied.tier.id);
      }
      return applied.userId;
    }
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
    case 'payment_intent.succeeded':
      // Saved-card purchases and auto-recharges are PaymentIntents with no Checkout session. A
      // Checkout purchase arrives here too and is granted once (unique per PaymentIntent).
      return grantFromPaymentIntent(event.data.object as Stripe.PaymentIntent);
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind !== 'credits' || pi.metadata?.source !== 'auto_recharge' || !pi.metadata.user_id) return null;
      // Usually already paused by the synchronous decline; this covers a failure Stripe reports later.
      await pauseAutoRecharge(pi.metadata.user_id, pi.last_payment_error?.message ?? 'The auto-recharge payment failed', autoRechargePausedEmail);
      return pi.metadata.user_id;
    }
    default:
      return null;
  }
}

async function claimEvent(event: Stripe.Event): Promise<'new' | 'done'> {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('stripe_events_v2').select('status').eq('id', event.id).maybeSingle();
  if (data?.status === 'processed' || data?.status === 'ignored') return 'done';
  const obj = event.data.object as { id?: string };
  await sb.from('stripe_events_v2').upsert({
    id: event.id, event_type: event.type, livemode: event.livemode, status: 'processing',
    object_id: obj?.id ?? null, payload: event as unknown as Record<string, unknown>, error: null,
  }, { onConflict: 'id' });
  return 'new';
}

stripeWebhookRouter.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripeConfigured() || !secret) {
    res.status(503).json({ error: 'stripe webhooks are not configured' });
    return;
  }
  let event: Stripe.Event;
  try {
    const sig = req.get('stripe-signature') ?? '';
    event = getStripeClient().webhooks.constructEvent(req.body as Buffer, sig, secret);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'stripe webhook: signature rejected');
    res.status(400).json({ error: 'invalid signature' });
    return;
  }
  try {
    if ((await claimEvent(event)) === 'done') {
      res.json({ received: true, duplicate: true });
      return;
    }
    const userId = await processStripeEvent(event);
    await getSupabaseAdmin().from('stripe_events_v2')
      .update({ status: userId ? 'processed' : 'ignored', user_id: userId, processed_at: new Date().toISOString() })
      .eq('id', event.id);
    logger.info({ eventId: event.id, type: event.type, userId }, 'stripe webhook: processed');
    res.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, eventId: event.id, type: event.type }, 'stripe webhook: processing failed');
    await getSupabaseAdmin().from('stripe_events_v2').update({ status: 'failed', error: message.slice(0, 1000) }).eq('id', event.id);
    // Not 200: Stripe retries until this succeeds.
    res.status(500).json({ error: 'processing failed' });
  }
});
