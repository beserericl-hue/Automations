import { test, expect } from '@playwright/test';
import {
  seedContent, seedProject, seedImage, getContent, deleteContent, deleteProject, supaGet,
} from '../pages/api';

/**
 * ContentDetail — FULL interactive-element coverage, RESULT-asserting + data-isolated.
 *
 * Covers every interactive element on components/content/ContentDetail.tsx (and its panels) NOT already
 * asserted by content-lifecycle.spec.ts (Approve/Publish/Reject), content-editor.spec.ts (editor save +
 * History open) or content-qa.spec.ts (Run Q/A). The remaining elements:
 *
 *   - Schedule button → datetime-local input → Confirm Schedule       (status=scheduled + schedule_date)
 *   - Unschedule (confirm) / Publish Now                              (scheduled → draft / published)
 *   - Back to Draft (approved → draft)
 *   - Unpublish (confirm) (published → approved)
 *   - Cover image picker: Choose from Gallery / Change Cover / Remove (cover_image_path set/cleared)
 *   - VersionHistory: View, Restore (content reverts + new snapshot), Compare disabled <2 versions
 *   - ProvenancePanel: Sources toggle expands (empty state)
 *   - QAReportPanel Re-run (fresh report over an existing one)
 *
 * Every test seeds disposable rows owned by the demo user (DEMO_USER_ID), asserts the REAL produced result
 * (DOM shows it AND the DB row/field changed via supaGet), and hard-deletes in teardown.
 */

// --------------------------------------------------------------------------- Schedule / lifecycle transitions
test.describe('ContentDetail — schedule + lifecycle transitions (result-asserting)', () => {
  let contentId = '';
  test.afterEach(async () => {
    if (contentId) { await deleteContent(contentId); contentId = ''; }
  });

  test('Schedule → datetime input → Confirm Schedule sets status=scheduled + metadata.schedule_date', async ({ page }) => {
    contentId = await seedContent({
      title: `E2E Schedule ${Date.now()}`, content_type: 'chapter', status: 'draft',
      content_text: 'The convoy would leave at dawn. '.repeat(20),
    });
    await page.goto(`/content/${contentId}`);

    const scheduleBtn = page.getByRole('button', { name: 'Schedule', exact: true });
    await expect(scheduleBtn).toBeVisible({ timeout: 20_000 });
    await scheduleBtn.click();

    // datetime-local picker appears; pick ~2 days out (must be >= min).
    const input = page.locator('input[type="datetime-local"]');
    await expect(input).toBeVisible({ timeout: 10_000 });
    const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 16);
    await input.fill(future);

    await page.getByRole('button', { name: /Confirm Schedule/i }).click();

    // DB result: status flips to scheduled AND metadata.schedule_date is set.
    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 30_000, message: 'Confirm Schedule did not set status=scheduled in the DB' })
      .toBe('scheduled');
    const row = await getContent(contentId, 'status,metadata');
    expect(typeof row.metadata?.schedule_date, 'metadata.schedule_date must be set').toBe('string');

    // UI result: the scheduled-date banner shows and the Unschedule action is now available.
    await expect(page.getByText(/Scheduled for:/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Unschedule/i })).toBeVisible();
  });

  test('scheduled → Unschedule (confirm) clears schedule_date and returns to draft', async ({ page }) => {
    const when = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    contentId = await seedContent({
      title: `E2E Unschedule ${Date.now()}`, content_type: 'chapter', status: 'scheduled',
      metadata: { schedule_date: when },
    });
    await page.goto(`/content/${contentId}`);

    const unschedule = page.getByRole('button', { name: /Unschedule/i });
    await expect(unschedule).toBeVisible({ timeout: 20_000 });
    await unschedule.click();

    // needsConfirm → ConfirmDialog.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();

    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 30_000, message: 'Unschedule did not flip status to draft in the DB' })
      .toBe('draft');
    const row = await getContent(contentId, 'status,metadata');
    expect(row.metadata?.schedule_date, 'schedule_date must be cleared on unschedule').toBeUndefined();
  });

  test('scheduled → Publish Now sets status=published', async ({ page }) => {
    const when = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    contentId = await seedContent({
      title: `E2E PublishNow ${Date.now()}`, content_type: 'chapter', status: 'scheduled',
      metadata: { schedule_date: when },
    });
    await page.goto(`/content/${contentId}`);

    const publishNow = page.getByRole('button', { name: 'Publish Now', exact: true });
    await expect(publishNow).toBeVisible({ timeout: 20_000 });
    await publishNow.click();

    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 30_000, message: 'Publish Now did not flip status to published in the DB' })
      .toBe('published');
    await expect(page.getByRole('button', { name: /Unpublish/i })).toBeVisible({ timeout: 15_000 });
  });

  test('approved → Back to Draft sets status=draft', async ({ page }) => {
    contentId = await seedContent({
      title: `E2E BackToDraft ${Date.now()}`, content_type: 'chapter', status: 'approved',
    });
    await page.goto(`/content/${contentId}`);

    const backToDraft = page.getByRole('button', { name: /Back to Draft/i });
    await expect(backToDraft).toBeVisible({ timeout: 20_000 });
    await backToDraft.click();

    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 30_000, message: 'Back to Draft did not flip status to draft in the DB' })
      .toBe('draft');
    // Draft actions re-appear.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('published → Unpublish (confirm) sets status=approved', async ({ page }) => {
    contentId = await seedContent({
      title: `E2E Unpublish ${Date.now()}`, content_type: 'chapter', status: 'published',
    });
    await page.goto(`/content/${contentId}`);

    const unpublish = page.getByRole('button', { name: /Unpublish/i });
    await expect(unpublish).toBeVisible({ timeout: 20_000 });
    await unpublish.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();

    await expect
      .poll(async () => (await getContent(contentId, 'status'))?.status,
        { timeout: 30_000, message: 'Unpublish did not flip status to approved in the DB' })
      .toBe('approved');
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible({ timeout: 15_000 });
  });
});

