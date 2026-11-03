import { test, expect, type Page, type Frame } from '@playwright/test';
import { supaGet } from '../pages/api';
import { HAS_DEV_KEYS, balanceOf, cleanupFreshUsers, makeFreshUser, seedChapter, signInPage, userApi, type FreshUser } from '../pages/fresh-user';

/**
 * The Billing page: book plans, top-ups, the saved card and evergreen auto-recharge — Stripe TEST
 * mode against DEV, through Stripe's own hosted pages with Stripe's test cards. Heavy (Pass B).
 *
 * PASS, as one fresh non-admin user:
 *   1. the page lists Half Book (1,000 credits, $99) and Full Book (2,000 credits, $199) with a
 *      quantity, and the top-ups; no card yet;
 *   2. "Save a card" -> Stripe (setup mode) with 4242 -> back on the page the card shows as the default;
 *   3. 3 Full Books in ONE purchase on the saved card -> +6,000 credits (from the webhook) and one
 *      ledger row; a top-up -> +250;
 *   4. auto-recharge on (threshold just under the balance): two priced ops at once drop the balance
 *      below it -> exactly ONE recharge is bought and credited;
 *   5. replace the card with 4000 0000 0000 0341 (attaches, every charge declines) -> the next
 *      crossing's off-session charge fails -> auto-recharge pauses, the banner says so, no retry;
 *   6. replace it with 4000 0027 6000 3184 (3-D Secure on every payment) -> switching auto-recharge
 *      back on charges off-session -> authentication required -> paused again, no credits.
 * The user is deleted at the end.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Fill Stripe's hosted Checkout (payment or setup mode) with a card and submit. */
async function fillStripe(page: Page, card: string): Promise<void> {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  const label = page.locator('#payment-method-label-card');
  await page.locator('#cardNumber, #payment-method-label-card, [role="radio"]').first().waitFor({ timeout: 60_000 });
  if (!(await page.locator('#cardNumber').isVisible().catch(() => false))) {
    if (await label.isVisible().catch(() => false)) {
      const box = await label.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await page.getByRole('radio', { name: /^Card/ }).first().check({ force: true }).catch(() => undefined);
    }
  }
  await page.locator('#cardNumber').fill(card);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Billing E2E');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('21201');
  const link = page.getByRole('checkbox', { name: /Save my information/i });
  if (await link.isVisible().catch(() => false) && await link.isChecked().catch(() => false)) await link.uncheck({ force: true });
  await page.locator('[data-testid="hosted-payment-submit-button"]').click();
}

