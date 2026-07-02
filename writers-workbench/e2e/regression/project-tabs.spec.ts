import { test, expect } from '@playwright/test';
import {
  seedProject, seedBibleEntry, seedSocialPost, seedResearch, linkResearchToProject,
  seedTokenUsage, supaDelete, deleteProject,
} from '../pages/api';

/**
 * ProjectDetail tab interactive elements — RESULT-asserting where a DB row backs the render, and
 * DOM-asserting for the pure client-side expand/filter toggles (which have no DB side-effect). One
 * disposable project is seeded with an outline, a bible entry, a social post, a linked research report,
 * and a token-usage row, so every tab below has real data to render.
 *
 * Covers (elements not already result-asserted elsewhere):
 *   - Overview : Genre expander (reveals Writing Guidelines)
 *   - Outline  : Expand all / Collapse all; Book Overview expander
 *   - Bible    : read-only tab renders seeded story_bible_v2 entries
 *   - Social   : platform filter buttons + per-post Copy (clipboard)
 *   - Research : Expand all / Collapse all + per-report toggle (project-scoped via link table)
 *   - Cost     : date-range buttons render + switch
 */

const STAMP = Date.now();
const CHAR_NAME = `Tayak ${STAMP}`;
const SOCIAL_TEXT = `E2E social post body ${STAMP}`;
const RESEARCH_TOPIC = `E2E Linked Research ${STAMP}`;

// An outline rich enough that Book Overview (premise/characters/themes) and a sub-chapter-bearing
// chapter both render, so Expand all reveals real sub-chapter content.
const OUTLINE = {
  premise: `A disposable regression premise ${STAMP}.`,
  themes: ['memory', 'survival'],
  story_arc_name: 'Three-Act Structure',
  characters: [{ name: CHAR_NAME, role: 'protagonist', age: 34, description: 'A disposable regression character.' }],
  chapters: [
    {
      number: 1,
      title: `Chapter One ${STAMP}`,
      brief: 'The disposable opening chapter.',
      chapter_outline: {
        sub_chapters: [
          { number: 1, title: 'Opening beat', brief: 'A disposable sub-chapter beat.', arc_beat: 'setup', characters: [CHAR_NAME] },
        ],
      },
    },
  ],
};

let projectId = '';
let socialId = '';
let researchId = '';
let bibleId = '';
let tokenId = '';

