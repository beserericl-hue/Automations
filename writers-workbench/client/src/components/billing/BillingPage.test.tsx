import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import BillingPage, { changeSummary, type BillingStatus } from './BillingPage';
import BillingRevenue from './BillingRevenue';
import { PurchaseReturn } from '../credits/CreditsPage';
import { apiFetch } from '../../lib/api';
import type { SubscriptionTier } from '../../types/database';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));

const tier = (name: string, monthly: number, annual: number, credits: number): SubscriptionTier =>
  ({ id: `t-${name}`, name, display_name: name[0].toUpperCase() + name.slice(1), monthly_price_cents: monthly, annual_price_cents: annual,
    monthly_credits: credits, features: { max_projects: 10 } } as unknown as SubscriptionTier);
const STANDARD = tier('standard', 1999, 19900, 100);
const PRO = tier('pro', 4999, 49900, 500);

const base: BillingStatus = {
  managed: false, payments_ready: true, tier: { id: 't-standard', name: 'standard', display_name: 'Standard', monthly_credits: 100, monthly_price_cents: 1999, annual_price_cents: 19900 },
  status: 'active', stripe_status: 'active', billing_cycle: 'monthly', current_period_end: '2026-11-27T00:00:00Z', trial_end: null,
  cancel_at_period_end: false, has_stripe_subscription: true, pending_change: null, payment_failures: 0,
  card: { brand: 'visa', last4: '4242', exp: '12/30' }, upcoming: { amount_due_cents: 1999, currency: 'usd', date: '2026-11-27T00:00:00Z' },
  invoices: [{ id: 'in_1', number: 'WW-0001', date: '2026-10-27T00:00:00Z', amount_paid_cents: 1999, status: 'paid', pdf: 'https://pay.stripe.test/in_1.pdf', url: null }],
};

function serve(status: BillingStatus) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/billing/status') return { data: status };
    if (path === '/api/tiers') return { data: [STANDARD, PRO] };
    return { data: {} };
  });
}

describe('changeSummary', () => {
  it('words an upgrade, a downgrade, a first subscription and the current plan', () => {
    expect(changeSummary(base, PRO, 'monthly')).toMatchObject({ kind: 'upgrade' });
    expect(changeSummary(base, PRO, 'monthly').text).toMatch(/charged now.*prorated/);
    const onPro = { ...base, tier: { ...base.tier!, id: 't-pro', monthly_price_cents: 4999, annual_price_cents: 49900 } };
    expect(changeSummary(onPro, STANDARD, 'monthly').text).toMatch(/at the end of the current period/);
    expect(changeSummary({ ...base, has_stripe_subscription: false }, PRO, 'annual')).toMatchObject({ kind: 'subscribe' });
    expect(changeSummary(base, STANDARD, 'monthly').kind).toBe('same');
  });
});

describe('BillingPage', () => {
  beforeEach(() => serve(base));

  it('shows the plan, card, next payment and invoices, and confirms a change before making it', async () => {
    renderWithProviders(<BillingPage />);
    expect(await screen.findByTestId('billing-current')).toHaveTextContent('Standard');
    expect(screen.getByTestId('billing-current')).toHaveTextContent('visa ending 4242');
    expect(screen.getByTestId('billing-invoices')).toHaveTextContent('WW-0001');
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));
    expect(screen.getByTestId('tier-comparison')).toHaveTextContent('charged now');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/billing/change', { method: 'POST', body: JSON.stringify({ tier_id: 't-pro', billing_cycle: 'monthly' }) }));
  });

  it('warns when the last payment failed, and shows a cancellation and a pending downgrade', async () => {
    serve({ ...base, status: 'past_due', payment_failures: 2, cancel_at_period_end: true, pending_change: { tier_id: 't-x', display_name: 'Standard', billing_cycle: 'monthly', at: '2026-11-27T00:00:00Z' } });
    renderWithProviders(<BillingPage />);
    expect(await screen.findByTestId('billing-past-due')).toHaveTextContent('2 attempts');
    expect(screen.getByTestId('billing-cancelled')).toHaveTextContent('You have access until');
    expect(screen.getByTestId('billing-pending')).toHaveTextContent('Your plan will change to Standard');
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('tells a managed account it is never charged, with no plans to buy', async () => {
    serve({ ...base, managed: true });
    renderWithProviders(<BillingPage />);
    expect(await screen.findByTestId('billing-managed')).toHaveTextContent('never charged');
    expect(screen.queryByTestId('billing-plans')).toBeNull();
  });
});

describe('PurchaseReturn', () => {
  it('says the purchase was cancelled and nothing was charged', () => {
    window.history.pushState({}, '', '/credits?purchase=cancelled');
    renderWithProviders(<PurchaseReturn onCredited={async () => undefined} />);
    expect(screen.getByTestId('purchase-cancelled')).toHaveTextContent('Nothing was charged');
  });
});

describe('BillingRevenue', () => {
  it('shows MRR and subscribers, and offers a retry on a past-due account', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/billing/revenue')) return { data: {
        tier_breakdown: { Standard: 1 }, trial_funnel: { trials_started: 2, active_trials: 1, converted: 1, churned: 0 }, past_due: ['u9'],
        stripe: { mrr_cents: 1999, arr_cents: 23988, customers: 3, customers_more: false, active_subscribers: 1, past_due_subscribers: 1, churn_rate_30d: 0, revenue_by_month_cents: { '2026-10': 1999 } },
      } };
      if (path.startsWith('/api/admin/billing/subscribers')) return { data: [{ user_id: 'u9', tier: 'Standard', payment_status: 'past_due', status: 'past_due', billing_cycle: 'monthly', current_period_end: null, payment_failures: 1, mrr_cents: 1999 }] };
      return { data: [] };
    });
    renderWithProviders(<BillingRevenue isSuperuser />);
    expect(await screen.findByTestId('rev-mrr')).toHaveTextContent('$19.99');
    expect(await screen.findByRole('button', { name: 'Retry payment' })).toBeInTheDocument();
    expect(screen.getByTestId('rev-refund')).toBeInTheDocument();
  });
});
