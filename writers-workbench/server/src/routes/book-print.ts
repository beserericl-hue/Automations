/**
 * Printed copies sold from a book's public page: /books/<slug>/print (Sprint 9, reader print orders).
 *
 * Like the page itself: server-rendered HTML with plain forms, no app bundle, no script, works with
 * JavaScript off. Three steps, each a page the reader sees before the next:
 *
 *   GET  /books/:slug/print            the editions for sale and an address form
 *   POST /books/:slug/print/quote      shipping options and the total, from RPI
 *   POST /books/:slug/print/checkout   a Stripe Checkout session → 303 to Stripe
 *   GET  /books/:slug/print/thanks     after payment (the order itself is placed by the webhook)
 *
 * Every price is computed on the server at checkout. The quote page's totals are shown, never trusted.
 */
import express, { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { findPage } from './book-pages.js';
import { EDITIONS, RpiError, type Destination } from '../lib/rpi-print.js';
import { ReaderPrintError, cents, enabledOffers, quoteShipping, startReaderCheckout, type Offer } from '../services/reader-print.js';
import { getStripeClient, paymentsReady } from '../services/stripe.js';
import { logger } from '../lib/logger.js';

export const bookPrintRouter = Router();

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[^\s@<>]{2,}$/;
const MAX_QTY = 10;

const limiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  validate: { xForwardedForHeader: false },
});

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function money(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)}</title><meta name="robots" content="noindex">` +
    '<style>body{font:17px/1.6 Georgia,serif;max-width:620px;margin:48px auto;padding:0 16px;color:#2b211b;background:#f6f0e6}' +
    'h1{font-size:28px;line-height:1.2}label{display:block;margin:10px 0 2px}input,select{font:inherit;width:100%;padding:8px;border:1px solid #b9a98f;border-radius:4px;background:#fff;box-sizing:border-box}' +
    '.row{display:flex;gap:10px}.row>div{flex:1}.choice{display:flex;gap:10px;align-items:flex-start;margin:8px 0;padding:10px;border:1px solid #d8ccb6;border-radius:6px;background:#fffdf8}' +
    '.choice input{width:auto;margin-top:6px}button{font:inherit;margin-top:18px;padding:10px 22px;border:0;border-radius:6px;background:#7a2e1a;color:#fff;cursor:pointer}' +
    '.note{padding:10px 12px;border-radius:6px;background:#fff4d6;border:1px solid #e9cf86}.err{background:#fde8e4;border-color:#e7a597}table{width:100%;border-collapse:collapse}td{padding:4px 0}td:last-child{text-align:right}</style>' +
    `</head><body>${body}</body></html>`;
}

/**
 * The quote page's form posts here and is answered with a redirect to Stripe Checkout. The app-wide
 * CSP has `form-action 'self'`, and Chrome applies form-action to the redirect too, so "Pay with
 * Stripe" silently did nothing in a browser (curl, which ignores CSP, worked). These pages allow
 * Stripe's checkout as a form destination; nothing else changes.
 */
export function withStripeFormAction(csp: string): string {
  if (!csp) return csp;
  return /form-action/.test(csp)
    ? csp.replace(/form-action ([^;]*)/, (_m, v: string) => (v.includes('checkout.stripe.com') ? `form-action ${v}` : `form-action ${v.trim()} https://checkout.stripe.com`))
    : `${csp};form-action 'self' https://checkout.stripe.com`;
}

function send(res: Response, status: number, title: string, body: string): void {
  res.setHeader('Cache-Control', 'no-store');
  const csp = res.getHeader('Content-Security-Policy');
  if (typeof csp === 'string') res.setHeader('Content-Security-Policy', withStripeFormAction(csp));
  res.status(status).type('html').send(page(title, body));
}

function unavailable(res: Response, title = 'Printed copies'): void {
  send(res, 404, title, '<h1>Printed copies are not available</h1><p>This book is not sold in print from this page.</p>');
}

function addressFields(v: Record<string, string> = {}): string {
  const f = (name: string, label: string, opts = '') =>
    `<div><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${esc(v[name] ?? '')}" ${opts}></div>`;
  return `${f('name', 'Full name', 'required maxlength="200" autocomplete="name"')}
${f('email', 'Email (for the receipt and shipping updates)', 'required type="email" maxlength="100" autocomplete="email"')}
${f('address1', 'Address', 'required maxlength="50" autocomplete="address-line1"')}
${f('address2', 'Apartment, suite (optional)', 'maxlength="50" autocomplete="address-line2"')}
<div class="row">${f('city', 'City', 'required maxlength="50" autocomplete="address-level2"')}${f('regionCode', 'State / province (e.g. MD)', 'required maxlength="3" autocomplete="address-level1"')}</div>
<div class="row">${f('postal', 'ZIP / postal code', 'required maxlength="20" autocomplete="postal-code"')}
<div><label for="country">Country</label><select id="country" name="country"><option value="US"${v.country === 'CA' ? '' : ' selected'}>United States</option><option value="CA"${v.country === 'CA' ? ' selected' : ''}>Canada</option></select></div></div>`;
}

