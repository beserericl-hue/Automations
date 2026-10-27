/**
 * Reader print orders: a reader buys a printed copy from the book's public page, pays through
 * Stripe Checkout, and only then is the order placed with RPI (migration 039).
 *
 *   offer      the author switches a prepared edition on at a price (print_offers_v2); the files are
 *              that prepared order's, so a reader gets exactly the proof the author approved
 *   quote      shipping options to the reader's address, from RPI
 *   checkout   a reader order row (AWAITING_PAYMENT) and a Stripe Checkout session; the shipping
 *              price is quoted again here, so a price in the browser's form is never trusted
 *   fulfil     the Stripe webhook: PAID, then the RPI order; RECEIVED once RPI has it
 *
 * If RPI refuses or is down after the reader has paid, the order stays PAID with the error recorded
 * and retryPaidReaderOrders (the billing sync cron) places it later. It is never left paid and lost.
 */
import crypto from 'crypto';
import type Stripe from 'stripe';
import { getSupabaseAdmin } from './supabase-admin.js';
import { appUrl, getStripeClient } from './stripe.js';
import { logger } from '../lib/logger.js';
import { sendEmail } from '../lib/email.js';
import {
  EDITIONS,
  RpiError,
  createOrder,
  rpiMode,
  shippingOptions,
  type Destination,
  type EditionKey,
  type ShippingOption,
} from '../lib/rpi-print.js';

const BUCKET = 'print-files';
const SIGNED_URL_SECONDS = 7 * 24 * 3600;
export const CHECKOUT_MINUTES = 30;

export interface Offer {
  id: string;
  user_id: string;
  project_id: string;
  volume_index: number;
  edition: EditionKey;
  source_order_id: string;
  price_cents: number;
  currency: string;
  enabled: boolean;
}

export interface SourceOrder {
  id: string;
  sku: string;
  page_count: number;
  spine_in: number | null;
  interior_path: string;
  outside_path: string;
  preview_path: string | null;
  edition: EditionKey;
  volume_index: number;
  quote: Record<string, unknown> | null;
}

export class ReaderPrintError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export async function enabledOffers(projectId: string): Promise<Offer[]> {
  const { data } = await getSupabaseAdmin().from('print_offers_v2').select('*')
    .eq('project_id', projectId).eq('enabled', true).order('price_cents');
  return (data ?? []) as Offer[];
}

async function offerWithSource(offerId: string, projectId: string): Promise<{ offer: Offer; source: SourceOrder }> {
  const sb = getSupabaseAdmin();
  const { data: offer } = await sb.from('print_offers_v2').select('*').eq('id', offerId).eq('project_id', projectId).eq('enabled', true).maybeSingle();
  if (!offer) throw new ReaderPrintError('NO_OFFER', 'That edition is not for sale.', 404);
  const { data: source } = await sb.from('print_orders_v2')
    .select('id, sku, page_count, spine_in, interior_path, outside_path, preview_path, edition, volume_index, quote')
    .eq('id', (offer as Offer).source_order_id).maybeSingle();
  if (!source) throw new ReaderPrintError('NO_FILES', 'The print files for this edition are missing.', 409);
  return { offer: offer as Offer, source: source as SourceOrder };
}

export async function quoteShipping(offerId: string, projectId: string, quantity: number, destination: Destination): Promise<{ offer: Offer; options: ShippingOption[] }> {
  const { offer, source } = await offerWithSource(offerId, projectId);
  const options = await shippingOptions(source.sku, quantity, destination);
  return { offer, options };
}

/** RPI prices shipping in dollars; Stripe wants cents. */
export function cents(dollars: number): number {
  return Math.round(dollars * 100);
}

