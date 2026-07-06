import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Q/A tab + "Rewrite to fix Q/A" — the feature added after a user found the Q/A Consistency Report had
 * no way to act on a flagged finding (and Q/A wasn't discoverable).
 *
 * PASS: the project Q/A tab renders every chapter with craft-QA scores; a chapter with a flagged check
 *       shows a "Rewrite to fix Q/A" button; clicking it queues an engine job (button → Rewriting…).
 * FAIL: no Q/A tab, no scores, no fix button, or the click doesn't dispatch.
 *
 * The full multi-minute rewrite completion is not awaited here (dispatch is the data-path proof); the
 * heavy content-change is covered by the chapter.repair path in content-repair.spec.ts.
 */
const PROJECT_ID = 'dd10c1c3-e025-4cd7-854d-21db32a2e4da'; // The Last Signal

test.describe('Project Q/A tab + Rewrite to fix Q/A', () => {
  test('Q/A tab lists chapters with craft-QA and a fix button for flagged chapters', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}?tab=qa`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /The Last Signal/ })).toBeVisible({ timeout: 20_000 });

    // The Q/A tab exists and is selectable.
    const qaTab = page.getByText(/^Q\/A$/).first();
    await expect(qaTab).toBeVisible({ timeout: 20_000 });
    await qaTab.click();

    // The grid renders chapters (column headers + at least one chapter row with a craft-QA score).
    await expect(page.getByText(/Craft QA/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Consistency report/i).first()).toBeVisible();
    // A chapter row links into the chapter.
    await expect(page.getByRole('link', { name: /The Wasteland's Rules|The Frequency|The Guide and the Deal/ }).first())
      .toBeVisible({ timeout: 20_000 });

    // The Wasteland's Rules (ch3) has a flagged consistency check → a "Rewrite to fix Q/A" button.
    const fixBtn = page.getByRole('button', { name: /Rewrite to fix Q\/A/i }).first();
    await expect(fixBtn).toBeVisible({ timeout: 20_000 });

    // Clicking it dispatches an engine job (button flips to Rewriting…). We don't await the full rewrite.
    await fixBtn.click();
    await expect(page.getByRole('button', { name: /Rewriting…/i }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('the Q/A Consistency Report panel on a chapter exposes the fix action', async ({ page }) => {
    const CONTENT_ID = 'd681e643-2984-4ebc-83c1-f125a1c6fade'; // The Wasteland's Rules (has a flagged check)
    // Only meaningful if a report exists with a flagged check.
    const rows = await supaGet<{ metadata: { qa_report?: { checks?: Array<{ status?: string }> } } | null }>(
      'published_content_v2', `id=eq.${CONTENT_ID}&select=metadata`,
    ).catch(() => []);
    const checks = rows[0]?.metadata?.qa_report?.checks ?? [];
    const flagged = checks.filter((c) => String(c.status).toUpperCase() !== 'PASS').length;
    test.skip(!flagged, 'no flagged Q/A check on this chapter to fix');

    await page.goto(`/content/${CONTENT_ID}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Q\/A Consistency Report/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Rewrite to fix Q\/A/i }).first()).toBeVisible({ timeout: 20_000 });
  });
});
