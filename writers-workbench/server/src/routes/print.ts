/**
 * Print copies: an author orders printed copies of their book from RPI Print.
 *
 * The flow, one route per step, because each step is something the author looks at before the next:
 *
 *   POST /api/print/project/:projectId/prepare   build the interior and the cover for one edition,
 *                                                store them, and price one copy. A DRAFT row.
 *   POST /api/print/orders/:orderId/shipping     the shipping options to an address, with prices.
 *   POST /api/print/orders/:orderId/submit       place the order with RPI.
 *   GET  /api/print/orders/:orderId              the order, refreshed from RPI while it is moving.
 *   POST /api/print/orders/:orderId/cancel       ask RPI to cancel it.
 *   DELETE /api/print/orders/:orderId            discard a DRAFT and its files.
 *   POST /api/print/webhook                      RPI's status updates, signature-checked.
 *
 * WHY THE FILES ARE BUILT BEFORE THE PRICE. RPI prices by page count, and the cover's size depends
 * on it too. Neither can be known until the interior exists, so "prepare" builds it first and every
 * number the author sees afterwards is about the real file RPI will be sent.
 *
 * WHO PAYS. One RPI account, the Workbench's. Sandbox orders are never printed or charged; a
 * production key would charge that account's card, so the route is gated on a tier feature that
 * no tier has yet — only admins can order.
 */

import crypto from 'crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth, requireTierFeature } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { loadBookSource } from '../lib/book-source.js';
import { PrintFilesError, buildPrintFiles } from '../lib/print-files.js';
import {
  CANCELLABLE_STATUSES,
  EDITIONS,
  FINAL_STATUSES,
  RPI_MAX_PAGES,
  RPI_MIN_PAGES,
  RpiError,
  cancelOrder,
  createOrder,
  estimateOrder,
  getOrder,
  productSku,
  productionPrice,
  rpiConfigured,
  rpiMode,
  rpiPageCount,
  shippingOptions,
  verifyWebhook,
  type CreateOrder,
  type Destination,
  type EditionKey,
  type RpiOrder,
} from '../lib/rpi-print.js';

export const printRouter = Router();
export const printWebhookRouter = Router();

const BUCKET = 'print-files';
/** RPI's own advice: signed links that outlast the longest wait in its order queue. */
const SIGNED_URL_SECONDS = 7 * 24 * 3600;

type Row = Record<string, unknown> & {
  id: string;
  user_id: string;
  project_id: string;
  status: string;
  edition: EditionKey;
  sku: string;
  quantity: number;
  page_count: number;
  interior_path: string;
  outside_path: string;
  preview_path: string | null;
  customer_order_id: string | null;
  events: unknown[];
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** RPI's refusal, passed on in its own words: they name the field and what it wanted. */
function rpiFail(res: Response, err: unknown, what: string): void {
  if (err instanceof RpiError) {
    if (err.message === 'RPI_NOT_CONFIGURED') {
      fail(res, 503, 'RPI_NOT_CONFIGURED', 'Printing is not set up on this server yet (no RPI API key).');
      return;
    }
    const auth = err.status === 401 || err.status === 403;
    fail(res, auth ? 502 : 400, auth ? 'RPI_AUTH' : 'RPI_REFUSED', auth ? 'RPI refused the API key.' : `RPI: ${err.message}`);
    return;
  }
  logger.error({ err }, `print: ${what} failed`);
  fail(res, 500, 'PRINT_FAILED', `Could not ${what}.`);
}

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const storage = getSupabaseAdmin().storage;
  const { error } = await storage.createBucket(BUCKET, { public: false });
  // "already exists" is the normal case after the first order.
  if (error && !/exist/i.test(error.message)) throw new Error(`bucket: ${error.message}`);
  bucketReady = true;
}

async function signed(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await getSupabaseAdmin().storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`could not sign ${path}`);
  return data.signedUrl;
}