function hidden(v: Record<string, string>): string {
  return Object.entries(v).map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`).join('');
}

function offerLabel(o: Offer): string {
  return `${EDITIONS[o.edition]?.label ?? o.edition}${o.volume_index > 1 ? ` (Book ${o.volume_index})` : ''}`;
}

/** The reader's form, read and checked. Errors are a message to show, not an exception. */
export function readForm(body: Record<string, unknown>): { values: Record<string, string>; destination?: Destination; quantity: number; offerId: string; error?: string } {
  const values: Record<string, string> = {};
  for (const k of ['offer_id', 'quantity', 'name', 'email', 'address1', 'address2', 'city', 'regionCode', 'postal', 'country', 'shipping']) {
    // eslint-disable-next-line no-control-regex
    values[k] = String(body[k] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }
  const quantity = Math.floor(Number(values.quantity || '1'));
  const offerId = values.offer_id;
  const need = ['name', 'email', 'address1', 'city', 'regionCode', 'postal'] as const;
  if (!/^[0-9a-f-]{36}$/i.test(offerId)) return { values, quantity, offerId, error: 'Choose an edition.' };
  if (!(quantity >= 1 && quantity <= MAX_QTY)) return { values, quantity, offerId, error: `Order between 1 and ${MAX_QTY} copies.` };
  if (need.some((k) => !values[k])) return { values, quantity, offerId, error: 'Fill in your name, email and full address.' };
  if (!EMAIL.test(values.email)) return { values, quantity, offerId, error: 'That email address does not look right.' };
  if (!['US', 'CA'].includes(values.country)) return { values, quantity, offerId, error: 'We ship to the United States and Canada.' };
  const destination: Destination = {
    name: values.name.slice(0, 200), address1: values.address1.slice(0, 50), address2: values.address2.slice(0, 50) || undefined,
    city: values.city.slice(0, 50), regionCode: values.regionCode.toUpperCase().slice(0, 3), postal: values.postal.slice(0, 20),
    country: values.country, email: values.email.slice(0, 100),
  };
  return { values, destination, quantity, offerId };
}

async function loadBook(slug: string): Promise<{ id: string; title: string; offers: Offer[] } | null> {
  const book = await findPage(slug);
  if (!book) return null;
  const offers = await enabledOffers(book.id);
  return offers.length ? { id: book.id, title: book.title, offers } : null;
}

function formPage(slug: string, title: string, offers: Offer[], values: Record<string, string> = {}, message = ''): string {
  const choices = offers.map((o, i) => `<label class="choice"><input type="radio" name="offer_id" value="${o.id}"${values.offer_id === o.id || (!values.offer_id && i === 0) ? ' checked' : ''}>
<span><strong>${esc(offerLabel(o))}</strong><br>${money(o.price_cents)} each, plus shipping</span></label>`).join('');
  return `<p><a href="/books/${esc(slug)}">← ${esc(title)}</a></p><h1>Order a printed copy</h1>
${message ? `<p class="note err">${esc(message)}</p>` : ''}
<form method="post" action="/books/${esc(slug)}/print/quote">${choices}
<label for="quantity">Copies</label><input id="quantity" name="quantity" type="number" min="1" max="${MAX_QTY}" value="${esc(values.quantity || '1')}" required>
${addressFields(values)}<button type="submit">See shipping and total</button></form>
<p><small>Printed to order and shipped by RPI Print. You pay on the next page, through Stripe.</small></p>`;
}

bookPrintRouter.get('/:slug/print', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  try {
    const book = await loadBook(slug);
    if (!book || !paymentsReady()) return unavailable(res);
    const note = req.query.cancelled ? 'Checkout was cancelled. Nothing was charged.' : '';
    send(res, 200, `Order ${book.title}`, formPage(slug, book.title, book.offers, {}, note));
  } catch (err) {
    logger.error({ err, slug }, 'book-print: form failed');
    send(res, 500, 'Printed copies', '<h1>Something went wrong</h1><p>Please try again shortly.</p>');
  }
});

bookPrintRouter.post('/:slug/print/quote', limiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  try {
    const book = await loadBook(slug);
    if (!book || !paymentsReady()) return unavailable(res);
    const form = readForm((req.body ?? {}) as Record<string, unknown>);
    if (form.error || !form.destination) return send(res, 400, `Order ${book.title}`, formPage(slug, book.title, book.offers, form.values, form.error));
    const { offer, options } = await quoteShipping(form.offerId, book.id, form.quantity, form.destination);
    if (!options.length) return send(res, 400, `Order ${book.title}`, formPage(slug, book.title, book.offers, form.values, 'We cannot ship to that address. Please check it.'));
    const books = offer.price_cents * form.quantity;
    const rows = options.map((o, i) => {
      const ship = cents(o.price);
      const eta = o.estimatedDeliveryDateUTC ? ` · arrives about ${new Date(o.estimatedDeliveryDateUTC).toDateString()}` : '';
      return `<label class="choice"><input type="radio" name="shipping" value="${esc(o.methodClassification)}"${i === 0 ? ' checked' : ''}>
<span><strong>${esc(o.methodName || o.methodClassification)}</strong> ${money(ship)}${esc(eta)}<br>Total ${money(books + ship)}</span></label>`;
    }).join('');
    const keep = { ...form.values };
    delete keep.shipping;
    send(res, 200, `Order ${book.title}`, `<p><a href="/books/${esc(slug)}/print">← Change the order</a></p><h1>Shipping and total</h1>
<table><tr><td>${form.quantity} × ${esc(offerLabel(offer))}</td><td>${money(books)}</td></tr></table>
<p>To ${esc(form.destination.name)}, ${esc(form.destination.address1)}, ${esc(form.destination.city)} ${esc(form.destination.regionCode)} ${esc(form.destination.postal)}</p>
<form method="post" action="/books/${esc(slug)}/print/checkout">${hidden(keep)}${rows}<button type="submit">Pay with Stripe</button></form>`);
  } catch (err) {
    const message = err instanceof ReaderPrintError ? err.message : err instanceof RpiError ? 'Shipping prices are unavailable right now. Please try again shortly.' : 'Something went wrong. Please try again.';
    logger.warn({ err, slug }, 'book-print: quote failed');
    send(res, 502, 'Printed copies', `<h1>We could not price that</h1><p class="note err">${esc(message)}</p><p><a href="/books/${esc(slug)}/print">Back</a></p>`);
  }
});

bookPrintRouter.post('/:slug/print/checkout', limiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  try {
    const book = await loadBook(slug);
    if (!book || !paymentsReady()) return unavailable(res);
    const form = readForm((req.body ?? {}) as Record<string, unknown>);
    if (form.error || !form.destination) return send(res, 400, `Order ${book.title}`, formPage(slug, book.title, book.offers, form.values, form.error));
    if (!['standard', 'expedited', 'rush'].includes(form.values.shipping)) {
      return send(res, 400, `Order ${book.title}`, formPage(slug, book.title, book.offers, form.values, 'Choose a shipping option.'));
    }
    const { url, orderId } = await startReaderCheckout({
      slug, projectId: book.id, offerId: form.offerId, quantity: form.quantity, destination: form.destination,
      shippingClassification: form.values.shipping, buyerEmail: form.values.email, bookTitle: book.title,
    });
    logger.info({ slug, orderId }, 'book-print: checkout started');
    res.redirect(303, url);
  } catch (err) {
    const message = err instanceof ReaderPrintError ? err.message : 'Checkout could not be started. Nothing was charged.';
    logger.error({ err, slug }, 'book-print: checkout failed');
    send(res, 502, 'Printed copies', `<h1>Checkout did not start</h1><p class="note err">${esc(message)}</p><p><a href="/books/${esc(slug)}/print">Back</a></p>`);
  }
});

bookPrintRouter.get('/:slug/print/thanks', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const sessionId = String(req.query.session_id ?? '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return unavailable(res);
  try {
    const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
    if (session.metadata?.kind !== 'reader_print' || session.metadata?.slug !== slug) return unavailable(res);
    const paid = session.payment_status === 'paid';
    send(res, 200, 'Thank you', `<h1>${paid ? 'Thank you, your order is in' : 'Payment is processing'}</h1>
<p>${paid ? 'Your book is printed to order. We have emailed your receipt, and we will email again when it ships.' : 'We will email you as soon as the payment clears.'}</p>
<p><a href="/books/${esc(slug)}">Back to the book</a></p>`);
  } catch (err) {
    logger.warn({ err, slug }, 'book-print: thanks page could not read the session');
    unavailable(res);
  }
});
