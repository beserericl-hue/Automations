import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Cover-art on CONTENT (blog post / short story / chapter) FULL data path: ContentDetail now offers
 * "Generate Cover Art" (not just Choose from Gallery). Click → prompt modal → submit → image pipeline
 * (generated_images_v2, image_type=cover_art) → the new image is set as this content's cover and
 * DISPLAYED in the cover banner.
 *
 * PASS: a cover_art image is created after submit AND the content's cover_image_path is set AND the
 *       cover <img> renders.
 * FAIL: no Generate button, modal doesn't open, no image row, or the cover never displays.
 *
 * HEAVY (KIE.AI image generation) — Pass B (workers=1). Uses a standalone blog post.
 */
const CONTENT_ID = 'd88c15e9-6b7a-44b8-8e8d-b25bc4ddfb86'; // standalone blog post (project_id null → user-scoped)
const USER = '%2B14105914612';
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const SUPA = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/+$/, '');
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY || '';

test.describe('Cover-art on content (data path)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(4 * 60_000);

  test.beforeAll(async () => {
    // Ensure the "no cover" state so the Generate button is the primary action.
    await fetch(`${SUPA}/rest/v1/published_content_v2?id=eq.${CONTENT_ID}`, {
      method: 'PATCH',
      headers: { apikey: SVC, authorization: `Bearer ${SVC}`, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ cover_image_path: null }),
    }).catch(() => {});
  });

  test('Generate Cover Art → modal → submit → cover_art image created and displayed as cover', async ({ page }) => {
    const startIso = new Date(Date.now() - 5000).toISOString();

    await page.goto(`/content/${CONTENT_ID}`, { waitUntil: 'domcontentloaded' });
    // The cover banner shows "No cover image" + a Generate Cover Art button.
    const genBtn = page.getByRole('button', { name: /Generate Cover Art/i }).first();
    await expect(genBtn).toBeVisible({ timeout: 20_000 });
    await genBtn.click();

    // Prompt modal opens (editable), NOT an immediate generate.
    await expect(page.getByRole('heading', { name: /Generate cover art/i })).toBeVisible({ timeout: 10_000 });
    const promptBox = page.getByPlaceholder(/Describe the cover art/i);
    await expect(promptBox).toBeVisible();
    await promptBox.fill('Editorial cover: an ancient Egyptian workers village at golden hour, mud-brick houses, high detail, no text');
    await page.getByRole('button', { name: /^Generate$/ }).click();

    // DATA CREATED: a new cover_art image for this user.
    await expect
      .poll(async () => (await supaGet<{ id: string }>(
        'generated_images_v2',
        `user_id=eq.${USER}&image_type=eq.cover_art&created_at=gte.${encodeURIComponent(startIso)}&select=id`,
      ).catch(() => [])).length, { timeout: 3 * 60_000, message: 'cover_art image was not created after submit' })
      .toBeGreaterThan(0);

    // DATA DISPLAYED: the content's cover_image_path is set and the banner <img> renders.
    await expect
      .poll(async () => (await supaGet<{ cover_image_path: string | null }>(
        'published_content_v2', `id=eq.${CONTENT_ID}&select=cover_image_path`,
      ).catch(() => []))[0]?.cover_image_path, { timeout: 30_000, message: 'cover_image_path was not set on the content' })
      .toBeTruthy();

    await expect(page.locator('img[alt^="Cover for"]')).toBeVisible({ timeout: 20_000 });
  });
});
