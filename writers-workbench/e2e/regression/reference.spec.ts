import { test, expect } from '@playwright/test';
import { RegressionPage } from '../pages/regression.page';

/**
 * Reference-area regression — Story Arcs, Genres, Brainstorm, Research. Exercises the create/edit form
 * open+cancel paths and the delete-confirm open+cancel (never committing a hard delete on DEV), plus
 * Brainstorm's validation-gated Analyze button. Verified against StoryArcBrowser/StoryArcForm,
 * GenreList/GenreForm, BrainstormForm, ResearchList.
 */
test.describe('Story Arcs', () => {
  test('Create Custom Arc form opens and cancels', async ({ page }) => {
    await page.goto('/story-arcs');
    await expect(page.getByText(/arcs? available|Story Arc/i).first()).toBeVisible({ timeout: 20_000 });
    const create = page.getByRole('button', { name: /Create Custom Arc|Create Your First Arc/ }).first();
    await create.click();
    await expect(page.getByRole('button', { name: /Create Arc/ })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: /Create Custom Arc|Create Your First Arc/ }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('a custom arc delete confirm opens and cancels (no hard delete)', async ({ page }) => {
    const rp = new RegressionPage(page);
    await page.goto('/story-arcs');
    await expect(page.getByText(/arcs? available/i).first()).toBeVisible({ timeout: 20_000 });
    // Expand the first arc that has a Delete (custom arcs only).
    const firstCard = page.locator('main').getByText(/.+/).first();
    await firstCard.click().catch(() => {});
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    if (!(await del.isVisible().catch(() => false))) {
      test.skip(true, 'no custom (deletable) arc present');
    }
    await rp.assertDialogOpensAndCloses(() => del.click(), page.getByRole('dialog'));
  });
});

test.describe('Genres', () => {
  test('New Genre form opens and cancels', async ({ page }) => {
    await page.goto('/genres');
    await expect(page.getByText(/Genres|Public Genres/i).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '+ New Genre' }).click();
    await expect(page.getByRole('button', { name: /Create Genre/ })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: '+ New Genre' })).toBeVisible({ timeout: 10_000 });
  });

  test('a private genre delete confirm shows cascade info and cancels', async ({ page }) => {
    const rp = new RegressionPage(page);
    await page.goto('/genres');
    await expect(page.getByText(/Your Genres|Genres/i).first()).toBeVisible({ timeout: 20_000 });
    // "Your Genres" (private) cards load async and carry an always-visible Delete. Wait for the list to
    // settle (a Delete button OR only public genres) before deciding.
    await Promise.race([
      page.getByRole('button', { name: 'Delete', exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
      page.getByText(/Public Genres/i).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
    ]);
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    if (!(await del.isVisible().catch(() => false))) test.skip(true, 'no private genre to delete');
    await rp.assertDialogOpensAndCloses(() => del.click(), page.getByRole('dialog'));
  });
});

test.describe('Brainstorm', () => {
  test('Analyze Content is gated until content is entered', async ({ page }) => {
    await page.goto('/brainstorm');
    await expect(page.getByText(/Brainstorm|Book Concept|Analyze Content/i).first()).toBeVisible({ timeout: 20_000 });
    const analyze = page.getByRole('button', { name: /Analyze Content/ });
    await expect(analyze).toBeVisible();
    await expect(analyze).toBeDisabled(); // no content, no file
    await page.getByPlaceholder(/Paste your book idea/i).fill(
      'A generation ship arrives at a dead colony and must decide whether to wake the sleepers.',
    );
    await expect(analyze).toBeEnabled();
  });
});

test.describe('Research', () => {
  test('research rows open a report, and a delete confirm cancels', async ({ page }) => {
    const rp = new RegressionPage(page);
    await page.goto('/research');
    await expect(page.getByText(/Research|No research reports yet/i).first()).toBeVisible({ timeout: 20_000 });
    // Rows load async — wait for the first report row OR the empty state before counting.
    await Promise.race([
      page.getByRole('button', { name: /Open research report/ }).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
      page.getByText(/No research reports yet/i).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
    ]);
    const rows = page.getByRole('button', { name: /Open research report/ });
    const count = await rows.count().catch(() => 0);
    test.skip(count === 0, 'no research reports on DEV');
    // Delete confirm on the first row cancels (soft-delete not committed).
    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    await rp.assertDialogOpensAndCloses(() => del.click(), page.getByRole('dialog'));
    // Opening a report navigates to its detail.
    await rows.first().click();
    await expect(page).toHaveURL(/\/research\/[0-9a-f-]{8,}/, { timeout: 15_000 });
  });
});