// --------------------------------------------------------------------------- Cover image picker
test.describe('ContentDetail — cover image picker (result-asserting)', () => {
  let projectId = '';
  let contentId = '';
  test.beforeEach(async () => {
    projectId = await seedProject({ title: `E2E Cover ${Date.now()}` });
    // Seed two selectable cover images so the gallery renders thumbnails.
    await seedImage(projectId, 'cover_art');
    await seedImage(projectId, 'cover_art');
    contentId = await seedContent({
      title: `E2E Cover Chapter ${Date.now()}`, content_type: 'chapter', status: 'draft',
      chapter_number: 1, project_id: projectId,
    });
  });
  test.afterEach(async () => {
    if (contentId) { await deleteContent(contentId); contentId = ''; }
    if (projectId) { await deleteProject(projectId); projectId = ''; }
  });

  test('Choose from Gallery → select image sets cover_image_path; then Remove clears it', async ({ page }) => {
    await page.goto(`/content/${contentId}`);

    // No cover yet → "Choose from Gallery".
    const choose = page.getByRole('button', { name: /Choose from Gallery/i });
    await expect(choose).toBeVisible({ timeout: 20_000 });
    expect((await getContent(contentId, 'cover_image_path'))?.cover_image_path ?? null).toBeNull();
    await choose.click();

    // Picker modal opens with the gallery; click the first thumbnail (picker mode → selects, no nav).
    await expect(page.getByRole('heading', { name: 'Select Cover Image' })).toBeVisible({ timeout: 10_000 });
    const thumb = page.locator('.grid img').first();
    await expect(thumb).toBeVisible({ timeout: 15_000 });
    await thumb.click();

    // DB result: cover_image_path is now set to one of our seeded storage paths.
    await expect
      .poll(async () => (await getContent(contentId, 'cover_image_path'))?.cover_image_path ?? null,
        { timeout: 20_000, message: 'selecting a gallery image did not set cover_image_path' })
      .not.toBeNull();
    const chosenPath = (await getContent(contentId, 'cover_image_path')).cover_image_path as string;
    const seeded = await supaGet('generated_images_v2', `project_id=eq.${projectId}&select=storage_path`);
    expect(seeded.map((r: { storage_path: string }) => r.storage_path)).toContain(chosenPath);

    // UI result: the cover banner + Change Cover / Remove appear.
    await expect(page.getByRole('button', { name: 'Change Cover', exact: true })).toBeVisible({ timeout: 15_000 });

    // Remove clears cover_image_path.
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect
      .poll(async () => (await getContent(contentId, 'cover_image_path'))?.cover_image_path ?? null,
        { timeout: 20_000, message: 'Remove did not clear cover_image_path' })
      .toBeNull();
    await expect(page.getByRole('button', { name: /Choose from Gallery/i })).toBeVisible({ timeout: 15_000 });
  });

  test('Change Cover re-opens the picker and swaps to a chosen (seeded) image', async ({ page }) => {
    // NOTE: the picker (ImageGallery in picker mode) lists ALL of the user's images, not just this
    // project's — so we can't assume an arbitrary thumbnail is one of ours. Pick our own seeded image
    // deterministically by matching its storage_path in the thumbnail src, and assert THAT path lands.
    const seeded = await supaGet('generated_images_v2', `project_id=eq.${projectId}&select=storage_path`);
    const startPath = (seeded[0] as { storage_path: string }).storage_path;
    const targetPath = (seeded[1] as { storage_path: string }).storage_path;
    // Set an initial (different) cover via the DB so we start in the "has cover" branch.
    await fetchPatchCover(contentId, startPath);

    await page.goto(`/content/${contentId}`);
    const change = page.getByRole('button', { name: 'Change Cover', exact: true });
    await expect(change).toBeVisible({ timeout: 20_000 });
    await change.click();

    await expect(page.getByRole('heading', { name: 'Select Cover Image' })).toBeVisible({ timeout: 10_000 });
    // Find the thumbnail for our target seeded image by its encoded storage_path in the src.
    const targetEncoded = targetPath.split('/').map((s) => encodeURIComponent(s)).join('/');
    const targetThumb = page.locator(`.grid img[src*="${targetEncoded}"]`).first();
    await expect(targetThumb, 'seeded target image must appear in the picker gallery').toBeVisible({ timeout: 15_000 });
    await targetThumb.click();

    // DB result: cover_image_path swapped to the target seeded path.
    await expect
      .poll(async () => (await getContent(contentId, 'cover_image_path'))?.cover_image_path ?? null,
        { timeout: 20_000, message: 'Change Cover picker did not persist the chosen image' })
      .toBe(targetPath);
  });
});

