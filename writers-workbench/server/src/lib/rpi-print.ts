/**
 * RPI Print: printed copies of a book, ordered over an API and shipped to an address.
 *
 * WHAT IT NEEDS FROM US. Per order item: a product SKU (set up once in the RPI dashboard), and the
 * public HTTPS URLs of press-ready PDFs — always the interior, plus a cover or a dust jacket
 * depending on the product. RPI downloads them, preflights them, prints and ships.
 *
 * WHY THE COVER IS MEASURED FROM RPI'S TEMPLATE. The cover is one page holding back, spine and front
 * (and on a dust jacket two flaps), and preflight rejects one whose size does not match the product
 * at the interior's page count. The sizes differ per binding in ways no single formula covers: a
 * softcover adds bleed, a hardcover adds a board wrap and a larger panel, a jacket adds flaps. RPI
 * publishes a template for any product and page count, so the geometry is read from that rather
 * than reconstructed here.
 *
 * WHICH MODE. The API key decides whether an order is sandbox (never printed or charged) or
 * production. `RPI_PRINT_MODE` only labels the screens; it cannot make a production key safe.
 */

import crypto from 'crypto';
import JSZip from 'jszip';
import { logger } from './logger.js';

export const RPI_API = 'https://open.api.rpiprint.com';
const TEMPLATE_API = 'https://products.api.rpiprint.com/templates/published';

/** RPI's minimum and maximum interior page counts for these products, and their step. */
export const RPI_MIN_PAGES = 24;
export const RPI_MAX_PAGES = 672;

export type EditionKey = 'softcover_matte' | 'softcover_gloss' | 'hardcover_wrap' | 'hardcover_jacket';

export interface Edition {
  key: EditionKey;
  label: string;
  /** RPI's identifier for the physical product. Also the dashboard's suggested product SKU. */
  manufacturingSku: string;
  /** Which file carries the outside of the book. */
  outside: 'cover' | 'jacket';
  /** Full-bleed products want interior pages larger than the trim by this much on every side. */
  interiorBleedIn: number;
  trim: string;
}

/**
 * The editions offered: 6x9, black-and-white interior on 70lb uncoated paper, the novel stock.
 * The dust-jacket hardcover exists only as a full-bleed product, so its interior carries bleed.
 */
export const EDITIONS: Record<EditionKey, Edition> = {
  softcover_matte: {
    key: 'softcover_matte',
    label: 'Softcover, matte',
    manufacturingSku: 'BKTD_SCIW_STD_6.000x9.000IN_10PT_MT_40_70T_UNC_11',
    outside: 'cover',
    interiorBleedIn: 0,
    trim: '6x9',
  },
  softcover_gloss: {
    key: 'softcover_gloss',
    label: 'Softcover, gloss',
    manufacturingSku: 'BKTD_SCIW_STD_6.000x9.000IN_10PT_GL_40_70T_UNC_11',
    outside: 'cover',
    interiorBleedIn: 0,
    trim: '6x9',
  },
  hardcover_wrap: {
    key: 'hardcover_wrap',
    label: 'Hardcover, printed cover',
    manufacturingSku: 'BKTD_HCIW_STD_6.000x9.000IN_80C_MT_40_70T_UNC_11',
    outside: 'cover',
    interiorBleedIn: 0,
    trim: '6x9',
  },
  hardcover_jacket: {
    key: 'hardcover_jacket',
    label: 'Hardcover, dust jacket',
    manufacturingSku: 'BKPH_HCMCDJ_STD_6.000x9.000IN_80C_MT_40_70T_UNC_11',
    outside: 'jacket',
    interiorBleedIn: 0.125,
    trim: '6x9',
  },
};

/**
 * The SKU sent on an order: the product SKU in the RPI dashboard. Kept equal to the manufacturing
 * SKU by default (the dashboard suggests exactly that); `RPI_SKU_<EDITION>` overrides one.
 */
export function productSku(e: Edition): string {
  return process.env[`RPI_SKU_${e.key.toUpperCase()}`]?.trim() || e.manufacturingSku;
}

export function rpiConfigured(): boolean {
  return Boolean(process.env.RPI_PRINT_AUTH?.trim());
}

export function rpiMode(): 'sandbox' | 'production' {
  return process.env.RPI_PRINT_MODE === 'production' ? 'production' : 'sandbox';
}

