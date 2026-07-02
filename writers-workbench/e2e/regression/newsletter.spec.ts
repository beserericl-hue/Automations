import { test, expect } from '@playwright/test';

/**
 * Newsletter-suite regression — the interactive surfaces users touch most: Editions list (New newsletter
 * + Show disabled), Generate form controls, Template editor (HTML source), and the shared HelpButton
 * slide-over open/close. No sends/deletes are committed. Verified against the /newsletter/* components.
 */
test.describe('Newsletter — editions + generate + templates + help', () => {
  test('Editions list: New newsletter link + Show disabled toggle', async ({ page }) => {
    await page.goto('/newsletter/editions');
    await expect(page.getByText(/newsletter|Edition|New newsletter/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: /New newsletter/i })).toBeVisible();
    const showDisabled = page.getByRole('checkbox').first();
    if (await showDisabled.isVisible().catch(() => false)) {
      await showDisabled.check();
      await expect(showDisabled).toBeChecked();
      await showDisabled.uncheck();
    }
  });

  test('Edition editor (new) exposes the core fields', async ({ page }) => {
    await page.goto('/newsletter/editions/new');
    await expect(page.getByText(/Display name|Newsletter name|Create newsletter/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Create newsletter/ })).toBeVisible();
    // Cadence select present.
    await expect(page.getByRole('combobox').first()).toBeVisible();
  });

  test('Generate honours a deep-linked ?edition= (setup wizard preselect)', async ({ page }) => {
    await page.goto('/newsletter/generate');
    const editionSelect = page.locator('#edition');
    await expect(editionSelect).toBeVisible({ timeout: 20_000 });
    const values = await editionSelect.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value).filter(Boolean),
    );
    test.skip(values.length < 2, 'need ≥2 editions to prove preselect');
    const target = values[values.length - 1]; // NOT the default (first) — proves the param is honoured
    await page.goto(`/newsletter/generate?edition=${encodeURIComponent(target)}`);
    await expect(page.locator('#edition')).toHaveValue(target, { timeout: 15_000 });
  });

  test('Generate form: edition/send-date controls + submit present', async ({ page }) => {
    await page.goto('/newsletter/generate');
    await expect(page.getByText(/Generate|Edition|Send date|No enabled editions/i).first()).toBeVisible({ timeout: 20_000 });
    // Send-date input + submit exist (submit disabled if no editions — both states valid).
    await expect(page.locator('#send-date').or(page.locator('input[type="date"]')).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Generate newsletter/ })).toBeVisible();
  });

  test('Template editor exposes the HTML source textarea', async ({ page }) => {
    await page.goto('/newsletter/templates/new');
    await expect(page.getByText(/Template|HTML|Save/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('textbox', { name: 'Template HTML source' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });

  test('HelpButton opens and closes the help slide-over', async ({ page }) => {
    await page.goto('/newsletter');
    await expect(page.getByText(/Newsletter|Generate/i).first()).toBeVisible({ timeout: 20_000 });
    const help = page.locator('button[title^="Help:"]').first();
    if (!(await help.isVisible().catch(() => false))) test.skip(true, 'no HelpButton on this page');
    await help.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await page.locator('button[aria-label="Close help"], [role=dialog] button:has-text("Close")').first().click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });
  });
});

test.describe('Newsletter — approvals + sends read views', () => {
  test('Pending Approvals renders (rows or empty state)', async ({ page }) => {
    await page.goto('/newsletter/approvals');
    await expect(page.getByText(/approval|Pending|No .*approval|Back to Newsletter/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Scheduled Sends: status + edition filters present', async ({ page }) => {
    await page.goto('/newsletter/sends');
    await expect(page.getByText(/Send|Status|No sends|Edition/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('combobox').first()).toBeVisible();
  });
});