export async function startReaderCheckout(input: {
  slug: string;
  projectId: string;
  offerId: string;
  quantity: number;
  destination: Destination;
  shippingClassification: string;
  buyerEmail: string;
  bookTitle: string;
}): Promise<{ url: string; orderId: string }> {
  const { offer, source } = await offerWithSource(input.offerId, input.projectId);
  const options = await shippingOptions(source.sku, input.quantity, input.destination);
  const ship = options.find((o) => o.methodClassification === input.shippingClassification);
  if (!ship) throw new ReaderPrintError('NO_SHIPPING', 'That shipping option is not available to this address.');
  const shippingCents = cents(ship.price);
  const totalCents = offer.price_cents * input.quantity + shippingCents;
  const edition = EDITIONS[offer.edition];

  const id = crypto.randomUUID();
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('print_orders_v2').insert({
    id,
    user_id: offer.user_id,
    project_id: offer.project_id,
    volume_index: source.volume_index,
    edition: offer.edition,
    sku: source.sku,
    mode: rpiMode(),
    quantity: input.quantity,
    page_count: source.page_count,
    spine_in: source.spine_in,
    interior_path: source.interior_path,
    outside_path: source.outside_path,
    preview_path: source.preview_path,
    status: 'AWAITING_PAYMENT',
    order_kind: 'reader',
    buyer_email: input.buyerEmail,
    buyer_name: input.destination.name,
    destination: input.destination,
    shipping_classification: input.shippingClassification,
    amount_total_cents: totalCents,
    currency: offer.currency,
    offer_id: offer.id,
    quote: { unit_price_cents: offer.price_cents, shipping_cents: shippingCents, shipping: ship },
    events: [{ source: 'CheckoutStarted', time: new Date().toISOString(), status: 'AWAITING_PAYMENT' }],
  });
  if (error) throw new Error(`could not record the order: ${error.message}`);

  const base = appUrl();
  const session = await getStripeClient().checkout.sessions.create({
    mode: 'payment',
    customer_email: input.buyerEmail,
    client_reference_id: id,
    line_items: [{
      quantity: input.quantity,
      price_data: {
        currency: offer.currency,
        unit_amount: offer.price_cents,
        product_data: { name: `${input.bookTitle} — ${edition.label}`, description: `${source.page_count} pages, printed and shipped by RPI` },
      },
    }],
    shipping_options: [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: `${ship.methodName || input.shippingClassification} shipping`,
        fixed_amount: { amount: shippingCents, currency: offer.currency },
      },
    }],
    metadata: { kind: 'reader_print', order_id: id, project_id: offer.project_id, slug: input.slug },
    payment_intent_data: { metadata: { kind: 'reader_print', order_id: id } },
    success_url: `${base}/books/${input.slug}/print/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/books/${input.slug}/print?cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
  }, { idempotencyKey: `ww-reader-print-${id}` });
  await sb.from('print_orders_v2').update({ stripe_checkout_session_id: session.id }).eq('id', id);
  if (!session.url) throw new Error('Stripe returned no checkout URL');
  return { url: session.url, orderId: id };
}

async function signed(path: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin().storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`could not sign ${path}`);
  return data.signedUrl;
}

function rpiWebhookUrl(): string | undefined {
  const base = appUrl();
  if (!base.startsWith('https://') || /localhost|127\.0\.0\.1/.test(base)) return undefined;
  return `${base}/api/print/webhook`;
}

interface OrderRow {
  id: string;
  user_id: string;
  project_id: string;
  status: string;
  sku: string;
  edition: EditionKey;
  quantity: number;
  page_count: number;
  interior_path: string;
  outside_path: string;
  destination: Destination;
  shipping_classification: string;
  amount_total_cents: number | null;
  buyer_email: string | null;
  buyer_name: string | null;
  events: unknown[] | null;
}

/** Hand a paid reader order to RPI. Leaves it PAID with the error if RPI refuses; never throws. */
export async function placeWithRpi(row: OrderRow): Promise<boolean> {
  const edition = EDITIONS[row.edition];
  const sb = getSupabaseAdmin();
  try {
    const files = {
      gutsUrl: await signed(row.interior_path),
      ...(edition.outside === 'jacket' ? { dustJacketUrl: await signed(row.outside_path) } : { coverUrl: await signed(row.outside_path) }),
    };
    const created = await createOrder({
      customerOrderId: `ww-${row.id}`,
      payload: row.id,
      webhookUrl: rpiWebhookUrl(),
      shippingClassification: row.shipping_classification,
      destination: row.destination,
      sku: row.sku,
      quantity: row.quantity,
      itemDescription: `${edition.label} — ${row.page_count} pages`,
      files,
      pageCount: row.page_count,
    });
    const now = new Date().toISOString();
    await sb.from('print_orders_v2').update({
      status: 'RECEIVED', customer_order_id: created.customerOrderId, submitted_at: now, updated_at: now,
      last_event: 'OrderSubmitted',
      events: [...(row.events ?? []), { source: 'OrderSubmitted', time: now, status: 'RECEIVED' }].slice(-60),
    }).eq('id', row.id);
    logger.info({ orderId: row.id }, 'reader-print: placed with RPI');
    return true;
  } catch (err) {
    const message = err instanceof RpiError ? err.message : err instanceof Error ? err.message : String(err);
    // RPI answers a second create for the same customerOrderId as a conflict: it already has it.
    if (err instanceof RpiError && err.status === 409) {
      await sb.from('print_orders_v2').update({ status: 'RECEIVED', customer_order_id: `ww-${row.id}`, last_event: 'OrderSubmitted' }).eq('id', row.id);
      return true;
    }
    logger.error({ err, orderId: row.id }, 'reader-print: paid but not placed with RPI');
    await sb.from('print_orders_v2').update({ last_event: `RpiRefused: ${message}`.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', row.id);
    return false;
  }
}

/** checkout.session.completed for a reader order. Returns the order id. */
export async function fulfilReaderPrintOrder(session: Stripe.Checkout.Session): Promise<string | null> {
  const orderId = session.metadata?.order_id;
  if (!orderId) return null;
  const sb = getSupabaseAdmin();
  const { data } = await sb.from('print_orders_v2').select('*').eq('id', orderId).maybeSingle();
  const row = data as OrderRow | null;
  if (!row) throw new Error(`reader order ${orderId} not found`);
  if (row.status !== 'AWAITING_PAYMENT' && row.status !== 'PAID') return orderId; // already handled
  if (session.payment_status !== 'paid') return orderId; // async methods settle later
  if (row.status === 'AWAITING_PAYMENT') {
    if (row.amount_total_cents != null && session.amount_total != null && session.amount_total !== row.amount_total_cents) {
      logger.error({ orderId, paid: session.amount_total, expected: row.amount_total_cents }, 'reader-print: amount paid differs from the order');
    }
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    const now = new Date().toISOString();
    const events = [...(row.events ?? []), { source: 'PaymentReceived', time: now, status: 'PAID' }];
    await sb.from('print_orders_v2').update({ status: 'PAID', paid_at: now, stripe_payment_intent_id: pi, events, updated_at: now }).eq('id', orderId).eq('status', 'AWAITING_PAYMENT');
    row.status = 'PAID';
    row.events = events;
    await notifyPaid(row).catch((err) => logger.warn({ err, orderId }, 'reader-print: confirmation email not sent'));
  }
  await placeWithRpi(row);
  return orderId;
}

export async function readerOrderPaymentFailed(session: Stripe.Checkout.Session, why: string): Promise<string | null> {
  const orderId = session.metadata?.order_id;
  if (!orderId) return null;
  await getSupabaseAdmin().from('print_orders_v2')
    .update({ status: 'PAYMENT_EXPIRED', last_event: why, updated_at: new Date().toISOString() })
    .eq('id', orderId).eq('status', 'AWAITING_PAYMENT');
  return orderId;
}

/** Paid reader orders RPI has not taken yet, retried (the billing sync cron). */
export async function retryPaidReaderOrders(): Promise<{ retried: number; placed: number }> {
  const { data } = await getSupabaseAdmin().from('print_orders_v2').select('*')
    .eq('order_kind', 'reader').eq('status', 'PAID').limit(25);
  let placed = 0;
  for (const row of (data ?? []) as OrderRow[]) if (await placeWithRpi(row)) placed++;
  return { retried: (data ?? []).length, placed };
}

async function notifyPaid(row: OrderRow): Promise<void> {
  const edition = EDITIONS[row.edition];
  const total = row.amount_total_cents != null ? `$${(row.amount_total_cents / 100).toFixed(2)}` : '';
  if (row.buyer_email) {
    await sendEmail({
      to: row.buyer_email,
      subject: 'Your printed copy is on order',
      html: `<p>Thank you${row.buyer_name ? `, ${row.buyer_name.split(' ')[0]}` : ''}. We have your payment${total ? ` of ${total}` : ''} ` +
        `for ${row.quantity} × ${edition.label}.</p><p>The book is printed to order and we will email you when it ships.</p>`,
    });
  }
  const { data: author } = await getSupabaseAdmin().from('users_v2').select('email').eq('user_id', row.user_id).maybeSingle();
  if (author?.email) {
    await sendEmail({
      to: author.email,
      subject: `A reader ordered ${row.quantity} printed ${row.quantity === 1 ? 'copy' : 'copies'}`,
      html: `<p>${row.buyer_name ?? 'A reader'} paid ${total} for ${row.quantity} × ${edition.label}. The order is going to RPI now.</p>`,
    });
  }
}
