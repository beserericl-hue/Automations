import { test, expect } from '@playwright/test';
import { apiClient, seedProject, supaGet, deleteProject, RUN_TAG } from '../pages/api';

/**
 * Outline schema on write (item 7) — RESULT-asserting, data-isolated. Every outline write goes
 * through one schema: a legacy n8n-shaped outline (number + brief) is normalised to the canonical
 * shape (chapter_number + beat) when it is next written, and an outline the schema does not know is
 * refused with the problem named — the database row is left exactly as it was.
 */
const N8N_SHAPED = {
  title: 'E2E legacy',
  premise: 'old premise',
  themes: ['memory'],
  characters: [{ name: 'Ada' }],
  chapters: [
    { number: 1, title: 'First Light', brief: 'Ada wakes.', arc_notes: 'setup', research_topics: [] },
    { number: 2, title: 'Second Wind', brief: 'Ada runs.', arc_notes: 'rising', research_topics: [] },
  ],
};

async function outlineOf(id: string): Promise<any> {
  return (await supaGet('writing_projects_v2', `id=eq.${id}&select=outline`))[0]?.outline;
}

test.describe('Outline schema on write (result-asserting)', () => {
  let projectId = '';
  test.afterEach(async () => {
    if (projectId) await deleteProject(projectId);
    projectId = '';
  });

  test('an edit to a legacy-shaped project writes the outline back in the canonical shape', async () => {
    projectId = await seedProject({ title: `E2E Outline Legacy ${RUN_TAG}`, outline: N8N_SHAPED });
    const api = await apiClient();
    const r = await api.patch(`/api/publishing/project/${projectId}/details`, { data: { premise: 'new premise' } });
    expect(r.status(), await r.text()).toBe(200);
    await api.dispose();

    const saved = await outlineOf(projectId);
    expect(saved.premise).toBe('new premise');
    expect(saved.chapters).toEqual([
      { chapter_number: 1, title: 'First Light', beat: 'Ada wakes.', arc_notes: 'setup', research_topics: [] },
      { chapter_number: 2, title: 'Second Wind', beat: 'Ada runs.', arc_notes: 'rising', research_topics: [] },
    ]);
  });

  test('an outline the schema does not know is refused with the problem named, and nothing is written', async () => {
    const bad = { premise: 'p', logline: 'not a field', chapters: [{ title: 'no number' }] };
    projectId = await seedProject({ title: `E2E Outline Bad ${RUN_TAG}`, outline: bad });
    const api = await apiClient();
    const r = await api.patch(`/api/publishing/project/${projectId}/details`, { data: { premise: 'changed' } });
    expect(r.status()).toBe(422);
    const body = await r.json();
    expect(body.error.code).toBe('INVALID_OUTLINE');
    expect(body.error.problems.join(' | ')).toContain("unknown top-level key 'logline'");
    expect(body.error.problems.join(' | ')).toContain('chapters[0] has no chapter number');
    await api.dispose();
    expect(await outlineOf(projectId)).toEqual(bad);
  });

  test('the Edit Project form saves premise and themes through the schema, and the Outline tab still reads it', async ({ page }) => {
    projectId = await seedProject({ title: `E2E Outline UI ${RUN_TAG}`, outline: N8N_SHAPED });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByPlaceholder("The book's premise — who, what, where, why").fill('premise from the form');
    await page.getByPlaceholder(/Comma-separated themes/).fill('loss, hope');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect
      .poll(async () => (await outlineOf(projectId))?.premise, { timeout: 15_000 })
      .toBe('premise from the form');
    const saved = await outlineOf(projectId);
    expect(saved.themes).toEqual(['loss', 'hope']);
    expect(saved.chapters.map((c: any) => [c.chapter_number, c.beat])).toEqual([[1, 'Ada wakes.'], [2, 'Ada runs.']]);
    expect(saved.chapters.some((c: any) => 'number' in c || 'brief' in c)).toBe(false);

    // The canonical shape renders: both chapters, with their beats, on the Outline tab.
    await page.goto(`/projects/${projectId}?tab=outline`);
    await expect(page.getByText('First Light').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Second Wind').first()).toBeVisible();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(page.getByText('Ada wakes.').first()).toBeVisible({ timeout: 10_000 });
  });
});