// Small helper: PATCH cover_image_path directly (service key) so a test can start in the "has cover" branch.
async function fetchPatchCover(contentId: string, storagePath: string): Promise<void> {
  const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
  const KEY = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const res = await fetch(`${SUPA_URL}/rest/v1/published_content_v2?id=eq.${contentId}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ cover_image_path: storagePath }),
  });
  if (!res.ok) throw new Error(`patch cover ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// --------------------------------------------------------------------------- Version History: View / Restore / Compare
test.describe('ContentDetail — Version History View/Restore/Compare (result-asserting)', () => {
  let contentId = '';
  const V1 = `VONE-${Date.now()}`;
  const V2 = `VTWO-${Date.now()}`;

  test.beforeEach(async () => {
    contentId = await seedContent({
      title: `E2E Versions ${Date.now()}`, content_type: 'chapter', status: 'draft',
      content_text: 'Baseline paragraph before any edit. ',
    });
  });
  test.afterEach(async () => {
    if (contentId) { await deleteContent(contentId); contentId = ''; }
  });

  test('Restore reverts content_text to an older version and snapshots a new version; Compare disabled <2', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/content/${contentId}`);
    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });

    // Open History first (no versions yet → empty state; Compare not rendered).
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByText(/No version history yet/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();

    // Edit #1 → version 1 (content contains V1 marker).
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${V1}`);
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length,
        { timeout: 20_000, message: 'first edit did not snapshot a version' })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => (await getContent(contentId, 'content_text'))?.content_text?.includes(V1) ?? false,
        { timeout: 20_000 }).toBe(true);

    // With exactly 1 version, Compare must be disabled. Reload first so VersionHistory's query
    // (which is cached from the earlier empty open) refetches the current version list.
    await page.reload();
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const compareEarly = page.getByRole('button', { name: /Compare versions/i });
    await expect(compareEarly).toBeVisible({ timeout: 10_000 });
    await expect(compareEarly, 'Compare must be disabled with <2 versions').toBeDisabled();
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();

    // Edit #2 → version 2 (content now also contains V2). This is the CURRENT text.
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${V2}`);
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length,
        { timeout: 20_000, message: 'second edit did not snapshot a version' })
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => (await getContent(contentId, 'content_text'))?.content_text?.includes(V2) ?? false,
        { timeout: 20_000 }).toBe(true);

    const versionsBeforeRestore =
      (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length;

    // Open History — now with ≥2 versions, Compare is ENABLED. Reload so the panel query refetches the
    // current (2-version) list rather than serving the cached 1-version result.
    await page.reload();
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const compare = page.getByRole('button', { name: /Compare versions/i });
    await expect(compare).toBeVisible({ timeout: 10_000 });
    await expect(compare).toBeEnabled();

    // View the OLDER version (list is newest-first → last "View"). Renders the version body.
    const viewButtons = page.getByRole('button', { name: 'View', exact: true });
    await viewButtons.last().click();
    await expect(page.getByText(/Version \d+/).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Back to list/i }).click();

    // Restore the OLDER version — contains V1, NOT V2 (before edit #2). Last Restore in newest-first list.
    const restoreButtons = page.getByRole('button', { name: 'Restore', exact: true });
    await restoreButtons.last().click();

    // DB result: content_text reverts to the older version (contains V1, no longer contains V2) AND a
    // NEW snapshot row was added (restore inserts a version).
    await expect
      .poll(async () => {
        const t = (await getContent(contentId, 'content_text'))?.content_text ?? '';
        return t.includes(V1) && !t.includes(V2);
      }, { timeout: 20_000, message: 'Restore did not revert content_text to the older version' })
      .toBe(true);
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${contentId}&select=id`)).length,
        { timeout: 20_000, message: 'Restore did not create a new version snapshot' })
      .toBeGreaterThan(versionsBeforeRestore);
  });
});

