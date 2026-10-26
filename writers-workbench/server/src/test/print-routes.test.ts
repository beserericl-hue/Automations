/**
 * Print orders over HTTP, against a fake RPI.
 *
 * Asserted: preparing stores the files and a DRAFT priced from the real page count; placing an
 * order sends RPI the SKU, the signed file URLs under the field the edition takes (a jacket is not
 * a cover), a never-reused order id and an HTTPS webhook; RPI's refusal reaches the author in RPI's
 * words; a webhook moves the order only with a valid signature; and a moving order is re-read from
 * RPI when opened.
 */
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const uploads: string[] = [];

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
  requireTierFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/book-source.js', () => ({ loadBookSource: async (p: string) => (p === 'p1' ? { title: 'The Ossuary' } : null) }));
const build = vi.fn();
vi.mock('../lib/print-files.js', () => ({
  PrintFilesError: class extends Error { constructor(public code: string, m: string) { super(m); } },
  buildPrintFiles: (...a: unknown[]) => build(...a),
}));

vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let del = false;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      insert: (r: Row) => { (db[table] ??= []).push({ ...r }); return Promise.resolve({ error: null }); },
      update: (p: Row) => ((patch = p), q),
      delete: () => ((del = true), q),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) { for (const r of rows()) Object.assign(r, patch); return resolve({ error: null }); }
        if (del) { db[table] = (db[table] ?? []).filter((r) => !rows().includes(r)); return resolve({ error: null }); }
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  const storage = {
    createBucket: async () => ({ error: { message: 'The resource already exists' } }),
    from: () => ({
      upload: async (path: string) => { uploads.push(path); return { error: null }; },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://dev.supabase.co/sign/${path}?token=t` }, error: null }),
      remove: async () => ({ error: null }),
    }),
  };
  return { getSupabaseAdmin: () => ({ from, storage }) };
});

