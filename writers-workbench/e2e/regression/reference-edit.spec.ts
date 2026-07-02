import { test, expect } from '@playwright/test';
import {
  seedStoryArc, seedGenre, seedProject, seedBibleEntry,
  supaGet, supaDelete, deleteProject,
} from '../pages/api';

/**
 * EDIT flows for the three reference/CRUD forms — RESULT-asserting, data-isolated. The *-crud specs
 * cover create + delete; these cover the EDIT path that they skip:
 *   - StoryArcForm  (story-arcs/StoryArcForm.tsx)   : expand custom arc → Edit → Update Arc
 *   - GenreForm     (genres/GenreForm.tsx)          : private genre → Edit → Update Genre
 *   - EntryForm     (story-bible/EntryForm.tsx)     : entry → Edit → Update Entry
 * Each seeds a disposable row directly, drives the UI edit, and asserts the DB field actually changed.
 */

test.describe('StoryArc EDIT (result-asserting)', () => {
  const STAMP = Date.now();
  const NAME = `E2E Arc Edit ${STAMP}`;
  const NEW_DESC = `Edited arc description ${STAMP}`;
  let arcId = '';

  test.beforeAll(async () => {
    arcId = await seedStoryArc({ name: NAME, description: 'Original arc description.' });
  });
  test.afterAll(async () => {
    await supaDelete('story_arcs_v2', `id=eq.${arcId}`);
  });

  test('Edit → Update Arc persists the new description to story_arcs_v2', async ({ page }) => {
    await page.goto('/story-arcs');
    // The seeded arc is a custom arc (has user_id) → expand it to reveal Edit/Delete.
    const card = page.getByText(NAME, { exact: true }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click(); // expand
    const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await edit.click();

    // StoryArcForm in edit mode: Description textarea prefilled; change it, then Update Arc.
    const descField = page.getByPlaceholder(/Brief description/);
    await expect(descField).toBeVisible({ timeout: 10_000 });
    await descField.fill(NEW_DESC);
    await page.getByRole('button', { name: 'Update Arc' }).click();

    await expect
      .poll(async () => (await supaGet('story_arcs_v2', `id=eq.${arcId}&select=description`))[0]?.description,
        { timeout: 15_000, message: 'Update Arc did not persist the new description' })
      .toBe(NEW_DESC);
  });
});

test.describe('Genre EDIT (result-asserting)', () => {
  const STAMP = Date.now();
  const NAME = `E2E Genre Edit ${STAMP}`;
  const SLUG = `e2e-genre-edit-${STAMP}`;
  const NEW_DESC = `Edited genre description ${STAMP}`;
  let genreId = '';

  test.beforeAll(async () => {
    genreId = await seedGenre({ genreName: NAME, genreSlug: SLUG, description: 'Original genre description.' });
  });
  test.afterAll(async () => {
    await supaDelete('genre_config_v2', `id=eq.${genreId}`);
  });

  test('Edit → Update Genre persists the new description to genre_config_v2', async ({ page }) => {
    await page.goto('/genres');
    // Private (user-owned) genre renders under "Your Genres" with an Edit button on its card.
    const card = page.getByText(NAME, { exact: true }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    // The card's Edit button lives in the same row; click the first Edit (private genres render first).
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();

    // GenreForm in edit mode. The Description textarea uses the exact placeholder below.
    // (getByPlaceholder is substring/case-insensitive, so anchor on the distinctive text.)
    const descField = page.getByPlaceholder('Stories set after civilization-ending events...');
    await expect(descField).toBeVisible({ timeout: 10_000 });
    await descField.fill(NEW_DESC);
    await page.getByRole('button', { name: 'Update Genre' }).click();

    await expect
      .poll(async () => (await supaGet('genre_config_v2', `id=eq.${genreId}&select=description`))[0]?.description,
        { timeout: 15_000, message: 'Update Genre did not persist the new description' })
      .toBe(NEW_DESC);
  });
});

test.describe('StoryBible entry EDIT (result-asserting)', () => {
  const STAMP = Date.now();
  const NAME = `E2E Bible Edit ${STAMP}`;
  const NEW_DESC = `Edited bible description ${STAMP}`;
  let projectId = '';
  let entryId = '';

  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Bible Edit Proj ${STAMP}` });
    entryId = await seedBibleEntry({ projectId, name: NAME, description: 'Original bible description.' });
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  test('Edit → Update Entry persists the new description to story_bible_v2', async ({ page }) => {
    await page.goto(`/projects/${projectId}/bible`);
    const entryName = page.getByText(NAME, { exact: true }).first();
    await expect(entryName).toBeVisible({ timeout: 20_000 });

    // Each entry row has an Edit button → opens EntryForm with the entry prefilled.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const descField = page.getByPlaceholder(/Detailed description/);
    await expect(descField).toBeVisible({ timeout: 10_000 });
    await descField.fill(NEW_DESC);
    await page.getByRole('button', { name: /^Update Entry$/ }).click();

    await expect
      .poll(async () => (await supaGet('story_bible_v2', `id=eq.${entryId}&select=description`))[0]?.description,
        { timeout: 15_000, message: 'Update Entry did not persist the new description' })
      .toBe(NEW_DESC);
    // UI result: the edited description is shown back on the panel.
    await expect(page.getByText(NEW_DESC).first()).toBeVisible({ timeout: 10_000 });
  });
});
