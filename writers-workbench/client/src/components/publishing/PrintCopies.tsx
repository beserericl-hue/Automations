/**
 * Print copies — order printed copies of the book from RPI Print, shipped to an address.
 *
 * Three steps, in the order the numbers become real:
 *   1. Build the files for an edition. The interior is built first because the price and the
 *      cover's spine both depend on its page count; the author sees the cover before anything else.
 *   2. An address and a quantity, for the shipping options RPI sells to that address.
 *   3. Place the order. It then moves on RPI's side over hours or days, and the list below shows
 *      where it is, with tracking once it ships.
 *
 * A sandbox order is never printed or charged, and the screen says which mode it is in.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Edition {
  key: string;
  label: string;
  sku: string;
  outside: 'cover' | 'jacket';
  trim: string;
}

interface EditionsInfo {
  configured: boolean;
  mode: 'sandbox' | 'production';
  editions: Edition[];
  page_range: [number, number];
}

interface ShippingOption {
  methodName: string | null;
  methodClassification: string;
  estimatedDeliveryDateUTC: string | null;
  price: number;
}

interface PrintOrder {
  id: string;
  edition: string;
  edition_label: string;
  volume_index: number;
  quantity: number;
  page_count: number;
  rpi_page_count: number;
  spine_in: number | null;
  status: string;
  mode: string;
  customer_order_id: string | null;
  quote: { unit_price?: number; price_error?: string; estimate?: { productionPrice: number; shippingPrice: number; shippingTax: number } | null } | null;
  pricing: { orderTotal: number | null } | null;
  validations: { source: string; humanReadableString: string; fatalError: boolean }[];
  tracking: { trackingNumber: string | null; trackingUrl: string | null }[];
  last_event: string | null;
  created_at: string;
  submitted_at: string | null;
  cancellable: boolean;
  files: { preview?: string | null; interior?: string | null; outside?: string | null } | null;
  order_kind?: 'author' | 'reader';
  buyer_name?: string | null;
  amount_total_cents?: number | null;
  paid_at?: string | null;
}

interface PrintOffer {
  id: string;
  edition: string;
  volume_index: number;
  source_order_id: string;
  price_cents: number;
  enabled: boolean;
}

const EMPTY_ADDRESS = { name: '', address1: '', address2: '', city: '', regionCode: '', postal: '', country: 'US', phone: '', email: '' };

/** The server's words, or its field list when the form was refused. */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = (err.body as { error?: { fields?: { field: string; message: string }[] } } | null)?.error?.fields;
    if (fields?.length) return fields.map((f) => `${f.field.replace('destination.', '')}: ${f.message}`).join('; ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

/** RPI's order states in words an author reads. The raw state stays in the tooltip. */
const PRINT_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'Queued',
  RECEIVED: 'Received by RPI',
  VALID_AWAITING_PAYMENT: 'Awaiting payment',
  VALID_HOLDING_BIN: 'Paid, in the holding bin',
  PRINTING: 'Sent to the printer',
  RECEIVED_BY_PRINTER: 'Accepted by the printer',
  IN_PRODUCTION: 'Printing',
  READY_TO_SHIP: 'Printed, ready to ship',
  SHIPPED: 'Shipped',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};

