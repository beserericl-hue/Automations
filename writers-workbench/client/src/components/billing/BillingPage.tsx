/**
 * Billing (Sprint 9, S9-3 / S9-6): the current plan, the card on file, invoices, and changing plan.
 *
 * Nothing here grants anything: Subscribe and upgrades go to Stripe, and the page shows what the
 * webhook has written. /billing/success waits for that write before saying "confirmed".
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';
import type { SubscriptionTier } from '../../types/database';

export interface BillingStatus {
  managed: boolean;
  payments_ready: boolean;
  tier: { id: string; name: string; display_name: string; monthly_credits: number; monthly_price_cents: number; annual_price_cents: number } | null;
  status: string | null;
  stripe_status: string | null;
  billing_cycle: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  has_stripe_subscription: boolean;
  pending_change: { tier_id: string; display_name: string; billing_cycle: string | null; at: string | null } | null;
  payment_failures: number;
  card: { brand: string; last4: string; exp: string } | null;
  upcoming: { amount_due_cents: number; currency: string; date: string | null } | null;
  invoices: Array<{ id: string; number: string | null; date: string | null; amount_paid_cents: number; status: string | null; pdf: string | null; url: string | null }>;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function dateOf(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
}

type Cycle = 'monthly' | 'annual';

/** What changing from the current plan to `tier` on `cycle` will do, in words (S9-6 comparison). */
export function changeSummary(status: BillingStatus, tier: SubscriptionTier, cycle: Cycle): { kind: 'subscribe' | 'upgrade' | 'downgrade' | 'same'; text: string } {
  const price = cycle === 'annual' ? tier.annual_price_cents : tier.monthly_price_cents;
  if (!status.has_stripe_subscription) {
    return { kind: 'subscribe', text: `${money(price)} ${cycle === 'annual' ? 'a year' : 'a month'}, ${tier.monthly_credits} credits a month.` };
  }
  const cur = status.tier;
  const curCycle = (status.billing_cycle === 'annual' ? 'annual' : 'monthly') as Cycle;
  if (cur && cur.id === tier.id && curCycle === cycle) return { kind: 'same', text: 'Your current plan.' };
  const monthly = (t: { monthly_price_cents: number; annual_price_cents: number }, c: Cycle) => (c === 'annual' ? t.annual_price_cents / 12 : t.monthly_price_cents);
  const upgrade = !cur || monthly(tier, cycle) > monthly(cur, curCycle);
  return upgrade
    ? { kind: 'upgrade', text: `You are charged now for the rest of this period (prorated), and get ${tier.monthly_credits} credits straight away.` }
    : { kind: 'downgrade', text: `Your plan changes to ${tier.display_name} at the end of the current period, on ${dateOf(status.current_period_end)}.` };
}

