import { test, expect, type Page } from '@playwright/test';
import { seedContent, getContent, deleteContent, supaGet, DEMO_USER_ID } from '../pages/api';

/**
 * Content Library — RESULT-asserting coverage for every interactive element NOT already exercised by
 * library-bulk.spec.ts (which owns bulk-approve, type filter, sort, row nav, bulk-toolbar-visible).
 *
 * This file adds: bulk Publish, bulk Delete (+ confirm dialog), Clear-filters button, status/genre/project
 * filters, every sortable header toggle, and the pagination page-size select. Each UI action is proved
 * against the DB (published_content_v2) or against the rendered table. All seeded rows are tagged with a
 * unique run marker and hard-deleted in teardown so nothing leaks into the demo user's ~225 real rows.
 *
 * Verified against components/content/ContentLibrary.tsx + shared/Pagination.tsx. Pinned to DEMO_USER_ID.
 */

const RUN = Date.now();
const seededIds: string[] = [];

async function seed(fields: Parameters<typeof seedContent>[0]): Promise<string> {
  const id = await seedContent(fields);
  seededIds.push(id);
  return id;
}

/** Wait for the library table to have rows rendered. */
async function waitTable(page: Page) {
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Locate a seeded row by its unique title marker. */
function row(page: Page, title: string) {
  return page.locator('tr', { hasText: title }).first();
}

test.describe('Content Library full interactive coverage (result-asserting)', () => {
  test.afterAll(async () => {
    for (const id of seededIds) await deleteContent(id);
  });

  // ------------------------------------------------------------------- bulk PUBLISH
  test('bulk Publish flips both selected approved rows to published in the DB', async ({ page }) => {
    const tagA = `E2E Pub A ${RUN}`;
    const tagB = `E2E Pub B ${RUN}`;
    const idA = await seed({ title: tagA, content_type: 'blog_post', status: 'approved' });
    const idB = await seed({ title: tagB, content_type: 'blog_post', status: 'approved' });

    await page.goto('/library');
    await waitTable(page);

    for (const tag of [tagA, tagB]) {
      const r = row(page, tag);
      await expect(r, `seeded row "${tag}" must be listed`).toBeVisible({ timeout: 15_000 });
      await r.getByRole('checkbox').check();
    }

    const publish = page.getByRole('button', { name: 'Publish', exact: true });
    await expect(publish).toBeVisible({ timeout: 10_000 });
    await publish.click();

    for (const id of [idA, idB]) {
      await expect
        .poll(async () => (await getContent(id, 'status'))?.status,
          { timeout: 20_000, message: `bulk publish did not set ${id} to published` })
        .toBe('published');
    }
  });

  // ------------------------------------------------------------------- bulk DELETE (+ confirm dialog)
  test('bulk Delete + confirm soft-deletes both selected rows (deleted_at set) in the DB', async ({ page }) => {
    const tagA = `E2E Del A ${RUN}`;
    const tagB = `E2E Del B ${RUN}`;
    const idA = await seed({ title: tagA, content_type: 'blog_post', status: 'draft' });
    const idB = await seed({ title: tagB, content_type: 'blog_post', status: 'draft' });

    await page.goto('/library');
    await waitTable(page);

    for (const tag of [tagA, tagB]) {
      const r = row(page, tag);
      await expect(r, `seeded row "${tag}" must be listed`).toBeVisible({ timeout: 15_000 });
      await r.getByRole('checkbox').check();
    }

    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // Confirm dialog appears with the count and a "Delete All" confirm.
    const confirm = page.getByRole('button', { name: 'Delete All', exact: true });
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.click();

    for (const id of [idA, idB]) {
      await expect
        .poll(async () =>
          (await supaGet('published_content_v2', `id=eq.${id}&select=deleted_at`))[0]?.deleted_at != null,
          { timeout: 20_000, message: `bulk delete did not set deleted_at on ${id}` })
        .toBe(true);
    }
  });

  // ------------------------------------------------------------------- status filter
  test('status filter narrows the list to the chosen status', async ({ page }) => {
    const uniq = `E2E Status ${RUN}-${Math.random().toString(36).slice(2, 6)}`;
    const draftTag = `${uniq} DRAFT`;
    const approvedTag = `${uniq} APPROVED`;
    await seed({ title: draftTag, content_type: 'blog_post', status: 'draft' });
    await seed({ title: approvedTag, content_type: 'blog_post', status: 'approved' });

    await page.goto('/library');
    await waitTable(page);
    await expect(row(page, draftTag)).toBeVisible({ timeout: 15_000 });
    await expect(row(page, approvedTag)).toBeVisible();

    // Filter to Approved: draft row disappears, approved row stays.
    await page.locator('select').filter({ hasText: 'All statuses' }).selectOption('approved');
    await expect(row(page, approvedTag)).toBeVisible({ timeout: 10_000 });
    await expect(row(page, draftTag)).toHaveCount(0);
  });

  // ------------------------------------------------------------------- genre filter
  test('genre filter narrows the list to the chosen genre', async ({ page }) => {
    const uniq = `E2E Genre ${RUN}-${Math.random().toString(36).slice(2, 6)}`;
    const postApocTag = `${uniq} POSTAPOC`;
    const politTag = `${uniq} POLITICAL`;
    await seed({ title: postApocTag, content_type: 'blog_post', status: 'draft', genre_slug: 'post-apocalyptic' });
    await seed({ title: politTag, content_type: 'blog_post', status: 'draft', genre_slug: 'political-scifi' });

    await page.goto('/library');
    await waitTable(page);
    await expect(row(page, postApocTag)).toBeVisible({ timeout: 15_000 });
    await expect(row(page, politTag)).toBeVisible();

    // The genre <select> option values are the raw slug.
    await page.locator('select').filter({ hasText: 'All genres' }).selectOption('political-scifi');
    await expect(row(page, politTag)).toBeVisible({ timeout: 10_000 });
    await expect(row(page, postApocTag)).toHaveCount(0);
  });

  // ------------------------------------------------------------------- project filter
  test('project filter narrows the list to content in the chosen project', async ({ page }) => {
    // Reuse a real project the demo user owns so it appears in the project dropdown.
    const projects = await supaGet<{ id: string; title: string }>(
      'writing_projects_v2',
      `user_id=eq.${encodeURIComponent(DEMO_USER_ID)}&deleted_at=is.null&select=id,title&order=title&limit=1`,
    );
    test.skip(projects.length === 0, 'no project available for the demo user to filter on');
    const project = projects[0];

    const uniq = `E2E Proj ${RUN}-${Math.random().toString(36).slice(2, 6)}`;
    const inProjTag = `${uniq} INPROJ`;
    const noProjTag = `${uniq} NOPROJ`;
    await seed({ title: inProjTag, content_type: 'blog_post', status: 'draft', project_id: project.id });
    await seed({ title: noProjTag, content_type: 'blog_post', status: 'draft', project_id: null });

    await page.goto('/library');
    await waitTable(page);
    await expect(row(page, inProjTag)).toBeVisible({ timeout: 15_000 });
    await expect(row(page, noProjTag)).toBeVisible();

    await page.locator('select').filter({ hasText: 'All projects' }).selectOption(project.id);
    await expect(row(page, inProjTag)).toBeVisible({ timeout: 10_000 });
    await expect(row(page, noProjTag)).toHaveCount(0);
  });

  // ------------------------------------------------------------------- Clear filters button
  test('Clear filters button appears after filtering and resets the list', async ({ page }) => {
    const uniq = `E2E Clear ${RUN}-${Math.random().toString(36).slice(2, 6)}`;
    const draftTag = `${uniq} DRAFT`;
    const approvedTag = `${uniq} APPROVED`;
    await seed({ title: draftTag, content_type: 'blog_post', status: 'draft' });
    await seed({ title: approvedTag, content_type: 'blog_post', status: 'approved' });

    await page.goto('/library');
    await waitTable(page);

    // No Clear button until a filter is active.
    const clearBtn = page.getByRole('button', { name: 'Clear filters', exact: true });
    await expect(clearBtn).toHaveCount(0);

    await page.locator('select').filter({ hasText: 'All statuses' }).selectOption('approved');
    await expect(row(page, draftTag)).toHaveCount(0);

    // Now the Clear button is present; clicking it restores the draft row.
    await expect(clearBtn).toBeVisible({ timeout: 10_000 });
    await clearBtn.click();
    await expect(clearBtn).toHaveCount(0);
    await expect(row(page, draftTag)).toBeVisible({ timeout: 10_000 });
    await expect(row(page, approvedTag)).toBeVisible();
  });

  // ------------------------------------------------------------------- sortable headers
  test('each sortable header (Title/Type/Status/Updated) toggles the sort indicator', async ({ page }) => {
    await page.goto('/library');
    await waitTable(page);

    for (const label of ['Title', 'Type', 'Status', 'Updated']) {
      const header = page.getByRole('columnheader', { name: new RegExp(`^${label}`) });
      await expect(header, `sortable header "${label}" must exist`).toBeVisible();

      // First click -> descending arrow (default sortAsc=false). The header text gains the ↓ glyph.
      await header.click();
      await expect(header).toContainText('↓', { timeout: 5_000 });

      // Second click on the same header -> ascending arrow ↑ (toggle).
      await header.click();
      await expect(header).toContainText('↑', { timeout: 5_000 });
    }
  });

  // ------------------------------------------------------------------- pagination page-size select
  test('pagination page-size select changes how many rows render', async ({ page }) => {
    await page.goto('/library');
    await waitTable(page);

    // The demo user has ~225 rows, so with no filters Pagination renders (totalItems > 10).
    const pageSize = page.locator('select').filter({ hasText: 'per page' });
    await expect(pageSize, 'page-size select must render for the demo user (>10 rows)').toBeVisible({ timeout: 10_000 });

    // Default page size is 25 -> 25 body rows on page 1.
    await expect.poll(async () => page.locator('table tbody tr').count(), { timeout: 10_000 }).toBe(25);

    // Switch to 10 per page -> exactly 10 rows render.
    await pageSize.selectOption('10');
    await expect.poll(async () => page.locator('table tbody tr').count(), { timeout: 10_000 }).toBe(10);

    // Switch to 50 per page -> 50 rows render.
    await pageSize.selectOption('50');
    await expect.poll(async () => page.locator('table tbody tr').count(), { timeout: 10_000 }).toBe(50);
  });
});
