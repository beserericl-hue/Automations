import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Credits — RESULT-asserting. Sprint 9: Purchase no longer grants credits on the spot. It sends the
 * user to Stripe Checkout for the chosen amount, and only the Stripe webhook adds credits once the
 * payment clears (the full paid path, test card and all, is sprint9-billing.spec.ts). So here: the
 * balance shown is the API's, Purchase leads to Stripe's checkout page, and the balance has NOT
 * changed just from clicking. Verified against credits/CreditsPage.tsx + server routes/credits.ts.
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
  test('the page shows the real balance; Purchase (if offered) goes to Stripe and grants nothing until paid', async ({ page }) => {
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
    await page.getByRole('button', { name: /Continue to payment/ }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await expect(page.getByText(/Writers Workbench credit/).first()).toBeVisible({ timeout: 30_000 });
    // Nothing is granted until Stripe says the payment cleared.
    expect(await balance()).toBe(before);
  });
});
