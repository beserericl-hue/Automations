import { test, expect } from '@playwright/test';
import { seedProject, seedBibleEntry, supaGet, deleteProject } from '../pages/api';

/**
 * Series Bible panel — RESULT-asserting, data-isolated.
 *
 * The engine keeps one story_bible_v2 row per outlined project — entry_type "concept", name "Series
 * Bible", a labelled description (writer_engine.persist_helpers.persist_canon). The project page shows
 * it as its own panel on Overview and on the Story Bible tab, and the generic Story Bible list (and its
 * count) leaves it out so it is not shown twice. The Story Bible editor page keeps it, marked.
 *
 * The seeded row has the exact shape the engine writes; a real one is written by every outline save.
 */
const SYNOPSIS = 'A lighthouse keeper on a drowned coast answers a signal from a ship that sank a century ago.';
const DESC =
  `SYNOPSIS: ${SYNOPSIS}\n` +
  'STORY ARC: The Hero\'s Journey\n' +
  'TARGET CHAPTER COUNT: 2\n' +
  'DRAMATIC QUESTION: Can Mara bring the drowned crew home before the coast takes her too?';

const OUTLINE = {
  title: 'E2E Series Bible',
  premise: SYNOPSIS,
  chapters: [
    { chapter_number: 1, title: 'The Signal', beat: 'Mara hears the transmission.' },
    { chapter_number: 2, title: 'The Answer', beat: 'Mara answers it.' },
    { chapter_number: 3, title: 'The Crossing', beat: 'Mara rows out to the wreck.' },
  ],
};

test.describe('Series Bible panel (result-asserting)', () => {
  let projectId = '';
  let emptyProjectId = '';
  const CHARACTER = `E2E Keeper ${Date.now()}`;

  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Series Bible ${Date.now()}`, outline: OUTLINE });
    await seedBibleEntry({ projectId, name: 'Series Bible', entryType: 'concept', description: DESC });
    await seedBibleEntry({ projectId, name: CHARACTER, entryType: 'character', description: 'The lighthouse keeper.' });
    emptyProjectId = await seedProject({ title: `E2E No Series Bible ${Date.now()}`, outline: OUTLINE });
    await seedBibleEntry({ projectId: emptyProjectId, name: CHARACTER, entryType: 'character', description: 'The keeper.' });
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
    if (emptyProjectId) await deleteProject(emptyProjectId);
  });

  test('the Story Bible tab shows the Series Bible panel with every field, and leaves it out of the list', async ({ page }) => {
    // Seeded: both rows are really there.
    const rows = await supaGet('story_bible_v2', `project_id=eq.${projectId}&deleted_at=is.null&select=name,entry_type`);
    expect(rows.map((r) => r.name).sort()).toEqual([CHARACTER, 'Series Bible'].sort());

    await page.goto(`/projects/${projectId}?tab=bible`);
    const panel = page.getByTestId('series-bible');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('series-bible-synopsis')).toHaveText(SYNOPSIS);
    await expect(page.getByTestId('series-bible-arc')).toHaveText("The Hero's Journey");
    await expect(page.getByTestId('series-bible-chapters')).toHaveText('2');
    await expect(page.getByTestId('series-bible-question')).toHaveText('Can Mara bring the drowned crew home before the coast takes her too?');
    // The outline has 3 chapters, the Series Bible says 2: flagged as behind.
    await expect(page.getByTestId('series-bible-stale')).toContainText('The outline now has 3 chapters');

    // Not duplicated: the only "Series Bible" text on the page is the panel's heading, the generic
    // list shows the character only, and the tab count is 1 (it was 2 with the Series Bible in it).
    await expect(page.getByText(CHARACTER)).toBeVisible();
    await expect(page.getByText('Series Bible', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: /^concept \(/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Story Bible (1)' })).toBeVisible();
  });

  test('Overview shows the panel and counts only the ordinary entries', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=overview`);
    await expect(page.getByTestId('series-bible')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('series-bible-synopsis')).toHaveText(SYNOPSIS);
    const stat = page.getByText('Story Bible Entries', { exact: true }).locator('..');
    await expect(stat.locator('span').nth(1)).toHaveText('1');
  });

  test('a project without one says so', async ({ page }) => {
    await page.goto(`/projects/${emptyProjectId}?tab=bible`);
    await expect(page.getByTestId('series-bible-empty')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('series-bible-empty')).toContainText('none yet');
    await expect(page.getByText(CHARACTER)).toBeVisible();
  });

  test('the Story Bible editor keeps it, marked as engine-managed', async ({ page }) => {
    await page.goto(`/projects/${projectId}/bible`);
    await expect(page.getByTestId('series-bible-mark')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('series-bible-mark')).toHaveText('Series Bible · engine-managed');
  });
});
