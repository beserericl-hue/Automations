import { test, expect } from '@playwright/test';
import {
  apiClient, supaGet, hardDeleteEdition, eqUser, seedFeed,
} from '../pages/api';

test.describe.configure({ mode: 'serial' });

/**
 * FeedsList per-row actions — RESULT-asserting, data-isolated. (Add-feed is covered by
 * newsletter-crud.spec.ts; this spec covers the remaining row actions.)
 *
 *   - Pause/Resume → PUT active toggle → newsletter_feed_sources_v2.active flips in the DB.
 *   - FeedEditor Edit → Save → the row's name/url/interval update in the DB.
 *   - Delete → confirm() → DELETE → row gone from the DB.
 *   - HelpButton open/close.
 *
 * A throwaway edition hosts the feeds; teardown hard-deletes it + children.
 */
let editionId = '';
const STAMP = Date.now();

test.describe('Newsletter Feeds (result-asserting)', () => {
  test.beforeAll(async () => {
    editionId = `e2e-feeds-${STAMP}`;
    const api = await apiClient();
    const res = await api.post('/api/newsletter/editions', {
      data: {
        id: editionId,
        display_name: `E2E Feeds ${STAMP}`,
        newsletter_name: 'E2E Feeds Weekly',
        subheader: 'Disposable feeds edition',
        genre: 'post-apocalyptic',
        description: 'Created by newsletter-feeds.spec.ts',
        primary_color: '#111111',
        paper_color: '#ffffff',
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    await api.dispose();
    const rows = await supaGet('newsletter_editions_v2', `id=eq.${editionId}&${eqUser()}&select=id`);
    expect(rows.length).toBe(1);
  });

  test.afterAll(async () => {
    if (editionId) await hardDeleteEdition(editionId);
  });

  test('Pause then Resume flips active in the DB', async ({ page }) => {
    const feedId = await seedFeed({ edition_id: editionId, name: `E2E Toggle ${STAMP}`, active: true });

    await page.goto(`/newsletter/editions/${editionId}/feeds`);
    const row = page.locator('tr', { hasText: `E2E Toggle ${STAMP}` }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Pause → active=false.
    await row.getByRole('button', { name: /^Pause$/ }).click();
    await expect
      .poll(async () => (await supaGet('newsletter_feed_sources_v2', `id=eq.${feedId}&select=active`))[0]?.active,
        { timeout: 15_000, message: 'Pause did not set active=false' })
      .toBe(false);
    // UI reflects paused.
    await expect(row.getByText(/^paused$/i)).toBeVisible({ timeout: 10_000 });

    // Resume → active=true.
    await row.getByRole('button', { name: /^Resume$/ }).click();
    await expect
      .poll(async () => (await supaGet('newsletter_feed_sources_v2', `id=eq.${feedId}&select=active`))[0]?.active,
        { timeout: 15_000, message: 'Resume did not set active=true' })
      .toBe(true);
  });

  test('FeedEditor Edit existing feed → Save updates the row in the DB', async ({ page }) => {
    const feedId = await seedFeed({
      edition_id: editionId, name: `E2E EditFeed ${STAMP}`,
      url: 'https://example.com/original.xml', active: true,
    });

    await page.goto(`/newsletter/editions/${editionId}/feeds`);
    const row = page.locator('tr', { hasText: `E2E EditFeed ${STAMP}` }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /^Edit$/ }).click();

    // Inline FeedEditor pre-filled with the feed; change name + url + interval.
    const editor = page.locator('form', { hasText: 'Edit feed' });
    await expect(editor.getByRole('heading', { name: /Edit feed/i })).toBeVisible({ timeout: 10_000 });
    const newName = `E2E EditedFeed ${STAMP}`;
    await editor.getByLabel(/^Name$/i).fill(newName);
    await editor.getByLabel(/^URL$/i).fill('https://example.com/updated.xml');
    await editor.getByLabel(/Fetch interval/i).fill('120');
    await editor.getByRole('button', { name: /^Save$/ }).click();

    // DB result.
    await expect
      .poll(async () => (await supaGet('newsletter_feed_sources_v2', `id=eq.${feedId}&select=name`))[0]?.name,
        { timeout: 15_000, message: 'Edit Save did not update the feed name' })
      .toBe(newName);
    const dbRow = (await supaGet('newsletter_feed_sources_v2',
      `id=eq.${feedId}&select=name,url,fetch_interval_minutes`))[0];
    expect(dbRow.url).toBe('https://example.com/updated.xml');
    expect(dbRow.fetch_interval_minutes).toBe(120);
  });

  test('Delete removes the feed row from the DB', async ({ page }) => {
    const feedId = await seedFeed({ edition_id: editionId, name: `E2E DeleteFeed ${STAMP}`, active: true });
    page.on('dialog', (d) => d.accept()); // Delete uses window.confirm

    await page.goto(`/newsletter/editions/${editionId}/feeds`);
    const row = page.locator('tr', { hasText: `E2E DeleteFeed ${STAMP}` }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /^Delete$/ }).click();

    await expect
      .poll(async () => (await supaGet('newsletter_feed_sources_v2', `id=eq.${feedId}&select=id`)).length,
        { timeout: 15_000, message: 'Delete did not remove the feed row from the DB' })
      .toBe(0);
  });

  test('FeedsList: HelpButton opens and closes', async ({ page }) => {
    await page.goto(`/newsletter/editions/${editionId}/feeds`);
    // HelpButton renders "?" text with title="Help: Feeds"; target the title attribute (the
    // accessible name is "?", not the title, so getByRole name-match won't hit it).
    const help = page.locator('button[title="Help: Feeds"]');
    await expect(help).toBeVisible({ timeout: 20_000 });
    await help.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await dialog.getByRole('button', { name: /^Close$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });
  });
});