/** RPI's page count for an interior: rounded up to its step of 2, as preflight pads it. */
export function rpiPageCount(pages: number): number {
  return pages % 2 === 0 ? pages : pages + 1;
}

// ---------------------------------------------------------------------------------------------
// Cover geometry
// ---------------------------------------------------------------------------------------------

export interface CoverGeometry {
  widthIn: number;
  heightIn: number;
  edgeIn: number;
  panelWIn: number;
  panelHIn: number;
  spineIn: number;
  flapIn: number;
}

const num = (re: RegExp, text: string): number | null => {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
};

/**
 * Read the geometry from a template's own labels ("Full Cover: 15.593" × 10.750"", "Spine: 1.593"",
 * "Left Flap: 3.656"" …), then check the parts add up to the whole. A template whose numbers do not
 * add up is refused rather than half-trusted: a cover built on it would fail preflight anyway.
 */
export function parseTemplateGeometry(text: string): CoverGeometry {
  const t = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  const full = /Full (?:Cover|Jacket): ([\d.]+)" × ([\d.]+)"/.exec(t);
  const front = /Front Cover: ([\d.]+)" × ([\d.]+)"/.exec(t);
  const edge = num(/(?:Cover|Jacket) Bleed: ([\d.]+)"/, t);
  const spine = num(/(?<!\w)Spine: ([\d.]+)"/, t);
  const left = num(/Left Flap: ([\d.]+)"/, t) ?? 0;
  const right = num(/Right Flap: ([\d.]+)"/, t) ?? 0;
  if (!full || !front || edge == null || spine == null) {
    throw new Error('TEMPLATE_UNREADABLE');
  }
  if (Math.abs(left - right) > 0.002) throw new Error('TEMPLATE_UNEVEN_FLAPS');
  const g: CoverGeometry = {
    widthIn: Number(full[1]),
    heightIn: Number(full[2]),
    edgeIn: edge,
    panelWIn: Number(front[1]),
    panelHIn: Number(front[2]),
    spineIn: spine,
    flapIn: left,
  };
  const sumW = g.edgeIn * 2 + g.flapIn * 2 + g.panelWIn * 2 + g.spineIn;
  const sumH = g.edgeIn * 2 + g.panelHIn;
  // The labels are printed to three decimals, so the parts may miss the whole by a rounding step.
  if (Math.abs(sumW - g.widthIn) > 0.01 || Math.abs(sumH - g.heightIn) > 0.01) {
    throw new Error('TEMPLATE_DOES_NOT_ADD_UP');
  }
  return g;
}

const geometryCache = new Map<string, CoverGeometry>();

/** The cover (or jacket) geometry for one product at one page count, from RPI's IDML template. */
export async function coverGeometry(e: Edition, pageCount: number): Promise<CoverGeometry> {
  const pages = rpiPageCount(pageCount);
  const key = `${e.manufacturingSku}:${e.outside}:${pages}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const url = `${TEMPLATE_API}/${e.manufacturingSku}/${e.outside}/idml?units=in&pageCount=${pages}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    // 404 is also what RPI answers for a page count outside the product's range.
    throw new Error(res.status === 404 ? 'TEMPLATE_NOT_FOUND' : `TEMPLATE_HTTP_${res.status}`);
  }
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const stories = Object.keys(zip.files).filter((n) => n.startsWith('Stories/'));
  const text = (await Promise.all(stories.map((n) => zip.files[n].async('string')))).join(' ');
  const g = parseTemplateGeometry(text.replace(/<[^>]+>/g, ' '));
  geometryCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

export class RpiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const auth = process.env.RPI_PRINT_AUTH?.trim();
  if (!auth) throw new RpiError(503, 'RPI_NOT_CONFIGURED');
  const res = await fetch(`${RPI_API}${path}`, {
    method,
    headers: {
      // The dashboard's value already carries the scheme ("Basic …").
      Authorization: auth.startsWith('Basic ') ? auth : `Basic ${auth}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { errorDescription?: string; message?: string };
    const message = j.errorDescription || j.message || text.slice(0, 300) || `HTTP ${res.status}`;
    logger.warn({ status: res.status, path, message }, 'rpi print: request refused');
    throw new RpiError(res.status, message);
  }
  return json as T;
}

export interface Destination {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  regionCode?: string;
  postal: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface ShippingOption {
  methodName: string | null;
  methodClassification: string;
  estimatedShipDateUTC: string | null;
  estimatedDeliveryDateUTC: string | null;
  price: number;
  currency: string;
}

export interface OrderItemFiles {
  gutsUrl: string;
  coverUrl?: string;
  dustJacketUrl?: string;
}

/** The production price of one item: base price plus per-page price above the minimum. */
export function productionPrice(sku: string, quantity: number, pageCount: number) {
  return call<{ productionPrice: number; currency: string }>('POST', '/pricing/production', {
    currency: 'USD',
    orderItems: [{ sku, quantity, pageCount: rpiPageCount(pageCount) }],
  });
}

export function shippingOptions(sku: string, quantity: number, destination: Destination) {
  return call<ShippingOption[]>('POST', '/orders/shipping/estimate', {
    currency: 'USD',
    destination,
    orderItems: [{ sku, quantity }],
  });
}

export interface CreateOrder {
  customerOrderId: string;
  payload: string;
  webhookUrl?: string;
  shippingClassification: string;
  destination: Destination;
  sku: string;
  quantity: number;
  itemDescription: string;
  files: OrderItemFiles;
}

function orderBody(o: CreateOrder) {
  return {
    customerOrderId: o.customerOrderId,
    payload: o.payload,
    currency: 'USD',
    ...(o.webhookUrl ? { webhookUrl: o.webhookUrl } : {}),
    shippingClassification: o.shippingClassification,
    destination: o.destination,
    orderItems: [
      { sku: o.sku, quantity: o.quantity, itemDescription: o.itemDescription.slice(0, 200), product: o.files },
    ],
  };
}

export interface FullEstimate {
  productionPrice: number;
  shippingPrice: number;
  shippingTax: number;
  itemsPricing: { sku: string; quantity: number; unitPrice: number; totalTaxAmount: number }[];
  currency: string;
}

export function estimateOrder(o: CreateOrder) {
  return call<FullEstimate>('POST', '/orders/pricing/estimate', orderBody(o));
}

export function createOrder(o: CreateOrder) {
  return call<{ customerOrderId: string; statusCode: number; statusDescription: string }>(
    'POST',
    '/orders/create',
    orderBody(o),
  );
}

/** The order as RPI reports it: status, pricing, validations, shipping and tracking. */
export interface RpiOrder {
  order?: { customerOrderId?: string; status?: string; payload?: string };
  pricing?: { orderTotal: number | null; itemsTotal: number; taxesTotal: number; shippingTotal: number | null };
  validations?: { source: string; humanReadableString: string; fatalError: boolean }[];
  selectedShipping?: { methodName: string | null; estimatedShipDateUTC: string | null; estimatedDeliveryDateUTC: string | null };
  shipmentTracking?: { masterTrackingNumber: string | null; trackingNumbers: { trackingNumber: string | null; trackingUrl: string | null }[] }[];
  paymentInfo?: { total: number | null; paymentStatus: string };
}

export function getOrder(customerOrderId: string) {
  return call<RpiOrder>('GET', `/orders/${encodeURIComponent(customerOrderId)}`);
}

export function cancelOrder(customerOrderId: string) {
  return call<RpiOrder>('DELETE', `/orders/${encodeURIComponent(customerOrderId)}`);
}

/** States RPI will not move an order out of. */
export const FINAL_STATUSES = new Set(['SHIPPED', 'CANCELLED', 'FAILED', 'REJECTED']);

/** States from which RPI accepts a cancellation, per its API reference. */
export const CANCELLABLE_STATUSES = new Set([
  'QUEUED',
  'RECEIVED',
  'VALID_AWAITING_PAYMENT',
  'VALID_HOLDING_BIN',
  'PRINTING',
  'RECEIVED_BY_PRINTER',
  'IN_PRODUCTION',
  'READY_TO_SHIP',
]);

/**
 * A webhook body is RPI's only if its HMAC-SHA256, keyed with the webhook secret and Base64
 * encoded, matches the `x-rpi-printapi-hmac-sha256` header. Computed over the raw bytes received:
 * re-serialising parsed JSON changes them, and then every genuine webhook looks forged.
 */
export function verifyWebhook(raw: Buffer, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature.trim(), 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
