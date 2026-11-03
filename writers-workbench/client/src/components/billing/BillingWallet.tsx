/**
 * The credits half of the Billing page (2026-11-03): the saved card, "Add books", "Recharge credits",
 * evergreen auto-recharge, and the purchase history.
 *
 * Stripe holds the card (a PaymentMethod on the customer, collected on Stripe's own page) and every
 * payment; this page only starts things and shows what Stripe and the webhook have recorded. Credits
 * are never added from here: a purchase shows "arriving" until the webhook has granted them.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';
import { PurchaseReturn } from '../credits/CreditsPage';
import { dateOf, money } from './BillingPage';

export interface WalletPack {
  name: string;
  kind: 'book' | 'topup';
  display_name: string;
  description: string | null;
  credits: number;
  price_cents: number;
}

export interface Wallet {
  payments_ready: boolean;
  managed: boolean;
  packs: WalletPack[];
  card: { brand: string; last4: string; exp_month: number; exp_year: number } | null;
  has_customer: boolean;
  auto_recharge: {
    enabled: boolean;
    threshold: number;
    pack: string | null;
    monthly_cap_cents: number | null;
    paused: boolean;
    paused_reason: string | null;
    paused_at: string | null;
    in_flight: boolean;
    last_event: string | null;
    last_event_at: string | null;
  };
}

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

const KIND_LABEL: Record<PurchaseRow['kind'], string> = { book: 'Books', topup: 'Top-up', auto_recharge: 'Auto-recharge', custom: 'Credits' };

/** "3 x Full Book = 6,000 credits for $597.00" */
export function packTotal(pack: WalletPack, quantity: number): { credits: number; cents: number } {
  return { credits: pack.credits * quantity, cents: pack.price_cents * quantity };
}

const box = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900';
const btn = 'rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50';
const btnGhost = 'rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 disabled:opacity-50';

