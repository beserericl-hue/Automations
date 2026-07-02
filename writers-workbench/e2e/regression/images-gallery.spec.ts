import { test, expect } from '@playwright/test';
import { seedProject, seedImage, deleteProject } from '../pages/api';

/**
 * ImageGallery (Art tab) — RESULT-asserting, data-isolated. Seeds two images of different types for a
 * project and asserts the gallery shows both, then that the Type filter narrows the visible set.
 * Verified against images/ImageGallery.tsx (project + image_type filters). Teardown deletes the project
 * and its images.
 */
let projectId = '';

test.describe('ImageGallery (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Gallery ${Date.now()}` });
    await seedImage(projectId, 'cover_art');
    await seedImage(projectId, 'chapter_art');
  });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('Art tab lists the project images and the Type filter narrows them', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=art`);
    // Both images present (the count label reflects the gallery result set).
    await expect(page.getByText(/2 images/i)).toBeVisible({ timeout: 20_000 });

    // Filter to Cover Art → exactly one image.
    const typeSelect = page.locator('main').getByRole('combobox').first();
    await typeSelect.selectOption({ label: 'Cover Art' });
    await expect(page.getByText(/^\s*1 image\b/i).first()).toBeVisible({ timeout: 15_000 });

    // Filter to Chapter Art → the other one.
    await typeSelect.selectOption({ label: 'Chapter Art' });
    await expect(page.getByText(/^\s*1 image\b/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
