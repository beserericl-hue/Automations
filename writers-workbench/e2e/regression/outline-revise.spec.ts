import { test, expect } from '@playwright/test';
import { apiClient, seedProject, supaGet, supaDelete, deleteProject } from '../pages/api';

/**
 * Project-level "Revise outline" box — the light half (no engine job). RESULT-asserting, data-isolated.
 *
 * The box sits on the Outline tab of a project that has an outline. Revise is disabled until the
 * author types a directive. The route refuses — and charges nothing, queues nothing — for an empty
 * directive, a project with no outline, and a project that is not the user's.
 * The real revision (engine job → new outline + outline_versions_v2 snapshot → displayed) is in
 * outline-revise-run.spec.ts, which runs in the heavy pass.
 */
const OUTLINE = {
  title: 'E2E Revise Box',
  premise: 'A lighthouse keeper answers a signal from a ship that sank a century ago.',
  characters: [{ name: 'Mara', description: 'the keeper' }],
  chapters: [
    { chapter_number: 1, title: 'The Signal', beat: 'Mara hears the transmission.' },
    { chapter_number: 2, title: 'The Answer', beat: 'Mara answers it.' },
  ],
};

test.describe('Revise outline box (result-asserting, no engine job)', () => {
  let projectId = '';
  let blankId = '';
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Revise Box ${Date.now()}`, outline: OUTLINE });
    blankId = await seedProject({ title: `E2E Revise Blank ${Date.now()}` });
  });
  test.afterAll(async () => {
    for (const id of [projectId, blankId]) {
      if (!id) continue;
      await supaDelete('outline_versions_v2', `project_id=eq.${id}`);
      await deleteProject(id);
    }
  });

  test('the box renders on the Outline tab; Revise is disabled until there is a directive', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=outline`);
    const box = page.getByTestId('outline-revise');
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box).toContainText('Revise the whole outline');
    const input = page.getByLabel('Outline revision instructions');
    const submit = page.getByTestId('outline-revise-submit');
    await expect(submit).toBeDisabled();
    await input.fill('  ');
    await expect(submit).toBeDisabled();
    await input.fill('Add a prologue in 1650.');
    await expect(submit).toBeEnabled();
    await input.fill('');
    await expect(submit).toBeDisabled();
    // Nothing running, nothing reported.
    await expect(page.getByTestId('outline-revise-progress')).toHaveCount(0);
    await expect(page.getByTestId('outline-revise-error')).toHaveCount(0);
  });

  test('a project with no outline shows no box', async ({ page }) => {
    await page.goto(`/projects/${blankId}?tab=outline`);
    await expect(page.getByText(/No outline yet/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('outline-revise')).toHaveCount(0);
  });

  test('the route refuses an empty directive, a project with no outline, and an unknown project — and changes nothing', async () => {
    const api = await apiClient();
    try {
      const empty = await api.post(`/api/projects/${projectId}/outline/revise`, { data: { directive: '' } });
      expect(empty.status()).toBe(400);
      expect((await empty.json()).error.code).toBe('VALIDATION_ERROR');

      const blank = await api.post(`/api/projects/${blankId}/outline/revise`, { data: { directive: 'Add a prologue.' } });
      expect(blank.status()).toBe(400);
      expect((await blank.json()).error.code).toBe('NO_OUTLINE');

      const unknown = await api.post('/api/projects/00000000-0000-0000-0000-000000000000/outline/revise', { data: { directive: 'Add a prologue.' } });
      expect(unknown.status()).toBe(404);
    } finally {
      await api.dispose();
    }
    // Result: the outline is unchanged and no version snapshot was made.
    const [row] = await supaGet('writing_projects_v2', `id=eq.${projectId}&select=outline`);
    expect(row.outline.chapters).toHaveLength(2);
    expect(await supaGet('outline_versions_v2', `project_id=eq.${projectId}&select=id`)).toHaveLength(0);
  });
});
