import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import BillingWallet, { packTotal, type Wallet } from './BillingWallet';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));

const PACKS: Wallet['packs'] = [
  { name: 'half_book', kind: 'book', display_name: 'Half Book', description: null, credits: 1000, price_cents: 9900 },
  { name: 'full_book', kind: 'book', display_name: 'Full Book', description: null, credits: 2000, price_cents: 19900 },
  { name: 'topup_250', kind: 'topup', display_name: 'Top-up 250', description: null, credits: 250, price_cents: 2900 },
];
const wallet = (over: Partial<Wallet> = {}): Wallet => ({
  payments_ready: true, managed: false, packs: PACKS, has_customer: true,
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 },
  auto_recharge: { enabled: false, threshold: 100, pack: 'topup_250', monthly_cap_cents: null, paused: false, paused_reason: null, paused_at: null, in_flight: false, last_event: null, last_event_at: null },
  ...over,
});

function serve(w: Wallet) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/billing/wallet') return { data: w };
    if (path === '/api/billing/purchases') return { data: [{ id: 'pi_1', date: '2026-11-03T00:00:00Z', kind: 'book', pack: 'full_book', quantity: 3, credits: 6000, amount_cents: 59700, status: 'paid', credited: true, receipt_url: 'https://pay.stripe.test/r', failure: null }] };
    if (path === '/api/billing/purchase') return { data: { status: 'succeeded', credits: 6000 } };
    return { data: {} };
  });
}

beforeEach(() => {
  serve(wallet());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('BillingWallet', () => {
  it('prices N books per unit', () => {
    expect(packTotal(PACKS[1], 3)).toEqual({ credits: 6000, cents: 59700 });
  });

  it('shows the card from Stripe, book plans with a quantity, top-ups and the history with receipts', async () => {
    renderWithProviders(<BillingWallet />);
    expect(await screen.findByTestId('saved-card')).toHaveTextContent('VISA ending 4242');
    fireEvent.change(screen.getByLabelText('Full Book quantity'), { target: { value: '3' } });
    expect(screen.getByTestId('total-full_book')).toHaveTextContent('6,000 credits, $597.00');
    fireEvent.click(screen.getByRole('button', { name: 'Buy 3 books' }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/billing/purchase', { method: 'POST', body: JSON.stringify({ pack: 'full_book', quantity: 3 }) }));
    expect(await screen.findByTestId('wallet-notice')).toHaveTextContent('6,000 credits');
    expect(screen.getByTestId('topup-topup_250')).toHaveTextContent('250 credits · $29.00');
    expect(await screen.findByRole('link', { name: 'Receipt' })).toHaveAttribute('href', 'https://pay.stripe.test/r');
  });

  it('shows the paused banner with the reason', async () => {
    serve(wallet({ auto_recharge: { ...wallet().auto_recharge, enabled: true, paused: true, paused_reason: 'The card was declined (insufficient_funds)' } }));
    renderWithProviders(<BillingWallet />);
    expect(await screen.findByTestId('auto-recharge-paused')).toHaveTextContent('insufficient_funds');
  });

  it('validates and saves auto-recharge', async () => {
    renderWithProviders(<BillingWallet />);
    fireEvent.click(await screen.findByLabelText('Auto-recharge on'));
    fireEvent.change(screen.getByLabelText('Threshold credits'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('Monthly cap dollars'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save auto-recharge' }));
    expect(await screen.findByTestId('wallet-error')).toHaveTextContent('at least $1');
    fireEvent.change(screen.getByLabelText('Monthly cap dollars'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save auto-recharge' }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/billing/auto-recharge', {
      method: 'PUT', body: JSON.stringify({ enabled: true, threshold: 150, pack: 'topup_250', monthly_cap_cents: 20000 }),
    }));
  });

  it('renders nothing for a managed account', async () => {
    serve(wallet({ managed: true }));
    const { container } = renderWithProviders(<BillingWallet />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="billing-wallet"]')).toBeNull();
  });
});