// --------------------------------------------------------------------------- Provenance panel
test.describe('ContentDetail — Provenance panel (result-asserting)', () => {
  let contentId = '';
  test.beforeEach(async () => {
    contentId = await seedContent({
      title: `E2E Provenance ${Date.now()}`, content_type: 'chapter', status: 'draft',
    });
  });
  test.afterEach(async () => {
    if (contentId) { await deleteContent(contentId); contentId = ''; }
  });

  test('Sources toggle expands and shows the empty state (no tracked sources)', async ({ page }) => {
    await page.goto(`/content/${contentId}`);
    const toggle = page.getByRole('button', { name: /Sources/ });
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    // Collapsed: empty state not shown yet.
    await expect(page.getByText(/No sources tracked/i)).toHaveCount(0);
    await toggle.click();
    // Expanded: this disposable chapter has no content_usage_v2 rows → empty state renders.
    await expect(page.getByText(/No sources tracked/i)).toBeVisible({ timeout: 15_000 });
  });
});

// --------------------------------------------------------------------------- QAReportPanel Re-run (report already present)
test.describe('ContentDetail — QAReportPanel Re-run (result-asserting)', () => {
  let projectId = '';
  let contentId = '';
  test.beforeEach(async () => {
    projectId = await seedProject({ title: `E2E QARerun ${Date.now()}` });
    // Seed a chapter that ALREADY has a qa_report so the "Re-run" affordance (not "Run Q/A Check") shows.
    contentId = await seedContent({
      title: 'Chapter 1 — Signal', content_type: 'chapter', status: 'draft', chapter_number: 1,
      project_id: projectId,
      content_text: 'Mara traced the anomaly across three decades of silence. '.repeat(30),
      metadata: {
        qa_report: {
          generated_at: new Date(Date.now() - 3600_000).toISOString(),
          checks: [{ name: 'Seed check', status: 'PASS', details: 'pre-seeded report' }],
        },
      },
    });
  });
  test.afterEach(async () => {
    if (projectId) { await deleteProject(projectId); projectId = ''; }
    contentId = '';
  });

  test('Re-run queues a fresh Q/A that overwrites the seeded report', async ({ page }) => {
    test.setTimeout(400_000);
    await page.goto(`/content/${contentId}`);

    // The report header shows because a report exists; the small "Re-run" button is present.
    await expect(page.getByText(/Q\/A Consistency Report/i)).toBeVisible({ timeout: 20_000 });
    const before = await getContent(contentId, 'metadata');
    const beforeGen = before?.metadata?.qa_report?.generated_at as string | undefined;

    const rerun = page.getByRole('button', { name: 'Re-run', exact: true });
    await expect(rerun).toBeVisible({ timeout: 15_000 });
    await rerun.click();

    // DB result: the engine rewrote metadata.qa_report — a fresh generated_at (or a check that isn't our
    // seeded stub) replaces the seeded stub.
    await expect
      .poll(async () => {
        const row = await getContent(contentId, 'metadata');
        const rep = row?.metadata?.qa_report;
        const checks = rep?.checks;
        const gen = rep?.generated_at as string | undefined;
        if (!Array.isArray(checks) || checks.length === 0) return false;
        const stubOnly = checks.length === 1 && checks[0]?.name === 'Seed check';
        return gen !== beforeGen || !stubOnly;
      }, { timeout: 360_000, message: 'Re-run never produced a fresh qa_report in the DB' })
      .toBe(true);

    // UI result: still the report view (not reverted to empty state).
    await page.reload();
    await expect(page.getByText(/Q\/A Consistency Report/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/No consistency report available/i)).toHaveCount(0);
  });
});
