import { test, expect } from '@playwright/test';
import { seedProject, supaGet, supaDelete, deleteProject } from '../pages/api';

/**
 * Project-level "Revise outline" — the heavy half: a REAL brainstorm.revise-outline engine job.
 * RESULT-asserting, data-isolated. Runs in Pass B (real model calls, minutes).
 *
 *   Revise → the box shows progress → the engine rewrites the outline and persists it → the prior
 *   outline is snapshotted to outline_versions_v2 → the box reports the result → the Outline tab shows
 *   the new chapter.
 */
const OUTLINE = {
  title: 'The Drowned Light',
  premise: 'A lighthouse keeper on a drowned coast answers a signal from a ship that sank a century ago.',
  themes: ['memory', 'grief'],
  story_arc_name: "The Hero's Journey",
  dramatic_question: 'Can Mara bring the drowned crew home before the coast takes her too?',
  wow_factor: 'The signal is her own voice.',
  characters: [
    { name: 'Mara', role: 'protagonist', description: 'the keeper' },
    { name: 'Elias', role: 'deuteragonist', description: 'the drowned captain' },
  ],
  chapters: [
    { chapter_number: 1, title: 'The Signal', act: 'I', arc_point: 'call', pov_character: 'Mara', beat: 'Mara hears the impossible transmission.' },
    { chapter_number: 2, title: 'The Answer', act: 'II', arc_point: 'crossing', pov_character: 'Mara', beat: 'Mara answers and rows out to the wreck.' },
  ],
};
const NEW_TITLE = 'The Lantern Returns';
const DIRECTIVE =
  `Add exactly one new final chapter titled "${NEW_TITLE}", in which Elias's ship finally reaches the harbor ` +
  'and Mara lights the lamp for the crew. Keep chapters 1 and 2 as they are.';

test.describe('Revise outline (real engine job)', () => {
  let projectId = '';
  const projectTitle = `E2E Revise Run ${Date.now()}`;
  test.beforeAll(async () => {
    projectId = await seedProject({ title: projectTitle, outline: OUTLINE });
  });
  test.afterAll(async () => {
    if (!projectId) return;
    await supaDelete('outline_versions_v2', `project_id=eq.${projectId}`);
    await deleteProject(projectId);
  });

  test('Revise rewrites the outline, snapshots the old one, and the Outline tab shows the new chapter', async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto(`/projects/${projectId}?tab=outline`);
    await page.getByLabel('Outline revision instructions').fill(DIRECTIVE);
    await page.getByTestId('outline-revise-submit').click();

    // Progress: queued or revising, with a running clock; the input is locked while it runs.
    const progress = page.getByTestId('outline-revise-progress');
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress).toContainText(/Queued|Revising the outline/);
    await expect(page.getByLabel('Outline revision instructions')).toBeDisabled();

    // Result in the DB: the outline gained the new chapter, and the prior outline was snapshotted.
    await expect
      .poll(async () => {
        const [row] = await supaGet('writing_projects_v2', `id=eq.${projectId}&select=outline`);
        return (row?.outline?.chapters ?? []).map((c: any) => String(c.title ?? ''));
      }, { timeout: 840_000, intervals: [10_000], message: 'brainstorm.revise-outline never persisted a revised outline' })
      .toContain(NEW_TITLE);
    // The prior outline is snapshotted: by the engine ("pre-revision snapshot") and, on DEV, also by
    // the outline-change trigger ("Auto-snapshot before outline change"). Every snapshot is the OLD one.
    const versions = await supaGet('outline_versions_v2', `project_id=eq.${projectId}&select=version_number,outline,revision_note`);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.map((v: any) => v.revision_note)).toContain('pre-revision snapshot');
    for (const v of versions) expect(v.outline.chapters.map((c: any) => c.title)).toEqual(['The Signal', 'The Answer']);
    const [after] = await supaGet('writing_projects_v2', `id=eq.${projectId}&select=outline,chapter_count`);
    // Title lock: the route sends the PROJECT's title, which the revision keeps.
    expect(after.outline.title).toBe(projectTitle);
    expect(after.outline.chapters.length).toBeGreaterThanOrEqual(3);
    expect(after.chapter_count).toBe(after.outline.chapters.length);

    // Displayed: the box reports it (it polls every 5s), and the Outline tab shows the new chapter and
    // the revision count without a reload.
    await expect(page.getByTestId('outline-revise-result')).toContainText(`Outline revised: 2 → ${after.outline.chapters.length} chapters`, { timeout: 60_000 });
    await expect(page.getByText(NEW_TITLE).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`${versions.length} prior revisions`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Outline revision instructions')).toBeEnabled();
  });
});
