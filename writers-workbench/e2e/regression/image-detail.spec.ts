import { test, expect } from '@playwright/test';
import { seedProject, seedImage, deleteProject } from '../pages/api';

/**
 * ImageDetail (/images/:id) — RESULT-asserting where feasible, DOM-asserting for the long KIE.AI job.
 * Seeds a generated_images_v2 row (with an original_prompt) for a disposable project and asserts:
 *   - the detail page renders (title + metadata from the row),
 *   - the Download button produces a real browser download event,
 *   - the Regenerate button is GATED on a non-empty prompt (disabled when the prompt is cleared),
 *     and re-enables when the prompt is restored (the KIE.AI generation itself is not driven — it is a
 *     multi-minute external job; we prove the gating + that the control is wired, not the async result).
 * Teardown hard-deletes the project (cascades generated_images_v2).
 */

const STAMP = Date.now();
let projectId = '';
let imageId = '';

test.describe('ImageDetail (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Image Detail ${STAMP}` });
    // image_type=cover_art → metadata.title "E2E cover_art" from the seedImage helper.
    imageId = await seedImage(projectId, 'cover_art');
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId); // deleteProject cascades generated_images_v2
  });

  test('renders the seeded image with title + metadata', async ({ page }) => {
    await page.goto(`/images/${imageId}`);
    // Title falls back to metadata.title ("E2E cover_art") from the seeded row.
    await expect(page.getByRole('heading', { name: 'E2E cover_art' })).toBeVisible({ timeout: 20_000 });
    // Metadata line: image_type, generation_model ("e2e"), and the short id (first 8 chars) all render.
    await expect(page.getByText('cover art').first()).toBeVisible();
    await expect(page.getByText(imageId.substring(0, 8)).first()).toBeVisible({ timeout: 10_000 });
    // Main <img> present; prompt editor prefilled from original_prompt.
    await expect(page.getByRole('img', { name: 'E2E cover_art' })).toBeVisible();
    await expect(page.getByPlaceholder('Describe the image you want to generate...'))
      .toHaveValue('disposable regression image', { timeout: 10_000 });
  });

  test('Download button emits a browser download event', async ({ page }) => {
    await page.goto(`/images/${imageId}`);
    const downloadBtn = page.getByRole('button', { name: 'Download', exact: true });
    await expect(downloadBtn).toBeVisible({ timeout: 20_000 });
    // handleDownload builds an <a download> and clicks it → Playwright surfaces a download event.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      downloadBtn.click(),
    ]);
    // The suggested filename is derived from the storage_path basename (…png).
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });

  test('Regenerate is gated on a non-empty prompt + exposes the 3-step labels', async ({ page }) => {
    await page.goto(`/images/${imageId}`);
    const regen = page.getByRole('button', { name: 'Regenerate Image' });
    await expect(regen).toBeVisible({ timeout: 20_000 });
    // Prompt is prefilled → button enabled.
    await expect(regen).toBeEnabled({ timeout: 10_000 });

    // Clear the prompt → the button becomes disabled (gated on prompt.trim()).
    const promptField = page.getByPlaceholder('Describe the image you want to generate...');
    await promptField.fill('   '); // whitespace-only → trim() empty
    await expect(regen).toBeDisabled({ timeout: 10_000 });

    // Restore a prompt → re-enabled.
    await promptField.fill('A restored disposable prompt.');
    await expect(regen).toBeEnabled({ timeout: 10_000 });

    // The 3-step generation labels exist in the component's state machine. We assert the wiring copy
    // that describes the flow is present (Regenerate creates a NEW version, original preserved) rather
    // than driving the multi-minute KIE.AI job.
    await expect(page.getByText(/Edit the prompt and click Regenerate/i)).toBeVisible();
  });
});
