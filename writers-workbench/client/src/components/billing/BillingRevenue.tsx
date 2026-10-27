/**
 * Admin revenue and payment health (Sprint 9, S9-7): MRR / ARR / churn from Stripe, revenue by month,
 * subscribers by tier, the trial funnel, failed payments with a retry, the Stripe event log, and
 * (superusers) refunds.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { money } from './BillingPage';

interface Revenue {
  tier_breakdown: Record<string, number>;
  trial_funnel: { trials_started: number; active_trials: number; converted: number; churned: number };
  past_due: string[];
  stripe: null | { error: string } | {
    mrr_cents: number; arr_cents: number; customers: number; customers_more: boolean; active_subscribers: number;
    past_due_subscribers: number; churn_rate_30d: number; revenue_by_month_cents: Record<string, number>;
  };
}

interface Subscriber {
  user_id: string; tier: string | null; payment_status: string; status: string; billing_cycle: string;
  current_period_end: string | null; payment_failures: number; mrr_cents: number;
}

interface StripeEvent { id: string; event_type: string; status: string; error: string | null; user_id: string | null; received_at: string }

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={testId}>
      <p className="text-xs uppercase text-gray-500">{label}</p>
      <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

export default function BillingRevenue({ isSuperuser }: { isSuperuser: boolean }) {
  const queryClient = useQueryClient();
  const revenue = useQuery({ queryKey: ['billing-revenue'], queryFn: () => apiFetch<{ data: Revenue }>('/api/admin/billing/revenue') });
  const subs = useQuery({ queryKey: ['billing-subscribers'], queryFn: () => apiFetch<{ data: Subscriber[] }>('/api/admin/billing/subscribers') });
  const events = useQuery({ queryKey: ['billing-events'], queryFn: () => apiFetch<{ data: StripeEvent[] }>('/api/admin/billing/events?limit=50') });
  const [msg, setMsg] = useState('');
  const [refund, setRefund] = useState({ pi: '', amount: '', reason: '' });

  const r = revenue.data?.data;
  const stripe = r?.stripe && !('error' in r.stripe) ? r.stripe : null;
  const months = stripe ? Object.entries(stripe.revenue_by_month_cents) : [];
  const peak = Math.max(1, ...months.map(([, v]) => v));

  async function retry(userId: string) {
    setMsg('');
    try {
      const res = await apiFetch<{ data: { status: string } }>(`/api/admin/billing/retry/${encodeURIComponent(userId)}`, { method: 'POST' });
      setMsg(`Retried ${userId}: invoice ${res.data.status}.`);
      await queryClient.invalidateQueries({ queryKey: ['billing-subscribers'] });
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Retry failed');
    }
  }

  async function issueRefund() {
    setMsg('');
    try {
      const res = await apiFetch<{ data: { amount_cents: number; credits_removed: number } }>('/api/superuser/billing/refund', {
        method: 'POST',
        body: JSON.stringify({ stripe_payment_intent_id: refund.pi.trim(), reason: refund.reason.trim(), ...(refund.amount ? { amount_cents: Math.round(Number(refund.amount) * 100) } : {}) }),
      });
      setMsg(`Refunded ${money(res.data.amount_cents)}${res.data.credits_removed ? `; ${res.data.credits_removed} credits taken back` : ''}.`);
      setRefund({ pi: '', amount: '', reason: '' });
      await queryClient.invalidateQueries({ queryKey: ['billing-revenue'] });
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Refund failed');
    }
  }

  if (revenue.isLoading) return <p className="text-sm text-gray-500">Loading revenue…</p>;
  if (!r) return <p className="text-sm text-red-600">Could not load revenue.</p>;

  return (
    <div className="space-y-5" data-testid="billing-revenue">
      {msg && <p className="rounded border border-gray-200 bg-gray-50 p-2 text-sm dark:border-gray-700 dark:bg-gray-900" role="status">{msg}</p>}
      {r.stripe && 'error' in r.stripe && <p className="text-sm text-amber-700">{r.stripe.error}</p>}
      {!r.stripe && <p className="text-sm text-gray-500">Stripe is not configured; figures below come from the database only.</p>}
      {stripe && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="MRR" value={money(stripe.mrr_cents)} testId="rev-mrr" />
          <Stat label="ARR" value={money(stripe.arr_cents)} />
          <Stat label="Active subscribers" value={String(stripe.active_subscribers)} testId="rev-active" />
          <Stat label="Churn (30 days)" value={`${(stripe.churn_rate_30d * 100).toFixed(1)}%`} />
          <Stat label="Customers" value={`${stripe.customers}${stripe.customers_more ? '+' : ''}`} />
          <Stat label="Past due" value={String(stripe.past_due_subscribers)} />
          <Stat label="Active trials" value={String(r.trial_funnel.active_trials)} />
          <Stat label="Trials converted" value={String(r.trial_funnel.converted)} />
        </div>
      )}
      {stripe && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase text-gray-500">Revenue by month</h3>
          <div className="flex h-32 items-end gap-1" data-testid="rev-chart">
            {months.map(([m, v]) => (
              <div key={m} className="flex flex-1 flex-col items-center gap-1" title={`${m}: ${money(v)}`}>
                <div className="w-full rounded-t bg-brand-500" style={{ height: `${Math.round((v / peak) * 100)}%` }} />
                <span className="text-[10px] text-gray-500">{m.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase text-gray-500">Subscribers by tier</h3>
        <ul className="text-sm">{Object.entries(r.tier_breakdown).map(([t, n]) => <li key={t}>{t}: {n}</li>)}</ul>
        <p className="mt-1 text-xs text-gray-500">Trial funnel: {r.trial_funnel.trials_started} started · {r.trial_funnel.active_trials} active · {r.trial_funnel.converted} paid · {r.trial_funnel.churned} churned</p>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase text-gray-500">Subscribers</h3>
        <table className="w-full text-sm" data-testid="rev-subscribers">
          <thead><tr className="text-left text-gray-500"><th>User</th><th>Plan</th><th>Payment</th><th>Renews</th><th>MRR</th><th /></tr></thead>
          <tbody>
            {(subs.data?.data ?? []).map((s) => (
              <tr key={s.user_id} className={`border-t border-gray-100 dark:border-gray-800 ${s.status === 'past_due' ? 'text-red-700 dark:text-red-300' : ''}`}>
                <td className="py-1">{s.user_id}</td><td>{s.tier}</td><td>{s.payment_status}{s.payment_failures ? ` (${s.payment_failures} failed)` : ''}</td>
                <td>{s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'}</td><td>{money(s.mrr_cents)}</td>
                <td className="text-right">{s.status === 'past_due' && <button type="button" onClick={() => void retry(s.user_id)} className="text-xs underline">Retry payment</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase text-gray-500">Recent Stripe events</h3>
        <table className="w-full text-xs" data-testid="rev-events">
          <tbody>
            {(events.data?.data ?? []).map((e) => (
              <tr key={e.id} className="border-t border-gray-100 dark:border-gray-800">
                <td className="py-1">{new Date(e.received_at).toLocaleString()}</td><td>{e.event_type}</td>
                <td className={e.status === 'failed' ? 'text-red-600' : ''}>{e.status}{e.error ? `: ${e.error}` : ''}</td><td>{e.user_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {isSuperuser && (
        <section className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="rev-refund">
          <h3 className="mb-2 text-sm font-semibold uppercase text-gray-500">Refund a payment</h3>
          <div className="flex flex-wrap gap-2 text-sm">
            <input aria-label="Payment intent id" placeholder="pi_…" value={refund.pi} onChange={(e) => setRefund({ ...refund, pi: e.target.value })} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            <input aria-label="Amount in dollars (blank = full)" placeholder="Amount $ (blank = full)" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} className="w-40 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            <input aria-label="Reason" placeholder="Reason" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} className="flex-1 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            <button type="button" disabled={!/^pi_/.test(refund.pi.trim()) || refund.reason.trim().length < 3} onClick={() => void issueRefund()} className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50">Refund</button>
          </div>
        </section>
      )}
    </div>
  );
}