const rpiCalls: { method: string; path: string; body: any }[] = [];
let rpiReply: (method: string, path: string, body: any) => { status: number; body: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  db.print_orders_v2 = [];
  uploads.length = 0;
  rpiCalls.length = 0;
  build.mockReset();
  process.env.RPI_PRINT_AUTH = 'Basic dGVzdDp0ZXN0';
  process.env.RPI_PRINT_WEBHOOK_SECRET = 'whsec';
  process.env.RPI_PRINT_MODE = 'sandbox';
  process.env.PUBLIC_APP_URL = 'https://writersworkbench-develop.up.railway.app';
  rpiReply = (_m, path) => {
    if (path === '/pricing/production') return { status: 200, body: { productionPrice: 18.08, currency: 'USD' } };
    if (path === '/orders/shipping/estimate') return { status: 200, body: [{ methodClassification: 'standard', price: 6.5, currency: 'USD' }] };
    if (path === '/orders/pricing/estimate') return { status: 200, body: { productionPrice: 36.16, shippingPrice: 7.2, shippingTax: 0, itemsPricing: [], currency: 'USD' } };
    if (path === '/orders/create') return { status: 201, body: { customerOrderId: 'x', statusCode: 201, statusDescription: 'Order received' } };
    return { status: 200, body: { order: { status: 'VALIDATING' } } };
  };
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith('https://open.api.rpiprint.com')) return realFetch(url, init);
    const path = u.replace('https://open.api.rpiprint.com', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    rpiCalls.push({ method: String(init?.method), path, body });
    const r = rpiReply(String(init?.method), path, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { printRouter, printWebhookRouter } = await import('../routes/print.js');
  const app = express();
  app.use('/api/print/webhook', printWebhookRouter);
  app.use(express.json());
  app.use('/api/print', printRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
const post = (base: string, path: string, body: unknown): Promise<any> =>
  realFetch(`${base}/api/print${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const GEOMETRY = { widthIn: 21.852, heightIn: 9.5, edgeIn: 0.125, panelWIn: 6.25, panelHIn: 9.25, spineIn: 1.789, flapIn: 3.656 };
function built() {
  build.mockResolvedValue({
    interior: Buffer.from('%PDF-interior'), outside: Buffer.from('%PDF-jacket'), preview: Buffer.from('jpg'),
    pageCount: 593, geometry: GEOMETRY, parts: { fullTitle: 'The Ossuary: Volume 1' }, volumeIndex: 1,
  });
}
const ADDRESS = { name: 'Eric Beser', address1: '1 Main St', city: 'Owings Mills', regionCode: 'md', postal: '21117', country: 'US' };

describe('prepare', () => {
  it('stores the files and a DRAFT priced from the real page count', async () => {
    built();
    await withServer(async (base) => {
      const j = await post(base, '/project/p1/prepare', { edition: 'hardcover_jacket' });
      expect(j.success).toBe(true);
      expect(j.data.order).toMatchObject({ status: 'DRAFT', page_count: 593, rpi_page_count: 594, spine_in: 1.789, edition_label: 'Hardcover, dust jacket' });
      expect(j.data.order.quote.unit_price).toBe(18.08);
      expect(uploads.map((u) => u.split('/').pop())).toEqual(['interior.pdf', 'jacket.pdf', 'jacket-preview.jpg']);
      expect(rpiCalls[0].body.orderItems[0]).toEqual({ sku: 'BKPH_HCMCDJ_STD_6.000x9.000IN_80C_MT_40_70T_UNC_11', quantity: 1, pageCount: 594 });
      expect(db.print_orders_v2).toHaveLength(1);
    });
  });

  it('keeps the draft but says so when RPI will not price the product', async () => {
    built();
    rpiReply = () => ({ status: 400, body: { errorCode: 400, errorDescription: 'Unknown sku' } });
    await withServer(async (base) => {
      const j = await post(base, '/project/p1/prepare', { edition: 'softcover_matte' });
      expect(j.data.order.quote.price_error).toBe('Unknown sku');
    });
  });

  it('404s a project that is not the author’s', async () => {
    await withServer(async (base) => {
      expect((await post(base, '/project/nope/prepare', { edition: 'softcover_matte' })).error.code).toBe('NOT_FOUND');
    });
  });
});

describe('placing an order', () => {
  async function draft(base: string, edition = 'hardcover_jacket') {
    built();
    return (await post(base, '/project/p1/prepare', { edition })).data.order.id as string;
  }

  it('sends the files under the field the edition takes, a fresh id and an HTTPS webhook', async () => {
    await withServer(async (base) => {
      const id = await draft(base);
      const j = await post(base, `/orders/${id}/submit`, { destination: ADDRESS, quantity: 2, shipping_classification: 'standard' });
      expect(j.data.order.status).toBe('RECEIVED');
      const create = rpiCalls.find((c) => c.path === '/orders/create')!;
      expect(create.body.customerOrderId).toBe(`ww-${id}`);
      expect(create.body.customerOrderId.length).toBeLessThanOrEqual(40);
      expect(create.body.webhookUrl).toBe('https://writersworkbench-develop.up.railway.app/api/print/webhook');
      expect(create.body.destination.regionCode).toBe('MD');
      const product = create.body.orderItems[0].product;
      expect(product.gutsUrl).toMatch(/^https:\/\/.*interior\.pdf/);
      expect(product.dustJacketUrl).toMatch(/jacket\.pdf/);
      expect(product.coverUrl).toBeUndefined();
      expect(create.body.orderItems[0].quantity).toBe(2);
      expect(db.print_orders_v2[0].quote).toMatchObject({ estimate: { shippingPrice: 7.2 } });
      // The estimate has no file to count, so it is told the padded page count; the order is not.
      const estimate = rpiCalls.find((c) => c.path === '/orders/pricing/estimate')!;
      expect(estimate.body.orderItems[0].product.pageCount).toBe(594);
      expect(create.body.orderItems[0].product.pageCount).toBeUndefined();
    });
  });

  it('sends a softcover’s outside as the cover, and refuses to place an order twice', async () => {
    await withServer(async (base) => {
      const id = await draft(base, 'softcover_matte');
      await post(base, `/orders/${id}/submit`, { destination: ADDRESS, quantity: 1, shipping_classification: 'standard' });
      const product = rpiCalls.find((c) => c.path === '/orders/create')!.body.orderItems[0].product;
      expect(product.coverUrl).toBeTruthy();
      expect(product.dustJacketUrl).toBeUndefined();
      const again = await post(base, `/orders/${id}/submit`, { destination: ADDRESS, quantity: 1, shipping_classification: 'standard' });
      expect(again.error.code).toBe('ALREADY_SUBMITTED');
    });
  });

  it('passes RPI’s refusal on in its own words and creates nothing', async () => {
    await withServer(async (base) => {
      const id = await draft(base);
      rpiReply = (_m, path) => path === '/orders/pricing/estimate'
        ? { status: 400, body: { errorCode: 400, errorDescription: 'destination.postal: size must be between 1 and 20' } }
        : { status: 200, body: {} };
      const j = await post(base, `/orders/${id}/submit`, { destination: ADDRESS, quantity: 1, shipping_classification: 'standard' });
      expect(j.error.message).toBe('RPI: destination.postal: size must be between 1 and 20');
      expect(rpiCalls.some((c) => c.path === '/orders/create')).toBe(false);
      expect(db.print_orders_v2[0].status).toBe('DRAFT');
    });
  });

  it('says plainly when the server has no RPI key', async () => {
    await withServer(async (base) => {
      const id = await draft(base);
      delete process.env.RPI_PRINT_AUTH;
      const j = await post(base, `/orders/${id}/shipping`, { destination: ADDRESS, quantity: 1 });
      expect(j.error.code).toBe('RPI_NOT_CONFIGURED');
    });
  });
});

describe('status', () => {
  function sign(body: string) {
    return crypto.createHmac('sha256', 'whsec').update(body).digest('base64');
  }
  function placed() {
    db.print_orders_v2.push({
      id: 'o1', user_id: 'u1', project_id: 'p1', edition: 'softcover_matte', sku: 's', status: 'RECEIVED', quantity: 1,
      page_count: 593, interior_path: 'a', outside_path: 'b', preview_path: null, customer_order_id: 'ww-o1', events: [],
    });
  }

  it('a signed webhook moves the order and is logged; an unsigned one is refused', async () => {
    placed();
    await withServer(async (base) => {
      const body = JSON.stringify({ source: 'OrderShipped', time: '2026-10-25T12:00:00Z', data: { order: { customerOrderId: 'ww-o1', status: 'SHIPPED' }, shipmentTracking: [{ masterTrackingNumber: null, trackingNumbers: [{ trackingNumber: '1Z', trackingUrl: 'https://ups.example/1Z' }] }] } });
      const bad = await realFetch(`${base}/api/print/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rpi-printapi-hmac-sha256': sign(body + ' ') }, body });
      expect(bad.status).toBe(401);
      expect(db.print_orders_v2[0].status).toBe('RECEIVED');
      const ok = await realFetch(`${base}/api/print/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rpi-printapi-hmac-sha256': sign(body) }, body });
      expect(ok.status).toBe(200);
      expect(db.print_orders_v2[0]).toMatchObject({ status: 'SHIPPED', last_event: 'OrderShipped' });
      expect(db.print_orders_v2[0].events).toEqual([{ source: 'OrderShipped', time: '2026-10-25T12:00:00Z', status: 'SHIPPED' }]);
      const view = (await realFetch(`${base}/api/print/orders/o1`).then((r) => r.json())) as any;
      expect(view.data.order.tracking).toEqual([{ trackingNumber: '1Z', trackingUrl: 'https://ups.example/1Z' }]);
    });
  });

  it('re-reads a moving order from RPI when it is opened', async () => {
    placed();
    rpiReply = () => ({ status: 200, body: { order: { customerOrderId: 'ww-o1', status: 'VALID_HOLDING_BIN' } } });
    await withServer(async (base) => {
      const j = (await realFetch(`${base}/api/print/orders/o1`).then((r) => r.json())) as any;
      expect(j.data.order.status).toBe('VALID_HOLDING_BIN');
      expect(rpiCalls[0]).toMatchObject({ method: 'GET', path: '/orders/ww-o1' });
    });
  });
});