/** What the screen shows. The raw RPI document stays on the row for support, not on the wire. */
function view(r: Row, urls?: { preview?: string | null; interior?: string | null; outside?: string | null }) {
  const rpi = (r.rpi as RpiOrder | null) ?? null;
  const e = EDITIONS[r.edition];
  return {
    id: r.id,
    edition: r.edition,
    edition_label: e?.label ?? r.edition,
    volume_index: r.volume_index,
    quantity: r.quantity,
    page_count: r.page_count,
    rpi_page_count: rpiPageCount(r.page_count),
    spine_in: r.spine_in == null ? null : Number(r.spine_in),
    status: r.status,
    mode: r.mode,
    customer_order_id: r.customer_order_id,
    shipping_classification: r.shipping_classification,
    destination: r.destination,
    quote: r.quote,
    pricing: rpi?.pricing ?? null,
    payment: rpi?.paymentInfo ?? null,
    validations: rpi?.validations ?? [],
    shipping: rpi?.selectedShipping ?? null,
    tracking: (rpi?.shipmentTracking ?? []).flatMap((t) => t.trackingNumbers ?? []),
    last_event: r.last_event,
    events: r.events ?? [],
    created_at: r.created_at,
    submitted_at: r.submitted_at,
    updated_at: r.updated_at,
    cancellable: CANCELLABLE_STATUSES.has(r.status),
    files: urls ?? null,
  };
}

async function loadOrder(req: Request, res: Response): Promise<Row | null> {
  const { data } = await getSupabaseAdmin()
    .from('print_orders_v2')
    .select('*')
    .eq('id', String(req.params.orderId))
    .eq('user_id', req.userId!)
    .maybeSingle();
  if (!data) {
    fail(res, 404, 'NOT_FOUND', 'Order not found');
    return null;
  }
  return data as Row;
}

async function saveRpi(row: Row, rpi: RpiOrder, event?: { source: string; time: string }): Promise<Row> {
  const status = rpi.order?.status ?? row.status;
  const events = [...((row.events as unknown[]) ?? [])];
  if (event) events.push({ ...event, status });
  const patch = {
    status,
    rpi,
    ...(event ? { last_event: event.source, events: events.slice(-60) } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await getSupabaseAdmin().from('print_orders_v2').update(patch).eq('id', row.id);
  if (error) throw new Error(error.message);
  return { ...row, ...patch };
}

// ---------------------------------------------------------------------------------------------

printRouter.use(requireAuth, requireTierFeature('print_orders'));

/** What can be ordered, and whether the server can order at all. */
printRouter.get('/editions', (_req, res) => {
  res.json({
    success: true,
    data: {
      configured: rpiConfigured(),
      mode: rpiMode(),
      editions: Object.values(EDITIONS).map((e) => ({
        key: e.key,
        label: e.label,
        sku: productSku(e),
        outside: e.outside,
        trim: e.trim,
      })),
      page_range: [RPI_MIN_PAGES, RPI_MAX_PAGES],
    },
  });
});

printRouter.get('/project/:projectId/orders', async (req, res) => {
  const { data, error } = await getSupabaseAdmin()
    .from('print_orders_v2')
    .select('*')
    .eq('project_id', String(req.params.projectId))
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return fail(res, 500, 'DB', 'Could not read orders');
  res.json({ success: true, data: { orders: (data as Row[]).map((r) => view(r)) } });
});

const PrepareSchema = z.object({
  edition: z.enum(Object.keys(EDITIONS) as [EditionKey, ...EditionKey[]]),
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
});

printRouter.post('/project/:projectId/prepare', validateBody(PrepareSchema), async (req, res) => {
  const { edition: key, volume_index } = req.body as z.infer<typeof PrepareSchema>;
  const projectId = String(req.params.projectId);
  const userId = req.userId!;
  const edition = EDITIONS[key];
  try {
    const source = await loadBookSource(projectId, userId);
    if (!source) return fail(res, 404, 'NOT_FOUND', 'Project not found');
    const built = await buildPrintFiles(source, edition, volume_index ?? 1);
    const { geometry, parts } = built;
    const pages = built.pageCount;
    const v = { index: built.volumeIndex };

    await ensureBucket();
    const id = crypto.randomUUID();
    const dir = `${userId}/${projectId}/${id}`;
    const storage = getSupabaseAdmin().storage.from(BUCKET);
    const paths = {
      interior: `${dir}/interior.pdf`,
      outside: `${dir}/${edition.outside}.pdf`,
      preview: `${dir}/${edition.outside}-preview.jpg`,
    };
    for (const [path, body, type] of [
      [paths.interior, built.interior, 'application/pdf'],
      [paths.outside, built.outside, 'application/pdf'],
      [paths.preview, built.preview, 'image/jpeg'],
    ] as const) {
      const up = await storage.upload(path, body, { contentType: type, upsert: false });
      if (up.error) throw new Error(`upload ${path}: ${up.error.message}`);
    }

    // One copy's production price. A refusal here is usually the product not being in the RPI
    // dashboard yet, which the author needs to hear before they type an address.
    let quote: Record<string, unknown> = {};
    try {
      const p = await productionPrice(productSku(edition), 1, pages);
      quote = { unit_price: p.productionPrice, currency: p.currency };
    } catch (err) {
      quote = { price_error: err instanceof RpiError ? err.message : 'pricing unavailable' };
    }

    const row = {
      id,
      user_id: userId,
      project_id: projectId,
      volume_index: v.index,
      edition: key,
      sku: productSku(edition),
      mode: rpiMode(),
      quantity: 1,
      page_count: pages,
      spine_in: geometry.spineIn,
      interior_path: paths.interior,
      outside_path: paths.outside,
      preview_path: paths.preview,
      status: 'DRAFT',
      quote: { ...quote, geometry },
    };
    const { error } = await getSupabaseAdmin().from('print_orders_v2').insert(row);
    if (error) throw new Error(error.message);
    logger.info({ userId, projectId, edition: key, pages, spine: geometry.spineIn }, 'print: files prepared');
    res.json({
      success: true,
      data: {
        order: view({ ...row, events: [], created_at: new Date().toISOString() } as unknown as Row, {
          preview: await signed(paths.preview),
          interior: await signed(paths.interior),
          outside: await signed(paths.outside),
        }),
        title: parts.fullTitle,
      },
    });
  } catch (err) {
    if (err instanceof PrintFilesError) return fail(res, 400, err.code, err.message);
    if (err instanceof Error && err.message.startsWith('TEMPLATE_')) {
      return fail(res, 502, err.message, 'RPI’s cover template for this edition could not be read, so the cover size is unknown.');
    }
    logger.error({ err, projectId, edition: key }, 'print: prepare failed');
    fail(res, 500, 'PREPARE_FAILED', 'Could not build the print files.');
  }
});

const DestinationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address1: z.string().trim().min(1).max(50),
  address2: z.string().trim().max(50).optional(),
  city: z.string().trim().min(1).max(50),
  // RPI takes the region code for the US and Canada; the screen asks for exactly that.
  regionCode: z.string().trim().min(2).max(3).transform((s) => s.toUpperCase()),
  postal: z.string().trim().min(1).max(20),
  country: z.enum(['US', 'CA']),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(100).optional().or(z.literal('').transform(() => undefined)),
});

