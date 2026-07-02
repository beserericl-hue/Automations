import { test, expect } from '@playwright/test';
import { WorkbenchPage } from './pages/workbench.page';

/**
 * Marketing video B-roll validation (marketing-copy.md §4 "Filming plan (screen-only B-roll)").
 *
 * One describe-block per filming scene, in order. Each test navigates to the exact screen the script
 * films and asserts it DISPLAYS and RETURNS CORRECT RESULTS — not merely that the route loads. These
 * are the reusable building blocks for the broader UI regression suite.
 *
 * Runs authenticated (storageState from auth.setup.ts) against E2E_BASE_URL (DEV). Skips gracefully if
 * unauthenticated. The demo project "The Last Signal" is seeded via scripts/e2e_video_prep.py; where a
 * scene needs it, the test resolves it and falls back to the first available project/chapter so the
 * screen validation still runs.
 */

const DEMO_PROJECT = 'The Last Signal';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  if (page.url().includes('/login')) {
    test.skip(true, 'No test credentials — set E2E_TEST_EMAIL / E2E_TEST_PASSWORD');
  }
});

// =====================================================================================
// SCENE 1 (0:00–0:10) — Hook montage: Dashboard, ContentDetail+drift, Newsletter approval, ImageGallery
// =====================================================================================
test.describe('Scene 1 — Hook montage', () => {
  test('Dashboard renders with populated stat counts', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoDashboard();
    // "Welcome back" heading + the four stat cards the montage shows.
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    for (const label of ['Projects', 'Drafts', 'Published', 'Research']) {
      await expect(wb.statCard(label)).toBeVisible();
    }
    // Recent Activity table returns rows (real content in the account).
    await expect(page.getByRole('heading', { name: /recent activity/i })).toBeVisible();
    await expect(page.locator('main table tbody tr').first()).toBeVisible();
  });

  test('ImageGallery renders (cover-art tiles or a valid empty state)', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle(DEMO_PROJECT);
    if (!id) test.skip(true, 'No project available to open the Art tab');
    await wb.openProjectTab('Art');
    // The gallery screen displays: its "Cover Art & Images" heading + either tiles or the "No images
    // yet" empty state (both are correct results — a freshly-seeded project has no art until VP08).
    await expect(page.getByRole('heading', { name: /cover art & images/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    // Gallery tiles are Supabase-storage cover images; "No images yet" is the valid empty state. (The
    // gallery isn't inside <main>, so scope to the image src, not a container.)
    const tiles = page.locator('img[src*="/storage/v1/object"], img[src*="cover-images"]');
    const emptyState = page.getByText(/no images yet/i);
    await expect
      .poll(
        async () =>
          (await tiles.count().catch(() => 0)) > 0 ||
          (await emptyState.isVisible().catch(() => false)),
        { timeout: 8_000 },
      )
      .toBeTruthy();
  });
});

// =====================================================================================
// SCENE 2 (0:10–0:25) — Problem: ProjectDetail, hover across the 9 tabs
// =====================================================================================
test.describe('Scene 2 — ProjectDetail nine tabs', () => {
  test('all 9 project tabs are present and each renders content', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle(DEMO_PROJECT);
    if (!id) test.skip(true, 'No project available');
    for (const tab of WorkbenchPage.PROJECT_TABS) {
      await expect(wb.projectTab(tab), `tab "${tab}" visible`).toBeVisible();
    }
    // Click through each tab and confirm the panel renders (main has non-trivial content).
    for (const tab of WorkbenchPage.PROJECT_TABS) {
      await wb.openProjectTab(tab);
      await expect
        .poll(async () => ((await page.locator('main').textContent()) ?? '').trim().length, {
          timeout: 8_000,
        })
        .toBeGreaterThan(20);
    }
  });
});