export function printStatusLabel(status: string): string {
  return PRINT_STATUS_LABELS[status] ?? status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export default function PrintCopies({ projectId, volumeCount }: { projectId: string; volumeCount: number }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const ordersKey = ['print-orders', projectId] as const;

  const { data: info } = useQuery({
    queryKey: ['print-editions'],
    queryFn: async () => (await apiFetch<ApiEnvelope<EditionsInfo>>('/api/print/editions')).data!,
  });
  const { data: orders } = useQuery({
    queryKey: ordersKey,
    queryFn: async () =>
      (await apiFetch<ApiEnvelope<{ orders: PrintOrder[] }>>(`/api/print/project/${projectId}/orders`)).data!.orders,
  });

  const [edition, setEdition] = useState('softcover_matte');
  const [volume, setVolume] = useState(1);
  const [draft, setDraft] = useState<PrintOrder | null>(null);
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [quantity, setQuantity] = useState(1);
  const [options, setOptions] = useState<ShippingOption[] | null>(null);
  const [tier, setTier] = useState('');

  const prepare = useMutation({
    mutationFn: async () =>
      (
        await apiFetch<ApiEnvelope<{ order: PrintOrder }>>(`/api/print/project/${projectId}/prepare`, {
          method: 'POST',
          body: JSON.stringify({ edition, volume_index: volumeCount > 1 ? volume : null }),
        })
      ).data!.order,
    onSuccess: (o) => {
      setDraft(o);
      setOptions(null);
      setTier('');
      void queryClient.invalidateQueries({ queryKey: ordersKey });
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const destination = () => {
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(address)) if (v.trim()) d[k] = v.trim();
    return d;
  };

  const shipping = useMutation({
    mutationFn: async () =>
      (
        await apiFetch<ApiEnvelope<{ options: ShippingOption[] }>>(`/api/print/orders/${draft!.id}/shipping`, {
          method: 'POST',
          body: JSON.stringify({ destination: destination(), quantity }),
        })
      ).data!.options,
    onSuccess: (o) => {
      setOptions(o);
      setTier(o[0]?.methodClassification ?? '');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const submit = useMutation({
    mutationFn: async () =>
      (
        await apiFetch<ApiEnvelope<{ order: PrintOrder }>>(`/api/print/orders/${draft!.id}/submit`, {
          method: 'POST',
          body: JSON.stringify({ destination: destination(), quantity, shipping_classification: tier }),
        })
      ).data!.order,
    onSuccess: () => {
      addToast('Order placed with RPI Print', 'success');
      setDraft(null);
      setOptions(null);
      void queryClient.invalidateQueries({ queryKey: ordersKey });
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const act = useMutation({
    mutationFn: async ({ id, what }: { id: string; what: 'refresh' | 'cancel' | 'discard' }) => {
      if (what === 'refresh') return apiFetch(`/api/print/orders/${id}`);
      if (what === 'cancel') return apiFetch(`/api/print/orders/${id}/cancel`, { method: 'POST' });
      return apiFetch(`/api/print/orders/${id}`, { method: 'DELETE' });
    },
    onSuccess: (_d, v) => {
      if (v.what === 'discard' && draft?.id === v.id) setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ordersKey });
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  if (!info) return null;
  const chosen = options?.find((o) => o.methodClassification === tier);
  const unit = draft?.quote?.unit_price;
  const placed = (orders ?? []).filter((o) => o.status !== 'DRAFT');

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Print copies</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Printed and shipped by RPI Print: a proof, or copies for reviewers and events. 6×9″, black-and-white
          interior.
        </p>
      </div>

      <p
        data-testid="print-mode"
        className={`rounded-md px-3 py-2 text-xs ${
          info.mode === 'sandbox'
            ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
            : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300'
        }`}
      >
        {info.mode === 'sandbox'
          ? 'Sandbox: orders go through RPI’s whole process but are never printed or charged.'
          : 'Production: orders are printed, shipped and charged to the RPI account’s card.'}
      </p>

      {!info.configured ? (
        <p className="text-xs text-red-700 dark:text-red-400">
          Printing is not set up on this server yet: it has no RPI API key.
        </p>
      ) : null}

      {/* 1. Edition */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">Edition</legend>
        <div className="flex flex-wrap gap-2">
          {info.editions.map((e) => (
            <label
              key={e.key}
              className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${
                edition === e.key
                  ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                  : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400'
              }`}
            >
              <input
                type="radio"
                name="print-edition"
                className="sr-only"
                checked={edition === e.key}
                onChange={() => setEdition(e.key)}
              />
              {e.label}
            </label>
          ))}
        </div>
        {volumeCount > 1 ? (
          <label className="block text-xs text-gray-600 dark:text-gray-400">
            Book{' '}
            <select
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="ml-1 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              {Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          onClick={() => prepare.mutate()}
          disabled={prepare.isPending || !info.configured}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {prepare.isPending ? 'Building the interior and cover…' : 'Build the print files'}
        </button>
      </fieldset>

      {draft ? (
        <div data-testid="print-draft" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <p className="text-sm text-gray-800 dark:text-gray-200">
            {draft.edition_label} · {draft.page_count} pages
            {draft.rpi_page_count !== draft.page_count ? ` (printed as ${draft.rpi_page_count})` : ''}
            {draft.spine_in != null ? ` · spine ${draft.spine_in.toFixed(3)}″` : ''}
            {' · '}
            {unit != null ? `${money(unit)} a copy before shipping` : null}
          </p>
          {draft.quote?.price_error ? (
            <p className="text-xs text-red-700 dark:text-red-400">
              RPI would not price it: {draft.quote.price_error}. Is this edition added on the Products page of the
              RPI dashboard?
            </p>
          ) : null}
          {draft.files?.preview ? (
            <img src={draft.files.preview} alt={`${draft.edition_label}: back, spine and front`} className="w-full rounded" />
          ) : null}
          <p className="text-xs">
            {draft.files?.interior ? (
              <a className="text-brand-600 hover:underline" href={draft.files.interior} target="_blank" rel="noreferrer">
                Interior PDF
              </a>
            ) : null}
            {draft.files?.outside ? (
              <>
                {' · '}
                <a className="text-brand-600 hover:underline" href={draft.files.outside} target="_blank" rel="noreferrer">
                  {draft.edition === 'hardcover_jacket' ? 'Dust jacket PDF' : 'Cover PDF'}
                </a>
              </>
            ) : null}
            {' · '}
            <button className="text-gray-500 hover:underline" onClick={() => act.mutate({ id: draft.id, what: 'discard' })}>
              Discard
            </button>
          </p>

          {/* 2. Address */}
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['name', 'Name'],
                ['address1', 'Street address'],
                ['address2', 'Apartment, suite (optional)'],
                ['city', 'City'],
                ['regionCode', 'State or province (e.g. MD)'],
                ['postal', 'ZIP or postal code'],
                ['phone', 'Phone (optional; some carriers need it)'],
                ['email', 'Email (optional)'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="text-xs text-gray-600 dark:text-gray-400">
                {label}
                <input
                  aria-label={label}
                  value={address[k]}
                  onChange={(e) => {
                    setAddress({ ...address, [k]: e.target.value });
                    setOptions(null);
                  }}
                  className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
              </label>
            ))}
            <label className="text-xs text-gray-600 dark:text-gray-400">
              Country
              <select
                aria-label="Country"
                value={address.country}
                onChange={(e) => setAddress({ ...address, country: e.target.value })}
                className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              >
                <option value="US">United States</option>
                <option value="CA">Canada</option>
              </select>
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-400">
              Copies
              <input
                aria-label="Copies"
                type="number"
                min={1}
                max={100}
                value={quantity}
                onChange={(e) => {
                  setQuantity(Math.max(1, Math.min(100, Number(e.target.value) || 1)));
                  setOptions(null);
                }}
                className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            </label>
          </div>
          <button
            onClick={() => shipping.mutate()}
            disabled={shipping.isPending}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {shipping.isPending ? 'Asking RPI…' : 'Get shipping options'}
          </button>

          {/* 3. Shipping and the order */}
          {options ? (
            <div className="space-y-2">
              {options.length ? (
                options.map((o) => (
                  <label key={o.methodClassification} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="print-shipping"
                      checked={tier === o.methodClassification}
                      onChange={() => setTier(o.methodClassification)}
                    />
                    <span className="capitalize">{o.methodClassification}</span>
                    {o.methodName ? <span className="text-gray-500">({o.methodName})</span> : null}
                    <span>{money(o.price)}</span>
                    {o.estimatedDeliveryDateUTC ? (
                      <span className="text-gray-500">
                        arrives about {new Date(o.estimatedDeliveryDateUTC).toLocaleDateString()}
                      </span>
                    ) : null}
                  </label>
                ))
              ) : (
                <p className="text-xs text-red-700 dark:text-red-400">RPI offers no shipping to this address.</p>
              )}
              {chosen ? (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {quantity} × {money(unit)} + {money(chosen.price)} shipping
                  {unit != null ? ` = ${money(unit * quantity + chosen.price)} before tax` : ''}.
                </p>
              ) : null}
              <button
                onClick={() => submit.mutate()}
                disabled={!chosen || submit.isPending}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {submit.isPending ? 'Placing…' : info.mode === 'sandbox' ? 'Place sandbox order' : 'Place order'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Orders */}
      {placed.length ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Orders</h3>
          <ul data-testid="print-orders" className="space-y-2">
            {placed.map((o) => (
              <li key={o.id} className="rounded-lg border border-gray-200 p-2 text-xs dark:border-gray-700">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    {o.quantity} × {o.edition_label}
                    {volumeCount > 1 ? `, book ${o.volume_index}` : ''}
                  </span>
                  {o.order_kind === 'reader' ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" data-testid="reader-order">
                      reader: {o.buyer_name ?? 'unknown'}
                      {o.amount_total_cents != null ? `, paid $${(o.amount_total_cents / 100).toFixed(2)}` : ''}
                    </span>
                  ) : null}
                  <span
                    title={o.status}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  >
                    {printStatusLabel(o.status)}
                  </span>
                  {o.mode === 'sandbox' ? <span className="text-amber-700 dark:text-amber-400">sandbox</span> : null}
                  <span className="text-gray-500">
                    placed {o.submitted_at ? new Date(o.submitted_at).toLocaleString() : ''}
                    {o.last_event ? ` · last: ${o.last_event}` : ''}
                  </span>
                  {o.pricing?.orderTotal != null ? <span>{money(o.pricing.orderTotal)}</span> : null}
                  <span className="ml-auto flex gap-2">
                    <button className="text-brand-600 hover:underline" onClick={() => act.mutate({ id: o.id, what: 'refresh' })}>
                      Refresh
                    </button>
                    {o.cancellable ? (
                      <button className="text-red-600 hover:underline" onClick={() => act.mutate({ id: o.id, what: 'cancel' })}>
                        Cancel
                      </button>
                    ) : null}
                  </span>
                </div>
                {o.validations.filter((v) => v.fatalError).map((v) => (
                  <p key={v.humanReadableString} className="mt-1 text-red-700 dark:text-red-400">
                    {v.humanReadableString}
                  </p>
                ))}
                {o.tracking.map((t) =>
                  t.trackingUrl ? (
                    <a key={t.trackingUrl} href={t.trackingUrl} target="_blank" rel="noreferrer" className="mt-1 block text-brand-600 hover:underline">
                      Track {t.trackingNumber}
                    </a>
                  ) : null,
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ReaderOffers projectId={projectId} orders={(orders ?? []).filter((o) => o.order_kind !== 'reader')} volumeCount={volumeCount} />
    </div>
  );
}

/**
 * Sprint 9: sell a prepared edition to readers from the book's public page (/books/<slug>/print).
 * Readers pay through Stripe; the order goes to RPI once the payment clears. One price per edition.
 */
export function ReaderOffers({ projectId, orders, volumeCount }: { projectId: string; orders: PrintOrder[]; volumeCount: number }) {
  const queryClient = useQueryClient();
  const { data: offers } = useQuery({
    queryKey: ['print-offers', projectId],
    queryFn: async () => (await apiFetch<ApiEnvelope<{ offers: PrintOffer[] }>>(`/api/print/project/${projectId}/offers`)).data!.offers,
  });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // The newest prepared order of each edition and book is the proof readers would get.
  const proofs = new Map<string, PrintOrder>();
  for (const o of orders) {
    const key = `${o.volume_index}|${o.edition}`;
    if (!proofs.has(key)) proofs.set(key, o);
  }
  const save = useMutation({
    mutationFn: async (body: { source_order_id: string; price_cents: number; enabled: boolean }) =>
      apiFetch(`/api/print/project/${projectId}/offers`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setError(''); void queryClient.invalidateQueries({ queryKey: ['print-offers', projectId] }); },
    onError: (err) => setError(messageOf(err)),
  });
  if (!proofs.size) return null;
  return (
    <div className="space-y-2" data-testid="reader-offers">
      <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Sell printed copies to readers</h3>
      <p className="text-xs text-gray-500">Readers order from your book page and pay through Stripe; the copy is printed and shipped by RPI from these files.</p>
      {[...proofs.values()].map((o) => {
        const offer = (offers ?? []).find((x) => x.edition === o.edition && x.volume_index === o.volume_index);
        const key = `${o.volume_index}|${o.edition}`;
        const value = prices[key] ?? (offer ? (offer.price_cents / 100).toFixed(2) : '');
        const cents = Math.round(Number(value) * 100);
        return (
          <div key={key} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`offer-${o.edition}`}>
            <span className="font-medium text-gray-800 dark:text-gray-200">{o.edition_label}{volumeCount > 1 ? `, book ${o.volume_index}` : ''}</span>
            {o.quote?.unit_price != null ? <span className="text-gray-500">costs {money(o.quote.unit_price)} to print</span> : null}
            <label className="flex items-center gap-1">$
              <input aria-label={`Reader price for ${o.edition_label}`} value={value} onChange={(e) => setPrices({ ...prices, [key]: e.target.value })}
                className="w-20 rounded border border-gray-300 px-1 py-0.5 dark:border-gray-600 dark:bg-gray-800" inputMode="decimal" />
            </label>
            <button type="button" disabled={!(cents >= 100) || save.isPending}
              onClick={() => save.mutate({ source_order_id: o.id, price_cents: cents, enabled: true })}
              className="rounded bg-brand-600 px-2 py-0.5 text-white disabled:opacity-50">{offer?.enabled ? 'Update price' : 'Sell at this price'}</button>
            {offer?.enabled ? (
              <>
                <span className="text-emerald-700 dark:text-emerald-300">on sale at ${(offer.price_cents / 100).toFixed(2)}</span>
                <button type="button" onClick={() => save.mutate({ source_order_id: offer.source_order_id, price_cents: offer.price_cents, enabled: false })}
                  className="text-red-600 hover:underline">Stop selling</button>
              </>
            ) : null}
          </div>
        );
      })}
      {error ? <p className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