const ShippingSchema = z.object({
  destination: DestinationSchema,
  quantity: z.number().int().min(1).max(100),
});

printRouter.post('/orders/:orderId/shipping', validateBody(ShippingSchema), async (req, res) => {
  const row = await loadOrder(req, res);
  if (!row) return;
  const { destination, quantity } = req.body as z.infer<typeof ShippingSchema>;
  try {
    const options = await shippingOptions(row.sku, quantity, destination as Destination);
    res.json({ success: true, data: { options } });
  } catch (err) {
    rpiFail(res, err, 'get shipping options');
  }
});

const SubmitSchema = ShippingSchema.extend({
  shipping_classification: z.enum(['standard', 'expedited', 'rush']),
});

/** Where RPI should post status updates. Only an HTTPS public address is accepted by RPI. */
function webhookUrl(req: Request): string | undefined {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  const base = configured || `${proto}://${host}`;
  if (!base.startsWith('https://') || /localhost|127\.0\.0\.1/.test(base)) return undefined;
  return `${base.replace(/\/$/, '')}/api/print/webhook`;
}

printRouter.post('/orders/:orderId/submit', validateBody(SubmitSchema), async (req, res) => {
  const row = await loadOrder(req, res);
  if (!row) return;
  if (row.status !== 'DRAFT') return fail(res, 409, 'ALREADY_SUBMITTED', 'This order has already been placed.');
  const { destination, quantity, shipping_classification } = req.body as z.infer<typeof SubmitSchema>;
  const edition = EDITIONS[row.edition];
  try {
    const files = {
      gutsUrl: (await signed(row.interior_path))!,
      ...(edition.outside === 'jacket'
        ? { dustJacketUrl: (await signed(row.outside_path))! }
        : { coverUrl: (await signed(row.outside_path))! }),
    };
    const order: CreateOrder = {
      // Unique per RPI customer forever, across both modes, and never reused: the row's own id.
      customerOrderId: `ww-${row.id}`,
      payload: row.id,
      webhookUrl: webhookUrl(req),
      shippingClassification: shipping_classification,
      destination: destination as Destination,
      sku: row.sku,
      quantity,
      itemDescription: `${edition.label} — ${row.page_count} pages`,
      files,
      pageCount: row.page_count,
    };
    // The full estimate first: it is the total the author is about to commit to, and it refuses
    // what the order would refuse, without creating anything.
    let estimate: unknown = null;
    try {
      estimate = await estimateOrder(order);
    } catch (err) {
      if (err instanceof RpiError && err.status === 400) return rpiFail(res, err, 'price the order');
      logger.warn({ err }, 'print: estimate unavailable, placing order anyway');
    }
    const created = await createOrder(order);
    const now = new Date().toISOString();
    const patch = {
      status: 'RECEIVED',
      customer_order_id: created.customerOrderId,
      quantity,
      shipping_classification,
      destination,
      quote: { ...((row.quote as object) ?? {}), estimate },
      submitted_at: now,
      updated_at: now,
      last_event: 'OrderSubmitted',
      events: [{ source: 'OrderSubmitted', time: now, status: 'RECEIVED' }],
    };
    const { error } = await getSupabaseAdmin().from('print_orders_v2').update(patch).eq('id', row.id);
    if (error) logger.error({ error, orderId: row.id }, 'print: order placed but not saved');
    logger.info({ orderId: row.id, customerOrderId: created.customerOrderId, mode: row.mode }, 'print: order placed');
    res.json({ success: true, data: { order: view({ ...row, ...patch } as Row) } });
  } catch (err) {
    rpiFail(res, err, 'place the order');
  }
});