/** Stripe's test 3-D Secure challenge: press "Complete" inside its nested frames. */
async function complete3ds(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!page.url().includes('checkout.stripe.com')) return;
    for (const f of page.frames() as Frame[]) {
      const btn = f.getByRole('button', { name: /complete/i }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
}

async function saveCard(page: Page, card: string, threeDs = false): Promise<void> {
  await page.getByRole('button', { name: /Save a card|Replace card/ }).click();
  await fillStripe(page, card);
  if (threeDs) await complete3ds(page);
  await page.waitForURL(/\/billing/, { timeout: 120_000 });
  await expect(page.getByTestId('saved-card')).toContainText(`ending ${card.slice(-4)}`, { timeout: 60_000 });
}

async function purchasesOf(userId: string) {
  return supaGet<{ amount: number; metadata: Record<string, unknown>; stripe_payment_intent_id: string }>('credit_transactions',
    `user_id=eq.${encodeURIComponent(userId)}&transaction_type=eq.purchase&select=amount,metadata,stripe_payment_intent_id&order=created_at.asc`);
}

test.describe('Billing page on DEV (Stripe test mode)', () => {
  test.skip(!HAS_DEV_KEYS, 'needs the DEV service and anon keys');
  test.setTimeout(12 * 60_000);

  test('book plans, top-up, saved card, auto-recharge once per crossing, pause on decline and on 3-D Secure', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
    const user: FreshUser = await makeFreshUser('books');
    const { contentId } = await seedChapter(user);
    await signInPage(page, user);

    // 1. the page
    await page.goto('/billing');
    await expect(page.getByTestId('billing-wallet')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pack-half_book')).toContainText('$99.00');
    await expect(page.getByTestId('pack-half_book')).toContainText('1,000 credits');
    await expect(page.getByTestId('pack-full_book')).toContainText('$199.00');
    await expect(page.getByTestId('pack-full_book')).toContainText('2,000 credits');
    await expect(page.getByTestId('no-card')).toBeVisible();

    // 2. save a card (Stripe setup mode)
    await saveCard(page, '4242424242424242');

    // 3. three Full Books in one purchase, then a top-up
    const start = await balanceOf(user.userId);
    await page.getByLabel('Full Book quantity').fill('3');
    await expect(page.getByTestId('total-full_book')).toContainText('6,000 credits, $597.00');
    await page.getByRole('button', { name: 'Buy 3 books' }).click();
    await expect.poll(() => balanceOf(user.userId), { timeout: 60_000 }).toBe(start + 6000);
    let rows = await purchasesOf(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 6000, metadata: expect.objectContaining({ pack: 'full_book', quantity: 3, price_paid_cents: 59700 }) });

    await page.getByTestId('topup-topup_250').click();
    await expect.poll(() => balanceOf(user.userId), { timeout: 60_000 }).toBe(start + 6250);
    await page.reload();
    await expect(page.getByTestId('purchase-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Receipt' }).first()).toHaveAttribute('href', /stripe\.com/);

    // 4. auto-recharge: threshold just under the balance; two priced ops at once cross it
    const b4 = await balanceOf(user.userId);
    const on = await userApi(user, 'PUT', '/api/billing/auto-recharge', { enabled: true, threshold: b4 - 2, pack: 'topup_250', monthly_cap_cents: null });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const passage = 'Behind her the town burned low. Ahead the flats shone white and empty.';
    const [h1, h2] = await Promise.all([
      userApi(user, 'POST', `/api/content/${contentId}/humanize`, { text: passage }),
      userApi(user, 'POST', `/api/content/${contentId}/humanize`, { text: passage }),
    ]);
    expect([h1.status, h2.status]).toEqual([200, 200]);
    const spent = Number(h1.json.data.credits_charged) + Number(h2.json.data.credits_charged);
    expect(spent, 'the humanizer must charge for this test to cross the threshold').toBeGreaterThan(2);
    await expect.poll(async () => (await purchasesOf(user.userId)).filter((r) => r.metadata.source === 'auto_recharge').length, { timeout: 90_000 }).toBe(1);
    await page.waitForTimeout(10_000); // anything that would double-fire has had time to
    expect((await purchasesOf(user.userId)).filter((r) => r.metadata.source === 'auto_recharge')).toHaveLength(1);
    expect(await balanceOf(user.userId)).toBe(b4 - spent + 250);

    // 5. a card that attaches but declines every charge -> paused, banner, no retry
    await page.reload();
    await saveCard(page, '4000000000000341');
    const b5 = await balanceOf(user.userId);
    const cross = await userApi(user, 'PUT', '/api/billing/auto-recharge', { enabled: true, threshold: b5 + 100, pack: 'topup_250', monthly_cap_cents: null });
    expect(cross.status).toBe(200);
    await expect.poll(async () => (await userApi(user, 'GET', '/api/billing/wallet')).json.data.auto_recharge.paused, { timeout: 60_000 }).toBe(true);
    await page.reload();
    await expect(page.getByTestId('auto-recharge-paused')).toContainText(/declined/i, { timeout: 30_000 });
    await userApi(user, 'POST', `/api/content/${contentId}/humanize`, { text: passage }); // another crossing while paused
    await page.waitForTimeout(8_000);
    expect((await purchasesOf(user.userId)).filter((r) => r.metadata.source === 'auto_recharge')).toHaveLength(1);
    const history = (await userApi(user, 'GET', '/api/billing/purchases')).json.data as Array<{ kind: string; status: string }>;
    expect(history.filter((h) => h.kind === 'auto_recharge' && h.status === 'failed')).toHaveLength(1);

    // 6. 3-D Secure card: attaches after the challenge, but an off-session charge needs authentication
    await saveCard(page, '4000002760003184', true);
    const b6 = await balanceOf(user.userId);
    const again = await userApi(user, 'PUT', '/api/billing/auto-recharge', { enabled: true, threshold: b6 + 100, pack: 'topup_250', monthly_cap_cents: null });
    expect(again.status).toBe(200);
    await expect.poll(async () => (await userApi(user, 'GET', '/api/billing/wallet')).json.data.auto_recharge, { timeout: 60_000 })
      .toMatchObject({ paused: true, paused_reason: expect.stringMatching(/authentication/i) });
    expect(await balanceOf(user.userId)).toBe(b6);
    await page.reload();
    await expect(page.getByTestId('auto-recharge-paused')).toContainText(/authentication/i, { timeout: 30_000 });
  });
});

test.afterAll(async () => {
  await cleanupFreshUsers();
});
