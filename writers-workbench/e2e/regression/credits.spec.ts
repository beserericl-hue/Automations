import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Credits — RESULT-asserting. The Purchase flow (Stripe-deferred stub) grants credits; the balance must
 * actually increase. Reads the balance via /api/credits/balance before and after. Verified against
 * credits/CreditsPage.tsx + server routes/credits.ts.
 */
async function balance(): Promise<number> {
  const api = await apiClient();
  const res = await api.get('/api/credits/balance');
  const j = await res.json();
  await api.dispose();
  // Shape: { success, data: { credits_remaining, ... } } or similar — be tolerant.
  return Number(j?.data?.credits_remaining ?? j?.credits_remaining ?? j?.balance ?? NaN);
}

test.describe('Credits (result-asserting)', () => {
  test('the page shows the real balance; Purchase (if offered) increases it', async ({ page }) => {
    const before = await balance();
    expect(before, 'credits balance endpoint must return a number').not.toBeNaN();

    await page.goto('/credits');
    await expect(page.getByText(/Credits|Balance/i).first()).toBeVisible({ timeout: 20_000 });
    // Result: the balance shown on the page equals the API balance.
    await expect(page.getByText(new RegExp(`\\b${before}\\b`)).first()).toBeVisible({ timeout: 15_000 });

    const purchase = page.getByRole('button', { name: 'Purchase', exact: true });
    if (!(await purchase.isVisible().catch(() => false))) {
      // No purchase offered: either the tier has none (comp/free_full), or no payment provider is
      // configured and the server refuses every purchase — in which case the page must say so
      // rather than offer a button that can only fail. Either way the control is genuinely absent.
      await expect(purchase).toHaveCount(0);
      const pricing = await (await apiClient()).get('/api/credits/pricing');
      const p = (await pricing.json())?.data;
      if (p && p.purchases_available === false) {
        await expect(page.getByText(/Credit purchases are not available yet/)).toBeVisible();
      }
      return;
    }
    const preset10 = page.getByRole('button', { name: '10', exact: true });
    if (await preset10.isVisible().catch(() => false)) await preset10.click();
    await purchase.click();
    await expect(page.getByText(/Confirm purchase/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^(Confirm|Processing)/ }).click();
    await expect
      .poll(balance, { timeout: 20_000, message: 'purchase did not increase the credit balance' })
      .toBeGreaterThan(before);
  });
});