test.describe('ProjectDetail tabs (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Tabs ${STAMP}`, genre_slug: 'post-apocalyptic', outline: OUTLINE });
    bibleId = await seedBibleEntry({ projectId, name: CHAR_NAME, description: 'Bible entry for the tabs test.' });
    socialId = await seedSocialPost({ projectId, platform: 'twitter', postText: SOCIAL_TEXT, hashtags: ['scifi', 'e2e'] });
    researchId = await seedResearch(RESEARCH_TOPIC);
    await linkResearchToProject(researchId, projectId);
    tokenId = await seedTokenUsage(projectId);
  });

  test.afterAll(async () => {
    if (socialId) await supaDelete('social_posts_v2', `id=eq.${socialId}`);
    if (tokenId) await supaDelete('token_usage_v2', `id=eq.${tokenId}`);
    if (researchId) {
      await supaDelete('research_report_projects_v2', `report_id=eq.${researchId}`);
      await supaDelete('research_reports_v2', `id=eq.${researchId}`);
    }
    if (projectId) await deleteProject(projectId); // cascades bible + project
  });

  test('Overview tab: Genre expander reveals genre detail', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=overview`);
    // Genre section header comes from genre_config_v2 for post-apocalyptic (a real public genre).
    const genreHeader = page.getByRole('button', { name: /^Genre:/ });
    await expect(genreHeader).toBeVisible({ timeout: 20_000 });
    // Writing Guidelines is only rendered inside the expanded region.
    await expect(page.getByText('Writing Guidelines')).toHaveCount(0);
    await genreHeader.click();
    await expect(page.getByText('Writing Guidelines')).toBeVisible({ timeout: 10_000 });
  });

  test('Outline tab: Book Overview expander + Expand all / Collapse all', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=outline`);
    // Book Overview starts OPEN (bookOverviewOpen=true) → Premise visible. Collapse hides it.
    const bookOverview = page.getByRole('button', { name: /Book Overview/ });
    await expect(bookOverview).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(OUTLINE.premise).first()).toBeVisible({ timeout: 10_000 });
    await bookOverview.click(); // collapse
    await expect(page.getByText(OUTLINE.premise)).toHaveCount(0);
    await bookOverview.click(); // re-open
    await expect(page.getByText(OUTLINE.premise).first()).toBeVisible({ timeout: 10_000 });

    // Expand all → the chapter's sub-chapter beat becomes visible; Collapse all hides it.
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(page.getByText('Opening beat').first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(page.getByText('Opening beat')).toHaveCount(0);
  });

  test('Bible tab: renders seeded story_bible_v2 entries (read-only)', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=bible`);
    // The read-only Bible tab groups by type; the seeded character must appear.
    await expect(page.getByText(CHAR_NAME).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Bible entry for the tabs test.').first()).toBeVisible({ timeout: 10_000 });
    void bibleId; // asserted via DOM (row backed by the seeded DB entry)
  });

  test('Social tab: platform filter buttons + per-post Copy', async ({ page, context, browserName }) => {
    // Grant clipboard permission (Chromium) so navigator.clipboard.writeText resolves in the handler.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await page.goto(`/projects/${projectId}?tab=social`);
    await expect(page.getByText(SOCIAL_TEXT).first()).toBeVisible({ timeout: 20_000 });

    // Filter to Twitter/X → the twitter post stays; filter to LinkedIn → it disappears (empty state).
    await page.getByRole('button', { name: 'Twitter / X' }).click();
    await expect(page.getByText(SOCIAL_TEXT).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'LinkedIn' }).click();
    await expect(page.getByText(SOCIAL_TEXT)).toHaveCount(0);
    await expect(page.getByText('No social posts yet')).toBeVisible({ timeout: 10_000 });

    // Back to All Platforms → Copy the post. Result: the checkmark (copied) icon appears and the
    // clipboard holds the post text + hashtags.
    await page.getByRole('button', { name: 'All Platforms' }).click();
    await expect(page.getByText(SOCIAL_TEXT).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Copy to clipboard' }).first().click();
    if (browserName === 'chromium') {
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip).toContain(SOCIAL_TEXT);
      expect(clip).toContain('#scifi');
    }
  });

  test('Research tab: per-report toggle + Expand all / Collapse all', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=research`);
    // The linked report shows (project-scoped via research_report_projects_v2).
    const reportToggle = page.getByRole('button', { name: new RegExp(RESEARCH_TOPIC) });
    await expect(reportToggle).toBeVisible({ timeout: 20_000 });

    // Report content full-text only renders inside the expanded region. Expand all → visible.
    const marker = 'Disposable regression research report.';
    await page.getByRole('button', { name: 'Expand all' }).click();
    // whitespace-pre-line full body is present once expanded (line-clamped teaser is truncated w/ ...).
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Collapse all' }).click();
    // After collapse, toggle the single report open again via its own button.
    await reportToggle.click();
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Cost tab: date-range buttons render and switch', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=cost`);
    // token_usage seeded for this project → the dashboard (not the empty state) renders with range buttons.
    const btn30 = page.getByRole('button', { name: '30d', exact: true });
    await expect(btn30).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '7d', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '90d', exact: true })).toBeVisible();
    const allTime = page.getByRole('button', { name: 'All Time', exact: true });
    await expect(allTime).toBeVisible();
    // Switching range re-renders without error; the summary cards stay present.
    await allTime.click();
    await expect(page.getByText('Total Cost')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('API Calls')).toBeVisible();
  });
});