export default function BillingPage() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [confirm, setConfirm] = useState<{ tier: SubscriptionTier; summary: ReturnType<typeof changeSummary> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const status = useQuery({ queryKey: ['billing-status'], queryFn: () => apiFetch<{ data: BillingStatus }>('/api/billing/status') });
  const tiers = useQuery({ queryKey: ['tiers'], queryFn: () => apiFetch<{ data: SubscriptionTier[] }>('/api/tiers'), staleTime: 300_000 });
  const s = status.data?.data;
  const paid = (tiers.data?.data ?? []).filter((t) => t.monthly_price_cents > 0 || t.annual_price_cents > 0);

  useEffect(() => {
    if (s?.billing_cycle === 'annual') setCycle('annual');
  }, [s?.billing_cycle]);

  // ?plan=pro from the trial reminder email: open that plan's confirmation.
  useEffect(() => {
    const want = params.get('plan');
    if (!want || !s || confirm) return;
    const t = paid.find((x) => x.name === want);
    if (t) setConfirm({ tier: t, summary: changeSummary(s, t, cycle) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, s, paid.length]);

  async function act(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch<{ data: Record<string, unknown> }>(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      return res.data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function confirmChange() {
    if (!confirm || !s) return;
    const { tier, summary } = confirm;
    if (summary.kind === 'subscribe') {
      const data = await act('/api/billing/checkout', { tier_id: tier.id, billing_cycle: cycle });
      if (data?.checkout_url) window.location.assign(String(data.checkout_url));
      return;
    }
    const data = await act('/api/billing/change', { tier_id: tier.id, billing_cycle: cycle });
    if (data) {
      setNotice(data.change === 'upgrade' ? `Upgraded to ${tier.display_name}.` : `Your plan changes to ${tier.display_name} on ${dateOf(String(data.effective))}.`);
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: ['billing-status'] });
    }
  }

  async function portal() {
    const data = await act('/api/billing/portal');
    if (data?.portal_url) window.location.assign(String(data.portal_url));
  }

  async function toggleCancel(cancel: boolean) {
    const data = await act(cancel ? '/api/billing/cancel' : '/api/billing/reactivate');
    if (data) {
      setNotice(cancel ? `Your subscription is cancelled. You have access until ${dateOf(String(data.access_until))}.` : 'Your subscription will renew as normal.');
      await queryClient.invalidateQueries({ queryKey: ['billing-status'] });
    }
  }

  if (status.isLoading) return <p className="text-sm text-gray-500">Loading billing…</p>;
  if (!s) return <p className="text-sm text-red-600">Could not load billing.</p>;

  if (s.managed) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="billing-managed">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Billing</h1>
        <p className="text-gray-600 dark:text-gray-300">Your plan ({s.tier?.display_name ?? 'internal'}) is managed by an administrator and is never charged.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-5" data-testid="billing-page">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Billing</h1>
      {!s.payments_ready && <p className="rounded border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900">Payments are not available yet.</p>}
      {s.status === 'past_due' && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200" data-testid="billing-past-due">
          Your last payment failed{s.payment_failures > 1 ? ` (${s.payment_failures} attempts)` : ''}. Update your card to keep your plan.
          <button type="button" onClick={() => void portal()} className="ml-2 underline">Update card</button>
        </p>
      )}
      {notice && <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100" role="status">{notice}</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" data-testid="billing-current">
        <h2 className="text-sm font-semibold uppercase text-gray-500">Current plan</h2>
        <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{s.tier?.display_name ?? 'No plan'}</p>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {s.has_stripe_subscription
            ? `${s.billing_cycle === 'annual' ? money(s.tier?.annual_price_cents ?? 0) + ' a year' : money(s.tier?.monthly_price_cents ?? 0) + ' a month'} · ${s.cancel_at_period_end ? `ends ${dateOf(s.current_period_end)}` : `renews ${dateOf(s.current_period_end)}`}`
            : s.trial_end ? `Free trial until ${dateOf(s.trial_end)}` : 'Not billed'}
        </p>
        {s.pending_change && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300" data-testid="billing-pending">Your plan will change to {s.pending_change.display_name} on {dateOf(s.pending_change.at)}.</p>}
        {s.cancel_at_period_end && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300" data-testid="billing-cancelled">Your subscription is cancelled. You have access until {dateOf(s.current_period_end)}.</p>}
        {s.card && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Card: {s.card.brand} ending {s.card.last4} (expires {s.card.exp})</p>}
        {s.upcoming && !s.cancel_at_period_end && <p className="text-sm text-gray-600 dark:text-gray-300">Next payment: {money(s.upcoming.amount_due_cents)} on {dateOf(s.upcoming.date)}</p>}
        {s.has_stripe_subscription && s.payments_ready && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void portal()} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">Manage billing</button>
            {s.cancel_at_period_end
              ? <button type="button" disabled={busy} onClick={() => void toggleCancel(false)} className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white">Reactivate</button>
              : <button type="button" disabled={busy} onClick={() => void toggleCancel(true)} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-700 dark:text-red-300">Cancel subscription</button>}
          </div>
        )}
      </section>

      {s.payments_ready && (
        <section data-testid="billing-plans">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{s.has_stripe_subscription ? 'Change plan' : 'Choose a plan'}</h2>
            <div className="flex rounded border border-gray-300 text-sm dark:border-gray-600" role="tablist">
              {(['monthly', 'annual'] as Cycle[]).map((c) => (
                <button key={c} type="button" role="tab" aria-selected={cycle === c} onClick={() => setCycle(c)}
                  className={`px-3 py-1 ${cycle === c ? 'bg-brand-600 text-white' : ''}`}>{c === 'monthly' ? 'Monthly' : 'Annual'}</button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {paid.map((t) => {
              const summary = changeSummary(s, t, cycle);
              const price = cycle === 'annual' ? t.annual_price_cents : t.monthly_price_cents;
              return (
                <div key={t.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" data-testid={`plan-${t.name}`}>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">{t.display_name}</p>
                  <p className="text-2xl font-bold">{money(price)}<span className="text-sm font-normal text-gray-500">/{cycle === 'annual' ? 'year' : 'month'}</span></p>
                  <p className="text-sm text-gray-600 dark:text-gray-300">{t.monthly_credits} credits a month · up to {t.features?.max_projects ?? '—'} projects</p>
                  <button type="button" disabled={summary.kind === 'same' || busy} onClick={() => setConfirm({ tier: t, summary })}
                    className="mt-3 w-full rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                    {summary.kind === 'same' ? 'Current plan' : summary.kind === 'subscribe' ? 'Subscribe' : summary.kind === 'upgrade' ? 'Upgrade' : 'Downgrade'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {s.invoices.length > 0 && (
        <section data-testid="billing-invoices">
          <h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Invoices</h2>
          <table className="w-full text-sm">
            <tbody>
              {s.invoices.map((i) => (
                <tr key={i.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1.5">{dateOf(i.date)}</td><td>{i.number}</td><td>{money(i.amount_paid_cents)}</td><td>{i.status}</td>
                  <td className="text-right">{i.pdf && <a href={i.pdf} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">PDF</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Confirm plan">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900" data-testid="tier-comparison">
            <h3 className="text-lg font-semibold">{confirm.summary.kind === 'subscribe' ? 'Subscribe to' : 'Change to'} {confirm.tier.display_name}</h3>
            <table className="mt-3 w-full text-sm">
              <tbody>
                <tr><td className="text-gray-500">Now</td><td>{s.tier?.display_name ?? '—'}{s.tier ? ` · ${s.tier.monthly_credits} credits` : ''}</td></tr>
                <tr><td className="text-gray-500">New</td><td>{confirm.tier.display_name} · {confirm.tier.monthly_credits} credits</td></tr>
              </tbody>
            </table>
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{confirm.summary.text}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="rounded border border-gray-300 px-3 py-1.5 text-sm">Back</button>
              <button type="button" disabled={busy} onClick={() => void confirmChange()} className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {busy ? 'Working…' : confirm.summary.kind === 'subscribe' ? 'Continue to payment' : 'Confirm change'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** After Stripe Checkout: wait for the webhook to activate the plan, then send the user home. */
export function BillingSuccess() {
  const { refreshSubscription } = useUser();
  const navigate = useNavigate();
  const [confirmed, setConfirmed] = useState(false);
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (confirmed) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch<{ data: BillingStatus }>('/api/billing/status');
        if (res.data.has_stripe_subscription && res.data.status === 'active') {
          setConfirmed(true);
          await refreshSubscription();
          setTimeout(() => navigate('/'), 2500);
          return;
        }
      } catch { /* keep waiting */ }
      setWaited((w) => w + 1);
    }, 2000);
    return () => clearTimeout(t);
  }, [waited, confirmed, navigate, refreshSubscription]);
  return (
    <div className="mx-auto max-w-lg space-y-3 py-10 text-center" data-testid="billing-success">
      <h1 className="text-2xl font-semibold">{confirmed ? 'Payment confirmed' : 'Confirming your payment…'}</h1>
      <p className="text-gray-600 dark:text-gray-300">{confirmed ? 'Your plan is active. Taking you to your dashboard.' : waited > 15 ? 'This is taking longer than usual. Your plan will appear on the Billing page as soon as Stripe confirms it.' : 'This takes a few seconds.'}</p>
      <Link to="/billing" className="text-brand-700 hover:underline dark:text-brand-300">Billing</Link>
    </div>
  );
}

export function BillingCancel() {
  return (
    <div className="mx-auto max-w-lg space-y-3 py-10 text-center" data-testid="billing-cancel">
      <h1 className="text-2xl font-semibold">No charges made</h1>
      <p className="text-gray-600 dark:text-gray-300">Checkout was cancelled. You can choose a plan whenever you are ready.</p>
      <Link to="/billing" className="text-brand-700 hover:underline dark:text-brand-300">Back to plans</Link>
    </div>
  );
}
