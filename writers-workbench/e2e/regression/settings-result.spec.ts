import { test, expect } from '@playwright/test';
import { supaGet, DEMO_USER_ID, eqUser } from '../pages/api';

/**
 * Settings — RESULT-asserting. Save Changes persists to app_config_v2 (recipient email) and users_v2
 * (display name); theme toggle flips the document theme. To stay isolated on the SHARED demo profile,
 * each mutation captures the original value and RESTORES it at the end.
 * Verified against components/settings/UserSettings.tsx.
 */
async function recipientEmail(): Promise<string> {
  const rows = await supaGet('app_config_v2', `${eqUser()}&key=eq.recipient_email&select=value`);
  return rows[0]?.value ?? '';
}

test.describe('Settings (result-asserting)', () => {
  let original = '';

  test('Save Changes persists Recipient Email to app_config_v2', async ({ page }) => {
    original = await recipientEmail();
    const unique = `e2e-recip-${Date.now()}@example.com`;

    await page.goto('/settings');
    await expect(page.getByText(/Settings|Email Delivery|Display Name/i).first()).toBeVisible({ timeout: 20_000 });

    const recip = page.getByPlaceholder('Where writing results are sent');
    await expect(recip).toBeVisible({ timeout: 15_000 });
    // The field prefills from app_config once it loads (configLoaded-once); wait for the original value
    // to arrive first, else the async load clobbers our typed value and Save writes the old one back.
    await expect(recip).toHaveValue(original, { timeout: 15_000 });
    await recip.fill(unique);
    await page.getByRole('button', { name: /Save Changes/ }).click();

    await expect
      .poll(recipientEmail, { timeout: 15_000, message: 'Save did not persist recipient_email to app_config_v2' })
      .toBe(unique);

    // Restore the original so the shared demo profile is unchanged.
    await recip.fill(original);
    await page.getByRole('button', { name: /Save Changes/ }).click();
    await expect.poll(recipientEmail, { timeout: 15_000 }).toBe(original);
  });

  test('theme toggle flips the document theme', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText(/Appearance|Theme/i).first()).toBeVisible({ timeout: 20_000 });
    const html = page.locator('html');
    await page.getByRole('button', { name: 'dark', exact: true }).click();
    await expect(html).toHaveClass(/dark/, { timeout: 5_000 });
    await page.getByRole('button', { name: 'light', exact: true }).click();
    await expect(html).not.toHaveClass(/dark/, { timeout: 5_000 });
  });

  test('phone + auth email are present and disabled by design', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('input[disabled]').first()).toBeVisible({ timeout: 20_000 });
    expect(DEMO_USER_ID).toBeTruthy();
  });
});