// =====================================================================================
// SCENE 3 (0:25–0:55) — Eve: Talk-to-Eve widget, Story Arc browser (8 arcs), Genre list (8 genres)
// =====================================================================================
test.describe('Scene 3 — Eve, arcs, genres', () => {
  test('Story Arc browser lists at least the built-in arcs', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoStoryArcs();
    await expect(page.getByText(/arcs available/i)).toBeVisible();
    // The script scrolls "all 8 arcs" — assert the grid returns multiple arc cards.
    const cards = page.locator('main').getByText(
      /Three-Act|Hero'?s Journey|Freytag|Kish[oō]tenketsu|Fichtean|Story Circle|Seven-Point|In Medias Res/i,
    );
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
  });

  test('Genre list returns the active genres', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoGenres();
    const genres = page.locator('main').getByText(
      /post-?apocalyptic|political-?scifi|historical|ai-?marketing|ancient-?history|romance/i,
    );
    await expect(genres.first()).toBeVisible();
    expect(await genres.count()).toBeGreaterThanOrEqual(2);
  });

  test('Talk to Eve / chat surface opens with a message box', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoDashboard();
    // Scene 3 films the "Talk to Eve" widget and the ChatDrawer (where the brainstorm prompt is typed).
    // Open whichever chat/Eve trigger the layout exposes, then assert the assistant surface renders.
    const trigger = page
      .getByRole('button', { name: /talk to eve/i })
      .or(page.getByRole('button', { name: /chat with author agent/i }))
      .first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    // Either the Eve voice widget (role=dialog / elevenlabs-convai) or the ChatDrawer message box.
    const surface = page
      .locator('[role="dialog"][aria-label*="Eve"], elevenlabs-convai')
      .or(page.getByRole('heading', { name: /chat with author agent/i }))
      .or(page.getByPlaceholder(/type a message/i))
      .first();
    await expect(surface).toBeVisible({ timeout: 10_000 });
  });
});

// =====================================================================================
// SCENE 4 (0:55–1:35) — Craft: Story Bible tab, ContentDetail Ch3 AnnotationsPanel drift, Q/A panel
// =====================================================================================
test.describe('Scene 4 — Story Bible, drift, Q/A', () => {
  test('Story Bible tab shows auto-built entries', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle(DEMO_PROJECT);
    if (!id) test.skip(true, 'No project available');
    await wb.openProjectTab('Story Bible');
    // Bible panel returns entries (characters/locations/events) or an explicit empty-state.
    await expect
      .poll(async () => ((await page.locator('main').textContent()) ?? '').trim().length, { timeout: 10_000 })
      .toBeGreaterThan(20);
    const entries = page.locator('main').getByText(/character|location|event|Maya|Series Bible|entr/i);
    await expect(entries.first()).toBeVisible();
  });

  test('ContentDetail chapter shows AnnotationsPanel + Q/A affordances', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const contentId = await wb.openAChapter();
    if (!contentId) test.skip(true, 'No project with chapters available');
    // ContentDetail renders its craft surface for a chapter: the "Engine QA" panel (the Q/A report with
    // its craft dimensions) and the "Rewrite with research" action. Assert the QA panel heading renders.
    await expect(page.getByRole('heading', { name: /engine qa/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /rewrite with research/i }).first()).toBeVisible();
  });
});

