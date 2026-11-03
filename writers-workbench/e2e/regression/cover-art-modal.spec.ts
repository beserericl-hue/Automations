import { test, expect } from '@playwright/test';
import { RUN_TAG, deleteProject, seedProject, supaGet, supaRemoveObject } from '../pages/api';

/**
 * Cover-art modal FULL data path: from the project's Outline tab, "Generate Cover Art" opens the
 * prompt modal (no wasted tokens on click), submitting the prompt queues a book-cover image job,
 * and the produced image (generated_images_v2, image_type=cover_art, associated with the project)
 * is DISPLAYED as a tile in the Art tab.
 *
 * PASS: exactly the image this run asked for (its own prompt) is created for this run's project AND
 * its tile renders in the Art tab.
 * FAIL: modal doesn't open, no image row materialises, or it isn't displayed.
 *
 * Self-sufficient: it seeds its own project and uses a prompt tagged with this run. It used the shared
 * "The Last Signal" project and a fixed prompt, and its teardown deleted every image with that prompt,
 * so when the writer-e2e service and a manual run overlapped, one run's teardown deleted the other's
 * fresh image and the other failed "cover_art count never rose" (seen 2026-11-03).
 *
 * Real KIE.AI image generation (~30-90s).
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const PROMPT = `E2E ${RUN_TAG}: lone radio scout silhouetted against a rust-red wasteland sky, glowing vacuum tubes`;
const OUTLINE = {
  title: 'E2E Cover',
  premise: 'A radio scout crosses the wasteland following a signal no one else can hear.',
  chapters: [{ chapter_number: 1, title: 'The Signal', beat: 'The scout hears the transmission.' }],
};

test.describe('Cover-art modal (data path)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(4 * 60_000);

  let projectId = '';
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Cover ${RUN_TAG}`, outline: OUTLINE });
  });
  test.afterAll(async () => {
    if (!projectId) return;
    const made = await supaGet<{ storage_path: string; thumbnail_path: string | null }>(
      'generated_images_v2', `project_id=eq.${projectId}&select=storage_path,thumbnail_path`,
    ).catch(() => []);
    for (const img of made) {
      for (const p of [img.storage_path, img.thumbnail_path]) if (p) await supaRemoveObject('cover-images', p);
    }
    await deleteProject(projectId);
  });

  test('Generate Cover Art → modal → submit → cover_art image created and displayed', async ({ page }) => {
    const mine = () => supaGet<{ id: string; image_type: string; original_prompt: string }>(
      'generated_images_v2', `project_id=eq.${projectId}&select=id,image_type,original_prompt`,
    );
    expect(await mine(), 'a freshly seeded project has no images').toEqual([]);

    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: `E2E Cover ${RUN_TAG}` })).toBeVisible({ timeout: 20_000 });
    // Click the Outline tab explicitly (deep-link ?tab= can race the initial render).
    await page.getByRole('button', { name: /^Outline$/ }).first().click();
    // Book Overview is open by default; ensure the cover-art button is present.
    const genBtn = page.getByRole('button', { name: /Generate Cover Art/i }).first();
    if (!(await genBtn.isVisible().catch(() => false))) {
      await page.getByText(/Book Overview/i).first().click().catch(() => {});
    }
    await expect(genBtn).toBeVisible({ timeout: 20_000 });
    await genBtn.click();

    // Modal opens with an editable prompt — the fix that prevents an immediate (token-wasting) generate.
    await expect(page.getByRole('heading', { name: /Generate cover art/i })).toBeVisible({ timeout: 10_000 });
    const promptBox = page.getByPlaceholder(/Describe the cover art/i);
    await expect(promptBox).toBeVisible();
    await promptBox.fill(PROMPT);

    // Submit the modal's Generate.
    await page.getByRole('button', { name: /^Generate$/ }).click();

    // DATA CREATED: exactly one cover_art row for this project, carrying this run's prompt.
    let rows: Awaited<ReturnType<typeof mine>> = [];
    await expect
      .poll(async () => (rows = await mine().catch(() => [])).length,
        { timeout: 3 * 60_000, message: 'cover_art image row was not created after submit' })
      .toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ image_type: 'cover_art', original_prompt: PROMPT });

    // DATA DISPLAYED: the Art tab shows that image's tile (ImageGallery alts a tile with its prompt).
    await page.goto(`/projects/${projectId}?tab=art`, { waitUntil: 'domcontentloaded' });
    const tile = page.locator(`img[alt="${PROMPT.substring(0, 100)}"]`);
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tile.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      { timeout: 20_000, message: 'the cover tile never loaded its image' }).toBe(true);
  });
});
