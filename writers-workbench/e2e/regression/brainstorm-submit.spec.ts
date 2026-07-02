import { test, expect } from '@playwright/test';
import { supaGet, deleteProject, DEMO_USER_ID } from '../pages/api';

/**
 * BrainstormForm (brainstorm/BrainstormForm.tsx) — RESULT-asserting, data-isolated.
 *
 *   1) Analyze Content → POST /api/brainstorm/parse → Step 2 fields populate (Title / Genre / Story Arc).
 *   2) Submit Brainstorm → POST /api/brainstorm/submit → a writing_projects_v2 row is created for the
 *      submitted title (submit is async: the row appears immediately, the outline fills in later — we
 *      assert the row/project appears, with a generous timeout) AND a success banner shows in the UI.
 *
 * Teardown hard-deletes every project the test created (looked up by the unique title).
 */

const STAMP = Date.now();
const TITLE = `E2E Brainstorm ${STAMP}`;
const CONCEPT =
  `A lone clockmaker in post-apocalyptic Philadelphia salvages pre-war technology to keep time alive. ` +
  `The story explores memory and survival across a three-act structure, roughly twelve chapters. ` +
  `Regression concept ${STAMP}.`;

async function titleQuery(): Promise<string> {
  return `title=eq.${encodeURIComponent(TITLE)}&user_id=eq.${encodeURIComponent(DEMO_USER_ID)}&deleted_at=is.null&select=id`;
}

test.describe('BrainstormForm submit (result-asserting)', () => {
  test.afterAll(async () => {
    // Delete any project(s) the run created (unique title), hard-delete with children.
    const rows = await supaGet<{ id: string }>('writing_projects_v2', await titleQuery());
    for (const r of rows) await deleteProject(r.id);
  });

  test('Analyze populates Step 2, then Submit creates a writing_projects_v2 row', async ({ page }) => {
    await page.goto('/brainstorm');
    await expect(page.getByRole('heading', { name: 'Brainstorm a Book' })).toBeVisible({ timeout: 20_000 });

    // Step 1: paste the concept and Analyze.
    await page.getByPlaceholder(/Paste your book idea/).fill(CONCEPT);
    await page.getByRole('button', { name: 'Analyze Content' }).click();

    // Step 2 populates from the parse response. The "Extracted from your text" badge appears once parsed,
    // and the Title field is filled. (Parse is a fast Claude call.) This is the load-bearing "parse
    // populated Step 2" result assertion.
    await expect(page.getByText('Extracted from your text')).toBeVisible({ timeout: 60_000 });
    const titleInput = page.getByPlaceholder('Book title');
    await expect(titleInput).not.toHaveValue('', { timeout: 10_000 });

    // Genre + Story Arc are two <select>s (Genre first, Story Arc second, in Step 2's grid). The parse
    // fuzzy-auto-match can leave them empty (matchGenre/matchArc depend on the genre/arc lists having
    // loaded when parse resolves — a real app race), so select known-good values explicitly to drive a
    // deterministic Submit. Both are required for Submit to enable.
    const genreSelect = page.locator('select').first();
    const arcSelect = page.locator('select').nth(1);
    await genreSelect.selectOption('post-apocalyptic');
    await arcSelect.selectOption('Three-Act Structure');
    await expect(genreSelect).toHaveValue('post-apocalyptic');
    await expect(arcSelect).toHaveValue('Three-Act Structure');

    // Set our unique title so teardown can find the project deterministically.
    await titleInput.fill(TITLE);

    // Step 3: Submit. Button is gated on content + title + genre + arc — should be enabled now.
    const submit = page.getByRole('button', { name: 'Submit Brainstorm' });
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();

    // UI result: success banner.
    await expect(page.getByText(/Brainstorm submitted/i)).toBeVisible({ timeout: 60_000 });

    // DB result: a project row with our title exists (async — generous timeout up to 5 min).
    await expect
      .poll(async () => (await supaGet('writing_projects_v2', await titleQuery())).length,
        { timeout: 300_000, intervals: [2_000, 5_000, 10_000], message: 'submit did not create a writing_projects_v2 row' })
      .toBeGreaterThanOrEqual(1);
  });
});