printRouter.get('/orders/:orderId', async (req, res) => {
  let row = await loadOrder(req, res);
  if (!row) return;
  // Webhooks are not guaranteed, so a moving order is re-read from RPI whenever it is opened.
  if (row.customer_order_id && !FINAL_STATUSES.has(row.status)) {
    try {
      row = await saveRpi(row, await getOrder(row.customer_order_id));
    } catch (err) {
      logger.warn({ err, orderId: row.id }, 'print: refresh from RPI failed; showing the stored state');
    }
  }
  const urls = { preview: await signed(row.preview_path).catch(() => null) };
  res.json({ success: true, data: { order: view(row, urls) } });
});

printRouter.post('/orders/:orderId/cancel', async (req, res) => {
  const row = await loadOrder(req, res);
  if (!row) return;
  if (!row.customer_order_id) return fail(res, 409, 'NOT_SUBMITTED', 'This order was never placed.');
  try {
    const rpi = await cancelOrder(row.customer_order_id);
    const saved = await saveRpi(row, rpi, { source: 'CancelRequested', time: new Date().toISOString() });
    res.json({ success: true, data: { order: view(saved) } });
  } catch (err) {
    rpiFail(res, err, 'cancel the order');
  }
});

printRouter.delete('/orders/:orderId', async (req, res) => {
  const row = await loadOrder(req, res);
  if (!row) return;
  if (row.status !== 'DRAFT') return fail(res, 409, 'ALREADY_SUBMITTED', 'A placed order is cancelled, not deleted.');
  await getSupabaseAdmin().storage.from(BUCKET).remove([row.interior_path, row.outside_path, row.preview_path].filter(Boolean) as string[]);
  await getSupabaseAdmin().from('print_orders_v2').delete().eq('id', row.id);
  res.json({ success: true, data: { deleted: row.id } });
});

// ---------------------------------------------------------------------------------------------
// Webhook. Mounted before express.json, with the raw body, because the signature is over bytes.
// ---------------------------------------------------------------------------------------------

printWebhookRouter.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhook(raw, req.get('x-rpi-printapi-hmac-sha256'), process.env.RPI_PRINT_WEBHOOK_SECRET)) {
    logger.warn({ ip: req.ip }, 'print webhook: bad signature');
    res.status(401).json({ success: false });
    return;
  }
  let body: { source?: string; time?: string; data?: RpiOrder };
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ success: false });
    return;
  }
  const customerOrderId = body.data?.order?.customerOrderId;
  // Answered 200 even when the order is unknown here: RPI retries anything else for hours.
  if (!customerOrderId) {
    res.json({ success: true });
    return;
  }
  const { data } = await getSupabaseAdmin()
    .from('print_orders_v2')
    .select('*')
    .eq('customer_order_id', customerOrderId)
    .maybeSingle();
  if (!data) {
    logger.warn({ customerOrderId, source: body.source }, 'print webhook: unknown order');
    res.json({ success: true });
    return;
  }
  try {
    await saveRpi(data as Row, body.data!, { source: String(body.source ?? 'unknown'), time: String(body.time ?? new Date().toISOString()) });
    logger.info({ customerOrderId, source: body.source, status: body.data?.order?.status }, 'print webhook: order updated');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, customerOrderId }, 'print webhook: save failed');
    // A 500 makes RPI retry, which is what is wanted when the write did not land.
    res.status(500).json({ success: false });
  }
});
