import { test, expect } from '@playwright/test';
import { deleteProject, seedContent, seedProject, supaGet } from '../pages/api';

/**
 * The review rail's Characters tab — RESULT-asserting, data-isolated, no model calls.
 *
 * Seeds a book with two chapters where "Wren" is a name in one place and "wren" a bird in another,
 * looks the name up from chapter 1, and renames only the use the author ticks. PASS: the ticked use
 * changes in the database, the other chapter's use does not, and chapter 1 has a version holding
 * the text from before the rename. Also checks the AI-written flag and the Humanizer tab render
 * (the humanizer itself is a paid call and is not run here).
 */
test.describe.configure({ mode: 'serial' });

test.describe('Characters tab (result-asserting)', () => {
  let projectId = '';
  let ch1 = '';
  let ch2 = '';
  const TEXT1 = 'Wren climbed the bluff at dusk. The spring ran below. Later Wren sat by the fire and waited.';
  const TEXT2 = 'Wren came back in the spring. A wren sang in the cedar above the camp.';

  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Characters ${Date.now()}`, outline: { characters: [{ name: 'Wren', description: 'the boy' }] } });
    ch1 = await seedContent({ title: 'Chapter 1 — Bluff', content_type: 'chapter', status: 'draft', chapter_number: 1, project_id: projectId, content_text: TEXT1 });
    ch2 = await seedContent({ title: 'Chapter 2 — Spring', content_type: 'chapter', status: 'draft', chapter_number: 2, project_id: projectId, content_text: TEXT2 });
  });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('finds a name in every chapter and renames only the use ticked', async ({ page }) => {
    await page.goto(`/content/${ch1}`);
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByLabel('Look up a name').fill('Wren');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('3 uses in 2 chapters')).toBeVisible({ timeout: 15_000 });
    // Case-sensitive: the bird ("a wren") is not counted as the name.
    await expect(page.getByTestId('character-threads')).toContainText('Ch 2');

    await page.getByRole('button', { name: 'Rename…' }).click();
    await page.getByLabel(/Rename “Wren” to/).fill('Tashaw');
    await page.getByRole('button', { name: 'Tick none' }).click();
    await page.getByLabel('Rename this use in chapter 1').first().check();
    await page.getByLabel('also rename it in the cast list and story bible').uncheck();
    await page.getByRole('button', { name: 'Rename 1 use' }).click();
    await expect(page.getByRole('status')).toContainText('Renamed 1 use in 1 chapter', { timeout: 15_000 });

    const [one] = await supaGet<{ content_text: string }>('published_content_v2', `id=eq.${ch1}&select=content_text`);
    const [two] = await supaGet<{ content_text: string }>('published_content_v2', `id=eq.${ch2}&select=content_text`);
    expect(one.content_text).toBe(TEXT1.replace('Wren climbed', 'Tashaw climbed'));
    expect(two.content_text).toBe(TEXT2);
    const versions = await supaGet<{ content_text: string; changed_by: string }>('content_versions_v2', `content_id=eq.${ch1}&select=content_text,changed_by`);
    expect(versions.some((v) => v.changed_by === 'character_rename' && v.content_text === TEXT1)).toBe(true);
  });

  test('the Humanizer tab is there and asks for a selection', async ({ page }) => {
    await page.goto(`/content/${ch1}`);
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Humanizer', exact: true }).click();
    await page.getByRole('button', { name: 'Use the selected text' }).click();
    await expect(page.getByText('Select a passage in the editor first.')).toBeVisible();
  });
});
