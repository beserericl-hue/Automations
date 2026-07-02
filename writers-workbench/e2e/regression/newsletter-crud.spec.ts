import { test, expect } from '@playwright/test';
import { supaGet, hardDeleteEdition, eqUser } from '../pages/api';

/**
 * Newsletter CRUD via the UI — RESULT-asserting, data-isolated. Creates an edition through the
 * EditionEditor form (asserting the newsletter_editions_v2 row + fields), adds a feed via the Feeds
 * editor (asserting newsletter_feed_sources_v2), and Disables/Re-enables it (asserting `enabled`).
 * Teardown hard-deletes the edition + children. Verified against EditionEditor / FeedsList / EditionsList.
 */
const STAMP = Date.now();
const SLUG = `e2e-crud-${STAMP}`;
const DISPLAY = `E2E CRUD ${STAMP}`;

test.describe('Newsletter CRUD (result-asserting)', () => {
  test.afterAll(async () => {
    await hardDeleteEdition(SLUG);
  });

  test('EditionEditor Save creates the edition in the DB', async ({ page }) => {
    await page.goto('/newsletter/editions/new');
    await expect(page.getByText(/New newsletter|Display name/i).first()).toBeVisible({ timeout: 20_000 });

    await page.getByLabel(/Display name/i).fill(DISPLAY);
    await page.getByLabel(/^Slug/i).fill(SLUG);
    await page.getByLabel(/Newsletter name/i).fill('E2E CRUD Weekly');
    await page.getByLabel(/Subheader/i).fill('Disposable CRUD edition');
    await page.getByLabel(/Genre/i).selectOption('post-apocalyptic');
    await page.getByRole('button', { name: /Create newsletter/i }).click();

    // On success it navigates to the setup wizard; assert the row exists in the DB with our fields.
    await expect
      .poll(async () => (await supaGet('newsletter_editions_v2', `id=eq.${SLUG}&${eqUser()}&select=id,display_name,genre`)).length,
        { timeout: 15_000, message: 'EditionEditor Save did not create the newsletter_editions_v2 row' })
      .toBe(1);
    const row = (await supaGet('newsletter_editions_v2', `id=eq.${SLUG}&select=display_name,genre`))[0];
    expect(row.display_name).toBe(DISPLAY);
    expect(row.genre).toBe('post-apocalyptic');
  });

  test('Feeds editor adds a feed row to the DB', async ({ page }) => {
    await page.goto(`/newsletter/editions/${SLUG}/feeds`);
    await expect(page.getByRole('button', { name: 'Add feed' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Add feed' }).click();

    // FeedEditor inline form: Name + URL (+ type/interval/active). Fill Name + a valid URL and Save.
    await page.getByLabel(/^Name/i).fill('E2E Feed');
    await page.getByLabel(/^URL/i).fill('https://example.com/e2e-feed.xml');
    await page.getByRole('button', { name: /^(Add feed|Save)$/ }).last().click();

    await expect
      .poll(async () => (await supaGet('newsletter_feed_sources_v2', `edition_id=eq.${SLUG}&select=id,url`)).length,
        { timeout: 15_000, message: 'feed was not written to newsletter_feed_sources_v2' })
      .toBeGreaterThan(0);
  });

  test('Disable then Re-enable flips enabled in the DB', async ({ page }) => {
    page.on('dialog', (d) => d.accept()); // Disable uses window.confirm
    await page.goto('/newsletter/editions');
    const row = page.locator('tr', { hasText: SLUG }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.getByRole('button', { name: 'Disable' }).click();
    await expect
      .poll(async () => (await supaGet('newsletter_editions_v2', `id=eq.${SLUG}&select=enabled`))[0]?.enabled,
        { timeout: 15_000, message: 'Disable did not set enabled=false' })
      .toBe(false);

    // Re-enable (needs the "Show disabled" view to see the disabled row).
    await page.goto('/newsletter/editions');
    const showDisabled = page.getByLabel('Show disabled');
    await showDisabled.check();
    await expect(showDisabled).toBeChecked();
    const drow = page.locator('tr', { hasText: SLUG }).first();
    await expect(drow).toBeVisible({ timeout: 15_000 });
    await drow.getByRole('button', { name: 'Re-enable' }).click();
    await expect
      .poll(async () => (await supaGet('newsletter_editions_v2', `id=eq.${SLUG}&select=enabled`))[0]?.enabled,
        { timeout: 15_000, message: 'Re-enable did not set enabled=true' })
      .toBe(true);
  });
});
