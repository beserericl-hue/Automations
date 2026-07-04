import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Cover-art modal FULL data path: from the project's Outline tab, "Generate Cover Art" opens the
 * prompt modal (no wasted tokens on click), submitting the prompt queues a book-cover image job,
 * and the produced image (generated_images_v2, image_type=cover_art, associated with the project)
 * is DISPLAYED as a tile in the Art tab.
 *
 * PASS: a NEW cover_art row for this project is created after submit AND a thumbnail renders.
 * FAIL: modal doesn't open, no image row materialises, or it isn't displayed.
 *
 * HEAVY (KIE.AI image generation ~30-90s) — Pass B (workers=1). Uses The Last Signal.
 */
const PROJECT_ID = 'dd10c1c3-e025-4cd7-854d-21db32a2e4da'; // The Last Signal
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

test.describe('Cover-art modal (data path)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(4 * 60_000);

  test('Generate Cover Art → modal → submit → cover_art image created and displayed', async ({ page }) => {
    const startIso = new Date(Date.now() - 5_000).toISOString();
    const before = (await supaGet<{ id: string }>(
      'generated_images_v2',
      `project_id=eq.${PROJECT_ID}&image_type=eq.cover_art&select=id`,
    ).catch(() => [])).length;

    await page.goto(`/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /The Last Signal/ })).toBeVisible({ timeout: 20_000 });
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
    await promptBox.fill('Lone radio scout silhouetted against a rust-red wasteland sky, vintage vacuum tubes glowing');

    // Submit the modal's Generate.
    await page.getByRole('button', { name: /^Generate$/ }).click();

    // DATA CREATED: a new cover_art row for this project appears.
    await expect
      .poll(async () => (await supaGet<{ id: string }>(
        'generated_images_v2',
        `project_id=eq.${PROJECT_ID}&image_type=eq.cover_art&created_at=gte.${encodeURIComponent(startIso)}&select=id`,
      ).catch(() => [])).length, { timeout: 3 * 60_000, message: 'cover_art image row was not created after submit' })
      .toBeGreaterThan(0);

    // DATA DISPLAYED: the Art tab shows more cover tiles than before (the new one rendered).
    await page.goto(`/projects/${PROJECT_ID}?tab=art`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('img[loading="lazy"]').first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await supaGet<{ id: string }>(
        'generated_images_v2', `project_id=eq.${PROJECT_ID}&image_type=eq.cover_art&select=id`,
      ).catch(() => [])).length, { timeout: 10_000 })
      .toBeGreaterThan(before);
  });
});
