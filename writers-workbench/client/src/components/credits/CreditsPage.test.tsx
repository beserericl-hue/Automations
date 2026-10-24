/**
 * The purchase form, against what the server will actually do. Purchases are refused until a
 * payment provider exists; the form must say so rather than take an order it cannot fill.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PurchaseSection } from './CreditsPage';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);
const REASON = 'Credit purchases are not available yet. Your plan\'s monthly credits still apply, and an administrator can add credits to your account.';

beforeEach(() => mockFetch.mockReset());

describe('buying credits', () => {
  it('explains, and offers no Purchase button, when purchases are not available', async () => {
    mockFetch.mockResolvedValue({ success: true, data: { price_per_credit_cents: 10, tier_display_name: 'Pro', purchases_available: false, unavailable_reason: REASON } } as never);
    renderWithProviders(<PurchaseSection onPurchase={async () => {}} />);
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Purchase' })).not.toBeInTheDocument();
  });

  it('offers the purchase form when they are', async () => {
    mockFetch.mockResolvedValue({ success: true, data: { price_per_credit_cents: 10, tier_display_name: 'Pro', purchases_available: true, unavailable_reason: null } } as never);
    renderWithProviders(<PurchaseSection onPurchase={async () => {}} />);
    expect(await screen.findByRole('button', { name: 'Purchase' })).toBeInTheDocument();
  });
});
