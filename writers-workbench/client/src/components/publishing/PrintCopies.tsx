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
    </div>
  );
}