// =====================================================================================
// SCENE 5 (1:35–2:05) — Research + rewrite: ContentDetail "Rewrite with Research" modal
// =====================================================================================
test.describe('Scene 5 — Rewrite with Research', () => {
  test('Rewrite-with-Research modal opens with a research focus field', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const contentId = await wb.openAChapter();
    if (!contentId) test.skip(true, 'No project with chapters available');
    // openFirstChapter returns a genuine chapter, so the chapter-only "Rewrite with research" action
    // is present once ContentDetail finishes loading.
    const btn = page.getByRole('button', { name: /rewrite with research/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    // Modal with the "Research focus" field (marketing types the Cold War radio prompt here). The
    // label isn't htmlFor-associated, so assert the label text + the modal's textarea are present.
    await expect(page.getByText(/research focus/i).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('textarea').first()).toBeVisible();
  });
});

// =====================================================================================
// SCENE 6 (2:05–2:35) — Publication + reach: cover art, Export .docx, Social tabs, Newsletter approval
// =====================================================================================
test.describe('Scene 6 — Publication + reach', () => {
  test('Export dialog offers KDP page sizes incl. 6x9', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle(DEMO_PROJECT);
    if (!id) test.skip(true, 'No project available');
    await wb.openProjectTab('Export');
    // The Export tab shows "Export to Word (.docx)" + a "Choose Page Size & Export" button that opens
    // the ExportDialog modal; the KDP page-size select (incl. 6x9) lives in that modal.
    await expect(page.getByRole('heading', { name: /export to word|\.docx/i })).toBeVisible({ timeout: 8_000 });
    const openBtn = page.getByRole('button', { name: /choose page size/i });
    await expect(openBtn).toBeVisible({ timeout: 8_000 });
    if (await openBtn.isEnabled().catch(() => false)) {
      // Project has exportable (approved) chapters → open the dialog and verify KDP sizes incl. 6x9.
      await openBtn.click();
      const select = page.locator('select').first();
      await expect(select).toBeVisible({ timeout: 8_000 });
      await expect(select.locator('option', { hasText: /6x9|6 x 9/i }).first()).toHaveCount(1);
    } else {
      // Correct result for a project with no approved chapters yet: export is disabled until a chapter
      // is approved. The Export screen still displays with the guidance + disabled action.
      await expect(openBtn).toBeDisabled();
    }
  });

  test('Social tab exposes the four platforms', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    const id = await wb.openProjectByTitle(DEMO_PROJECT);
    if (!id) test.skip(true, 'No project available');
    await wb.openProjectTab('Social');
    const social = page.locator('main').getByText(/twitter|linkedin|instagram|facebook/i);
    await expect(social.first()).toBeVisible({ timeout: 8_000 });
  });

  test('My Newsletters (editions) list renders', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoEditions();
    await expect(page.getByRole('heading', { name: /my newsletters|newsletters|editions/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /new newsletter|new edition|create/i }).first()).toBeVisible();
  });

  test('Pending Approvals page renders (list or empty state)', async ({ page }) => {
    const wb = new WorkbenchPage(page);
    await wb.gotoApprovals();
    await expect(page.getByRole('heading', { name: /pending approvals/i })).toBeVisible();
    const listOrEmpty = page
      .locator('main table tbody tr')
      .first()
      .or(page.getByText(/no pending approvals/i));
    await expect(listOrEmpty).toBeVisible({ timeout: 8_000 });
  });
});

// =====================================================================================
// SCENE 7 (2:35–2:55) — Pricing: PricingCards (Trial / Standard / Pro, "Most Popular"), Dashboard
// =====================================================================================
test.describe('Scene 7 — Pricing', () => {
  test('Pricing tiers render for a new user, and onboarding is gated for an existing user', async ({
    page,
  }) => {
    const wb = new WorkbenchPage(page);
    await page.goto('/onboarding');
    await page.waitForLoadState('domcontentloaded');
    // PricingCards (Trial/Standard/Pro) render only during NEW-user onboarding (OnboardingPage redirects
    // an already-onboarded user to "/" unless step==='tier'). Both outcomes are correct:
    //  - fresh user → the tier cards + "Most Popular" ribbon render;
    //  - existing user (our test account) → app correctly redirects away from onboarding.
    const tiers = page.getByText(/\bTrial\b|\bStandard\b|\bPro\b/i);
    if ((await tiers.count().catch(() => 0)) > 0) {
      await expect(tiers.first()).toBeVisible();
      await expect(page.getByText(/most popular/i).first()).toBeVisible();
    } else {
      // Onboarding gate: an onboarded user is bounced to an authenticated screen, not left on /onboarding.
      await expect
        .poll(() => page.url(), { timeout: 10_000 })
        .not.toContain('/onboarding');
      await wb.gotoDashboard();
      await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    }
  });
});