export default function BillingWallet() {
  const queryClient = useQueryClient();
  const { refreshSubscription } = useUser();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});

  const wallet = useQuery({ queryKey: ['billing-wallet'], queryFn: () => apiFetch<{ data: Wallet }>('/api/billing/wallet') });
  const purchases = useQuery({ queryKey: ['billing-purchases'], queryFn: () => apiFetch<{ data: PurchaseRow[] }>('/api/billing/purchases') });
  const w = wallet.data?.data;

  const [auto, setAuto] = useState({ enabled: false, threshold: 100, pack: 'topup_500', cap: '' });
  useEffect(() => {
    if (!w?.auto_recharge || !Array.isArray(w.packs)) return;
    setAuto({
      enabled: w.auto_recharge.enabled,
      threshold: w.auto_recharge.threshold,
      pack: w.auto_recharge.pack ?? w.packs.find((p) => p.kind === 'topup')?.name ?? 'topup_500',
      cap: w.auto_recharge.monthly_cap_cents ? String(w.auto_recharge.monthly_cap_cents / 100) : '',
    });
  }, [w]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['billing-wallet'] }),
      queryClient.invalidateQueries({ queryKey: ['billing-purchases'] }),
      queryClient.invalidateQueries({ queryKey: ['billing-status'] }),
    ]);
  }

  // Back from Stripe's card form: make the card the default now (the webhook does too).
  useEffect(() => {
    const sid = params.get('session_id');
    if (params.get('card') !== 'saved' || !sid) return;
    void (async () => {
      try {
        await apiFetch('/api/billing/card/confirm', { method: 'POST', body: JSON.stringify({ session_id: sid }) });
        setNotice('Card saved. It is now your default for your plan and for purchases.');
      } catch {
        setNotice('Card saved. It may take a moment to appear.');
      }
      params.delete('card');
      params.delete('session_id');
      setParams(params, { replace: true });
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function call<T>(path: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch<{ data: T }>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return res.data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveCard() {
    const data = await call<{ checkout_url: string }>('/api/billing/card/setup', 'POST');
    if (data?.checkout_url) window.location.assign(data.checkout_url);
  }

  async function removeCard() {
    if (!window.confirm('Remove your saved card? Auto-recharge will be switched off.')) return;
    const data = await call<{ removed: boolean }>('/api/billing/card', 'DELETE');
    if (data) {
      setNotice(data.removed ? 'Card removed.' : 'There was no card to remove.');
      await refresh();
    }
  }

  async function portal() {
    const data = await call<{ portal_url: string }>('/api/billing/portal', 'POST');
    if (data?.portal_url) window.location.assign(data.portal_url);
  }

  async function buy(pack: WalletPack, quantity: number) {
    const t = packTotal(pack, quantity);
    const what = `${quantity > 1 ? `${quantity} x ` : ''}${pack.display_name} (${t.credits.toLocaleString()} credits) for ${money(t.cents)}`;
    if (!window.confirm(`Buy ${what}${w?.card ? ` with your ${w.card.brand} ending ${w.card.last4}` : ''}?`)) return;
    const data = await call<{ status: string; checkout_url?: string; credits: number }>('/api/billing/purchase', 'POST', { pack: pack.name, quantity });
    if (!data) return;
    if (data.status === 'checkout' && data.checkout_url) {
      window.location.assign(data.checkout_url);
      return;
    }
    setNotice(`Payment received: ${data.credits.toLocaleString()} credits are being added to your balance.`);
    // The webhook grants them within seconds; show them when they land.
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      await refreshSubscription();
      await refresh();
    }
  }

  async function saveAuto() {
    const cap = auto.cap.trim() ? Math.round(Number(auto.cap) * 100) : null;
    if (cap !== null && (!Number.isFinite(cap) || cap < 100)) {
      setError('The monthly cap must be at least $1, or empty for no cap.');
      return;
    }
    if (!Number.isInteger(auto.threshold) || auto.threshold < 0) {
      setError('The threshold must be a whole number of credits, 0 or more.');
      return;
    }
    const data = await call('/api/billing/auto-recharge', 'PUT', { enabled: auto.enabled, threshold: auto.threshold, pack: auto.pack, monthly_cap_cents: cap });
    if (data) {
      setNotice(auto.enabled ? 'Auto-recharge is on.' : 'Auto-recharge is off.');
      await refresh();
    }
  }

  if (wallet.isLoading) return <p className="text-sm text-gray-500">Loading credits…</p>;
  // A server older than the wallet answers without packs: show nothing rather than break the page.
  if (!w || w.managed || !Array.isArray(w.packs) || !w.auto_recharge) return null;
  const books = w.packs.filter((p) => p.kind === 'book');
  const topups = w.packs.filter((p) => p.kind === 'topup');
  const off = !w.payments_ready;

  return (
    <div className="space-y-5" data-testid="billing-wallet">
      <PurchaseReturn onCredited={async () => { await refreshSubscription(); await refresh(); }} />
      {w.auto_recharge.paused && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200" role="alert" data-testid="auto-recharge-paused">
          Auto-recharge is paused: {w.auto_recharge.paused_reason ?? 'the last payment failed'}. Update your card, then switch auto-recharge back on.
          <button type="button" onClick={() => void saveCard()} className="ml-2 underline">Update card</button>
        </p>
      )}
      {notice && <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100" role="status" data-testid="wallet-notice">{notice}</p>}
      {error && <p className="text-sm text-red-600" role="alert" data-testid="wallet-error">{error}</p>}

      <section className={box} data-testid="billing-card">
        <h2 className="text-sm font-semibold uppercase text-gray-500">Payment method</h2>
        {w.card ? (
          <p className="mt-1 text-gray-900 dark:text-gray-100" data-testid="saved-card">
            {w.card.brand.toUpperCase()} ending {w.card.last4} · expires {String(w.card.exp_month).padStart(2, '0')}/{String(w.card.exp_year).slice(-2)}
          </p>
        ) : (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300" data-testid="no-card">No card saved. Purchases go through Stripe Checkout, which can save one for you.</p>
        )}
        <p className="text-xs text-gray-500">Your card is stored by Stripe, never by us. It is used for your plan and for the purchases below.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy || off} onClick={() => void saveCard()} className={btn}>{w.card ? 'Replace card' : 'Save a card'}</button>
          {w.card && <button type="button" disabled={busy} onClick={() => void removeCard()} className={btnGhost}>Remove card</button>}
          {w.has_customer && <button type="button" disabled={busy || off} onClick={() => void portal()} className={btnGhost}>Invoices and cancellation (Stripe)</button>}
        </div>
      </section>

      {books.length > 0 && (
        <section data-testid="billing-books">
          <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">Add books</h2>
          <p className="mb-2 text-sm text-gray-600 dark:text-gray-300">Credits for whole books, on top of your plan. They do not expire at the end of the month.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {books.map((p) => {
              const q = qty[p.name] ?? 1;
              const t = packTotal(p, q);
              return (
                <div key={p.name} className={box} data-testid={`pack-${p.name}`}>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">{p.display_name}</p>
                  <p className="text-2xl font-bold">{money(p.price_cents)}<span className="text-sm font-normal text-gray-500"> per book · {p.credits.toLocaleString()} credits</span></p>
                  {p.description && <p className="text-sm text-gray-600 dark:text-gray-300">{p.description}</p>}
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-sm" htmlFor={`qty-${p.name}`}>Books</label>
                    <input id={`qty-${p.name}`} type="number" min={1} max={20} value={q} aria-label={`${p.display_name} quantity`}
                      onChange={(e) => setQty({ ...qty, [p.name]: Math.min(20, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
                      className="w-20 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
                    <span className="text-sm" data-testid={`total-${p.name}`}>= {t.credits.toLocaleString()} credits, {money(t.cents)}</span>
                  </div>
                  <button type="button" disabled={busy || off} onClick={() => void buy(p, q)} className={`${btn} mt-3 w-full`}>
                    Buy {q > 1 ? `${q} books` : '1 book'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {topups.length > 0 && (
        <section data-testid="billing-topups">
          <h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Recharge credits</h2>
          <div className="flex flex-wrap gap-2">
            {topups.map((p) => (
              <button key={p.name} type="button" disabled={busy || off} onClick={() => void buy(p, 1)} className={btnGhost} data-testid={`topup-${p.name}`}>
                {p.credits.toLocaleString()} credits · {money(p.price_cents)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className={box} data-testid="billing-auto-recharge">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Auto-recharge</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300">Never run out mid-book: when your balance falls below a number you choose, we buy a pack with your saved card, once.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={auto.enabled} onChange={(e) => setAuto({ ...auto, enabled: e.target.checked })} aria-label="Auto-recharge on" />
            On
          </label>
          <label className="text-sm">When below
            <input type="number" min={0} value={auto.threshold} aria-label="Threshold credits"
              onChange={(e) => setAuto({ ...auto, threshold: Number(e.target.value) })}
              className="ml-1 w-24 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" /> credits
          </label>
          <label className="text-sm">buy
            <select value={auto.pack} aria-label="Recharge pack" onChange={(e) => setAuto({ ...auto, pack: e.target.value })}
              className="ml-1 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              {w.packs.map((p) => <option key={p.name} value={p.name}>{p.display_name} ({p.credits.toLocaleString()} credits, {money(p.price_cents)})</option>)}
            </select>
          </label>
          <label className="text-sm">Monthly cap $
            <input type="number" min={1} step="1" value={auto.cap} placeholder="none" aria-label="Monthly cap dollars"
              onChange={(e) => setAuto({ ...auto, cap: e.target.value })}
              className="ml-1 w-24 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
          </label>
        </div>
        {!w.card && auto.enabled && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">Save a card first: auto-recharge charges your saved card.</p>}
        {w.auto_recharge.last_event && (
          <p className="mt-2 text-xs text-gray-500" data-testid="auto-recharge-last">Last: {w.auto_recharge.last_event} ({dateOf(w.auto_recharge.last_event_at)})</p>
        )}
        <button type="button" disabled={busy || off} onClick={() => void saveAuto()} className={`${btn} mt-3`}>Save auto-recharge</button>
      </section>

      <section data-testid="billing-purchases">
        <h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Purchase history</h2>
        {(purchases.data?.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-500">No purchases yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Date</th><th>What</th><th>Credits</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(purchases.data?.data ?? []).map((p) => (
                <tr key={p.id} className="border-t border-gray-100 dark:border-gray-800" data-testid="purchase-row">
                  <td className="py-1.5">{dateOf(p.date)}</td>
                  <td>{KIND_LABEL[p.kind]}{p.pack ? `: ${p.quantity > 1 ? `${p.quantity} x ` : ''}${w.packs.find((x) => x.name === p.pack)?.display_name ?? p.pack}` : ''}</td>
                  <td>{p.credits.toLocaleString()}</td>
                  <td>{money(p.amount_cents)}</td>
                  <td title={p.failure ?? undefined}>{p.status}</td>
                  <td className="text-right">{p.receipt_url && <a href={p.receipt_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">Receipt</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
