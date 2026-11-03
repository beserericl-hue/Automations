import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Credits — RESULT-asserting. The page shows the API's balance, and buying credits now lives on the
 * Billing page (book plans, top-ups, the saved card, auto-recharge — 2026-11-03): the Credits page
 * links there instead of offering its own per-credit purchase. Paying for real (Stripe test cards,
 * webhook grants) is book-plans-billing.spec.ts and sprint9-billing.spec.ts.
 */
async function balance(): Promise<number> {
  const api = await apiClient();
  const res = await api.get('/api/credits/balance');
  const j = await res.json();
  await api.dispose();
  return Number(j?.data?.credits_remaining ?? j?.credits_remaining ?? j?.balance ?? NaN);
}

test.describe('Credits (result-asserting)', () => {
  test('the page shows the real balance and sends buyers to the Billing page', async ({ page }) => {
    const before = await balance();
    expect(before, 'credits balance endpoint must return a number').not.toBeNaN();

    await page.goto('/credits');
    await expect(page.getByText(/Credits|Balance/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(new RegExp(`\\b${before}\\b`)).first()).toBeVisible({ timeout: 15_000 });

    const buy = page.getByRole('link', { name: 'Buy books or credits' });
    await expect(buy).toBeVisible();
    await expect(page.getByTestId('credits-buy-link')).toContainText('Full Book: 2,000 credits for $199');
    await buy.click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible({ timeout: 20_000 });
    // Nothing is granted by looking.
    expect(await balance()).toBe(before);
  });

  test('the book plans are on sale at the decided prices', async () => {
    const api = await apiClient();
    const packs = (await (await api.get('/api/credits/packs')).json()).data.packs as Array<{ name: string; credits: number; price_cents: number }>;
    await api.dispose();
    expect(packs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'half_book', credits: 1000, price_cents: 9900 }),
      expect.objectContaining({ name: 'full_book', credits: 2000, price_cents: 19900 }),
    ]));
  });
});
