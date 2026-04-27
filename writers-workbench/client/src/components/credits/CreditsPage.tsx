// Sprint 8 (S8-6): credits dashboard. Shows balance, monthly allowance,
// transaction history, and a Buy More Credits section available to all tiers.

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '../../contexts/UserContext';
import { usePermissions } from '../../hooks/usePermissions';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import type { CreditTransaction } from '../../types/database';

const PRESETS = [10, 25, 50, 100];

export default function CreditsPage() {
  const { subscription, refreshSubscription } = useUser();
  const { creditsRemaining, creditsMonthly, tierDisplayName, isTrialUser, trialDaysRemaining } = usePermissions();
  const [tx, setTx] = useState<CreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<ApiEnvelope<CreditTransaction[]>>('/api/credits/transactions?limit=200');
        setTx(res.data ?? []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const usedThisPeriod = subscription?.credits_used_this_period ?? 0;
  const totalAvailable = creditsRemaining + usedThisPeriod;
  const usedPct = totalAvailable > 0 ? Math.min(100, Math.round((usedThisPeriod / totalAvailable) * 100)) : 0;
  const periodResetDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString()
    : null;

  // Group transactions for "usage by category" tile
  const breakdown = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const t of tx) {
      if (t.transaction_type !== 'usage') continue;
      const key = (t.metadata?.category as string | undefined) ?? t.description?.split(':')[0] ?? 'other';
      acc[key] = (acc[key] ?? 0) + Math.abs(t.amount);
    }
    return acc;
  }, [tx]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Credits</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {tierDisplayName ? `Plan: ${tierDisplayName}` : 'No active subscription'}
          {isTrialUser && trialDaysRemaining !== null && (
            <span className="ml-2 text-amber-700">— {trialDaysRemaining} trial day{trialDaysRemaining === 1 ? '' : 's'} remaining</span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-xs font-medium uppercase text-gray-500">Balance</div>
          <div className="mt-1 text-3xl font-bold">{creditsRemaining}</div>
          <div className="mt-1 text-xs text-gray-500">of {creditsMonthly} monthly</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-xs font-medium uppercase text-gray-500">Used this period</div>
          <div className="mt-1 text-3xl font-bold">{usedThisPeriod}</div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
            <div
              className={`h-full ${usedPct < 60 ? 'bg-green-500' : usedPct < 90 ? 'bg-amber-500' : 'bg-red-500'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="text-xs font-medium uppercase text-gray-500">Resets</div>
          <div className="mt-1 text-lg">{periodResetDate ?? 'Never (full access)'}</div>
        </div>
      </div>

      <PurchaseSection onPurchase={refreshSubscription} />

      {Object.keys(breakdown).length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Usage by category</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {Object.entries(breakdown).map(([k, v]) => (
              <div key={k} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                <div className="text-xs uppercase text-gray-500">{k}</div>
                <div className="text-base font-semibold">{v} credits</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold">Transaction history</h2>
        <div className="mt-3 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : tx.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                    No transactions yet.
                  </td>
                </tr>
              ) : (
                tx.map((t) => (
                  <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 font-mono text-xs">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">{t.transaction_type}</span>
                    </td>
                    <td className="px-3 py-2">{t.description ?? '—'}</td>
                    <td className={`px-3 py-2 text-right font-mono ${t.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {t.amount > 0 ? '+' : ''}
                      {t.amount}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{t.balance_after}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PurchaseSection({ onPurchase }: { onPurchase: () => Promise<void> }) {
  const [pricing, setPricing] = useState<{ price_per_credit_cents: number; tier_display_name: string } | null>(null);
  const [amount, setAmount] = useState(25);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        interface Pricing { price_per_credit_cents: number; tier_display_name: string }
        const res = await apiFetch<ApiEnvelope<Pricing>>('/api/credits/pricing');
        if (res.data) setPricing(res.data);
      } catch {
        // ignore — section will hide
      }
    })();
  }, []);

  if (!pricing) return null;

  const totalCents = amount * pricing.price_per_credit_cents;

  const handlePurchase = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch<ApiEnvelope<{ amount_purchased: number; balance_after: number; price_paid_cents: number }>>(
        '/api/credits/purchase',
        { method: 'POST', body: JSON.stringify({ amount }) },
      );
      if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Purchase failed');
      setSuccess(`Purchased ${res.data.amount_purchased} credits — new balance: ${res.data.balance_after}`);
      await onPurchase();
      setConfirmOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
      <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100">Buy more credits</h2>
      <p className="mt-1 text-sm text-blue-800 dark:text-blue-200">
        ${(pricing.price_per_credit_cents / 100).toFixed(2)} per credit on the {pricing.tier_display_name} plan.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className={`rounded px-3 py-1 text-sm ${
              amount === p ? 'bg-blue-600 text-white' : 'bg-white border border-blue-300 text-blue-800 hover:bg-blue-100'
            }`}
          >
            {p}
          </button>
        ))}
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(1, Number(e.target.value)))}
          className="w-24 rounded border border-blue-300 bg-white px-2 py-1 text-sm"
        />
        <span className="text-sm text-blue-900 dark:text-blue-100">
          = <strong>${(totalCents / 100).toFixed(2)}</strong>
        </span>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="rounded bg-blue-700 px-4 py-1 text-sm font-semibold text-white hover:bg-blue-800"
        >
          Purchase
        </button>
      </div>

      {error && <div className="mt-2 text-sm text-red-700">{error}</div>}
      {success && <div className="mt-2 text-sm text-green-700">{success}</div>}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirmOpen(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Confirm purchase</h3>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              You are purchasing <strong>{amount} credits</strong> for{' '}
              <strong>${(totalCents / 100).toFixed(2)}</strong>.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Note: payment processing is deferred to Sprint 9 (Stripe). This currently records the transaction
              for admin reconciliation and updates your balance immediately.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded border border-gray-300 px-3 py-1 text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handlePurchase()}
                className="rounded bg-blue-700 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {loading ? 'Processing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
