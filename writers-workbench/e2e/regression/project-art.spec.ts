import { test, expect } from '@playwright/test';
import { seedProject, seedContent, deleteProject, supaGet } from '../pages/api';

/**
 * Per-chapter artwork — RESULT-asserting, data-isolated.
 *
 * The bar (user-flagged): clicking a chapter's "Generate Art" must actually produce an image that lands
 * in the project's Art gallery. Seeds a disposable project + one written chapter, clicks Generate Art on
 * the Chapters tab, then asserts a real generated_images_v2 row exists for the project (image_type
 * chapter_art) AND the Art tab renders a thumbnail (not the "No images yet" empty state). Teardown deletes
 * the project + its images. Verified against ProjectDetail ChaptersTab + hooks/useImageGenerator +
 * server routes/images.ts (generate → poll → save).
 *
 * The generation is a real KIE.AI job (~1 min); the timeout is generous.
 */
let projectId = '';

test.describe('Per-chapter artwork (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Art ${Date.now()}` });
    await seedContent({
      title: 'Chapter 1 — The Array',
      content_type: 'chapter',
      status: 'approved',
      chapter_number: 1,
      project_id: projectId,
      content_text: 'The dish turned toward the dead star as the archivist watched the signal resolve. '.repeat(20),
    });
  });
  test.afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  test('Generate Art on a chapter produces a project-associated image in the gallery', async ({ page }) => {
    test.setTimeout(180_000); // real image generation

    // No images to start.
    const before = await supaGet('generated_images_v2', `project_id=eq.${projectId}&select=id`);
    expect(before.length).toBe(0);

    await page.goto(`/projects/${projectId}?tab=chapters`);
    const genBtn = page.getByRole('button', { name: /Generate Art/i }).first();
    await expect(genBtn, 'Chapters tab must expose a per-chapter Generate Art button').toBeVisible({ timeout: 20_000 });
    await genBtn.click();

    // DB result: a chapter_art image row appears for this project.
    await expect
      .poll(async () => (await supaGet('generated_images_v2', `project_id=eq.${projectId}&select=id,image_type`)).length,
        { timeout: 150_000, message: 'no generated_images_v2 row was created for the chapter' })
      .toBeGreaterThan(0);
    const imgs = await supaGet('generated_images_v2', `project_id=eq.${projectId}&select=id,image_type,storage_path`);
    expect(imgs[0].image_type).toBe('chapter_art');
    expect(String(imgs[0].storage_path).length).toBeGreaterThan(0);

    // UI result: the Art tab shows a real thumbnail, not the empty state.
    await page.goto(`/projects/${projectId}?tab=art`);
    await expect(page.getByText(/No images yet/i)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('main img, img').first()).toBeVisible({ timeout: 20_000 });
  });
});
