import { test, expect } from '@playwright/test';
import { seedProject, seedContent, supaGet, deleteProject } from '../pages/api';

/**
 * ProjectDetail Outline (chapter.plan) + Write/Rewrite (chapter.write) — RESULT-asserting, data-isolated.
 * Real engine jobs (minutes) — generous timeouts. Verified against ProjectDetail OutlineTab/ChaptersTab
 * (CommandDialog → queue) + engine chapter.plan / chapter.write.
 */
test.describe.configure({ mode: 'serial' });

const OUTLINE = {
  premise: 'A lighthouse keeper on a drowned coast receives a signal from a ship that sank a century ago.',
  characters: [{ name: 'Mara', description: 'the keeper' }, { name: 'Elias', description: 'the drowned captain' }],
  themes: ['memory', 'grief'],
  chapters: [{ chapter_number: 1, title: 'The Signal', beat: 'Mara hears the impossible transmission and answers it.' }],
};

test.describe('ProjectDetail Outline + Write (result-asserting)', () => {
  let projectId = '';
  test.beforeAll(async () => { projectId = await seedProject({ title: `E2E Plan ${Date.now()}`, outline: OUTLINE }); });
  test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

  test('Outline button runs chapter.plan → chapter_outline is persisted', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(`/projects/${projectId}?tab=outline`);
    // The per-chapter Outline button — targeted by its title so it isn't confused with the "Outline" TAB
    // button (both are named "Outline").
    const outlineBtn = page.locator('button[title*="chapter outline"]').first();
    await expect(outlineBtn).toBeVisible({ timeout: 20_000 });
    await outlineBtn.click();
    // CommandDialog → send without notes.
    await page.getByRole('button', { name: /Send without notes/i }).click();

    // Result: writing_projects_v2.outline.chapters[0].chapter_outline gains sub-chapter briefs.
    await expect
      .poll(async () => {
        const rows = await supaGet('writing_projects_v2', `id=eq.${projectId}&select=outline`);
        const ch = rows[0]?.outline?.chapters?.[0]?.chapter_outline;
        const briefs = ch?.sub_chapter_briefs ?? ch?.subchapters ?? (Array.isArray(ch) ? ch : null);
        return Array.isArray(briefs) ? briefs.length : (ch ? 1 : 0);
      }, { timeout: 220_000, message: 'chapter.plan never persisted a chapter_outline' })
      .toBeGreaterThan(0);
  });

  test('Write button runs chapter.write → a chapter with real content is persisted', async ({ page }) => {
    test.setTimeout(900_000); // chapter.write is the slowest engine op (sub-chapter loop)
    // Dedicated project with a MINIMAL pre-seeded chapter_outline (1 sub-brief) so the Write button
    // appears immediately and chapter.write does a single sub-chapter pass (fast).
    const wp = await seedProject({
      title: `E2E Write ${Date.now()}`,
      outline: {
        ...OUTLINE,
        chapters: [{
          chapter_number: 1, title: 'The Signal', beat: 'Mara answers the transmission.',
          // The client reads chapter_outline.sub_chapters (matches the engine plan op) → makes the Write button appear.
          chapter_outline: { sub_chapters: [{ number: 1, title: 'The Call',
            brief: 'Mara hears the impossible signal at dusk and answers it; the drowned voice replies.',
            arc_beat: 'inciting incident', characters: ['Mara', 'Elias'] }] },
        }],
      },
    });
    try {
      await page.goto(`/projects/${wp}?tab=outline`);
      const writeBtn = page.locator('button[title*="Write this chapter"], button[title*="Rewrite this chapter"]').first();
      await expect(writeBtn).toBeVisible({ timeout: 20_000 });
      await writeBtn.click();
      await page.getByRole('button', { name: /Send without notes|Write Chapter/i }).first().click();

      await expect
        .poll(async () => {
          const rows = await supaGet('published_content_v2',
            `project_id=eq.${wp}&content_type=eq.chapter&chapter_number=eq.1&select=content_text`);
          return (rows[0]?.content_text ?? '').split(/\s+/).filter(Boolean).length;
        }, { timeout: 880_000, message: 'chapter.write never persisted a chapter with content' })
        .toBeGreaterThan(200);
    } finally {
      await deleteProject(wp);
    }
  });
});
