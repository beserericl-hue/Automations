import { test, expect } from '@playwright/test';
import { supaGet, supaDelete } from '../pages/api';

/**
 * Genres CRUD — RESULT-asserting, data-isolated. Create a private genre via the UI form → assert the
 * genre_config_v2 row exists; delete via the UI (hard delete + cascade dialog) → assert the row is gone.
 * Verified against components/genres/{GenreList,GenreForm}.tsx.
 */
// One timestamp so autoSlug(NAME) === SLUG — the create persists the right slug even if the slug field
// is left to auto-fill, and the DB query matches deterministically.
const STAMP = Date.now();
const NAME = `E2E Genre ${STAMP}`;
const SLUG = `e2e-genre-${STAMP}`;

test.describe('Genres CRUD (result-asserting)', () => {
  test.afterAll(async () => {
    await supaDelete('genre_config_v2', `genre_slug=eq.${encodeURIComponent(SLUG)}`);
  });

  test('create writes a genre_config_v2 row; delete removes it', async ({ page }) => {
    await page.goto('/genres');
    await expect(page.getByText(/Genres|Public Genres/i).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '+ New Genre' }).click();
    // Filling the name auto-derives the slug (autoSlug(NAME) === SLUG), so we don't touch the slug field
    // (its "post-apocalyptic" placeholder is shared with the Goodreads ArrayField — ambiguous).
    await page.getByPlaceholder('Post-Apocalyptic Science Fiction').fill(NAME);
    await page.getByPlaceholder(/Stories set after/).fill('A disposable regression genre.');
    await page.getByPlaceholder(/Tone: gritty/).fill('Tone: disposable. For regression tests only.');
    await page.getByRole('button', { name: /Create Genre/ }).click();

    await expect
      .poll(async () => (await supaGet('genre_config_v2', `genre_slug=eq.${encodeURIComponent(SLUG)}&select=id`)).length,
        { timeout: 15_000, message: 'genre was not written to genre_config_v2' })
      .toBe(1);

    // Reload the list so the new private genre is fetched, then delete it via the UI.
    await page.goto('/genres');
    await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(NAME).first().click();
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    await expect(del).toBeVisible({ timeout: 10_000 });
    await del.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect
      .poll(async () => (await supaGet('genre_config_v2', `genre_slug=eq.${encodeURIComponent(SLUG)}&select=id`)).length,
        { timeout: 15_000, message: 'genre row was not deleted' })
      .toBe(0);
  });
});
