/**
 * User Manual Screenshot Capture
 *
 * Walks every screen in the production UI and saves a full-page screenshot.
 * Output: writers-workbench/docs/screenshots/<screen-name>.png
 *
 * Run:
 *   npx playwright test e2e/capture-manual-screenshots.spec.ts --project=chromium
 *
 * Capture against production:
 *   E2E_BASE_URL=https://writersworkbench-production.up.railway.app \
 *   npx playwright test e2e/capture-manual-screenshots.spec.ts --project=chromium
 *
 * Capture in dark mode:
 *   CAPTURE_THEME=dark npx playwright test e2e/capture-manual-screenshots.spec.ts --project=chromium
 *
 * Requires E2E_TEST_EMAIL and E2E_TEST_PASSWORD env vars (already used by auth.setup).
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SHOTS_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const THEME = (process.env.CAPTURE_THEME || 'light') as 'light' | 'dark';

// Sample IDs (override via env if needed for non-Eric accounts)
const SAMPLE_PROJECT_ID = process.env.SAMPLE_PROJECT_ID || '366ca0a0-18e8-45a5-83da-a6b3d23d760b'; // The Invisible Wall
const SAMPLE_CONTENT_ID = process.env.SAMPLE_CONTENT_ID || 'd91a5aad-3daf-43d0-96bb-07437f6e26c0'; // a chapter

// Ensure output directory exists
fs.mkdirSync(SHOTS_DIR, { recursive: true });

/**
 * Navigate, wait for content to settle, capture a full-page PNG.
 */
async function shoot(page: Page, name: string, opts?: { fullPage?: boolean; waitFor?: string }) {
  const file = path.join(SHOTS_DIR, `${THEME === 'dark' ? 'dark-' : ''}${name}.png`);
  if (opts?.waitFor) {
    await page.waitForSelector(opts.waitFor, { timeout: 10_000 }).catch(() => {});
  }
  // Brief settle delay for animations / lazy-loaded content
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: file, fullPage: opts?.fullPage ?? true });
  console.log(`  📸 ${path.basename(file)}`);
}

/**
 * Apply the requested theme by writing to localStorage before page load.
 */
async function applyTheme(page: Page) {
  if (THEME === 'dark') {
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
      document.documentElement.classList.add('dark');
    });
  }
}

test.describe('User Manual Screenshots', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await applyTheme(page);
  });

  test('01 — login page (unauthenticated)', async ({ browser }) => {
    // Use a fresh context with NO auth so login form is visible
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: [], origins: [] },  // explicit empty state
    });
    const page = await ctx.newPage();
    await applyTheme(page);

    try {
      await page.goto('/login', { timeout: 15_000 });
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
      await shoot(page, '02-login', { waitFor: 'input[type="email"]' });

      await page.goto('/signup', { timeout: 15_000 });
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 }).catch(() => {});
      await shoot(page, '02-signup');

      await page.goto('/forgot-password', { timeout: 15_000 });
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 }).catch(() => {});
      await shoot(page, '02-forgot-password');
    } catch (err) {
      console.log('  ⚠️  unauthenticated capture partial:', (err as Error).message);
    } finally {
      await ctx.close();
    }
  });

  test('05 — dashboard', async ({ page }) => {
    await page.goto('/');
    await shoot(page, '05-dashboard', { waitFor: 'text=Dashboard' });
  });

  test('06 — projects list', async ({ page }) => {
    await page.goto('/projects');
    await shoot(page, '06-projects-list', { waitFor: 'text=My Projects, text=All Projects' });
  });

  test('07 — project workspace tabs', async ({ page }) => {
    test.setTimeout(180_000); // 9 tabs × ~10s each
    const tabs = ['overview', 'outline', 'chapters', 'bible', 'art', 'social', 'research', 'cost', 'export'];
    for (const tab of tabs) {
      try {
        await page.goto(`/projects/${SAMPLE_PROJECT_ID}?tab=${tab}`, { timeout: 15_000 });
        await shoot(page, `07-project-tab-${tab}`);
      } catch (err) {
        console.log(`  ⚠️  skipped tab ${tab}:`, (err as Error).message.split('\n')[0]);
      }
    }
  });

  test('08 — content library + filters', async ({ page }) => {
    test.setTimeout(90_000);
    for (const [name, url] of [
      ['08-library-all', '/library'],
      ['08-library-chapters', '/library?type=chapter'],
      ['08-library-blog-posts', '/library?type=blog_post'],
    ] as const) {
      try {
        await page.goto(url, { timeout: 15_000 });
        await shoot(page, name);
      } catch (err) {
        console.log(`  ⚠️  skipped ${name}:`, (err as Error).message.split('\n')[0]);
      }
    }
  });

  test('09 — content editor', async ({ page }) => {
    await page.goto(`/content/${SAMPLE_CONTENT_ID}`);
    // Wait for editor to mount
    await page.waitForSelector('.ProseMirror, [contenteditable]', { timeout: 15_000 }).catch(() => {});
    await shoot(page, '09-content-editor');
  });

  test('10 — brainstorm form', async ({ page }) => {
    await page.goto('/brainstorm');
    await shoot(page, '10-brainstorm-form', { waitFor: 'input, select' });
  });

  test('10b — brainstorm form filled with Political Comedy walkthrough', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/brainstorm');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Fill the Step 1 concept text. Disguised sample — fictional novel.
    const concept = [
      'Title: Term Limits',
      '',
      'Premise: When a populist senator dies mid-vote, his estranged daughter — a stand-up comedian who has spent a decade roasting him from a Brooklyn basement — is appointed to fill his seat. Sworn in on a Tuesday, she discovers by Friday that her late father had been blackmailing the Speaker of the House for fifteen years, and the leverage now sits in a manila folder in her freshman office.',
      '',
      'Main characters:',
      '- Joey "JoJo" Halloran — 34, comedian, the new senator. Sharp, unimpressed, allergic to scripts.',
      '- Speaker Margaret Vance — 61, calculating, has spent two decades being the smartest person in every room except her therapist\'s.',
      '- Chief of Staff Wendell — 52, inherited from her father, knows where every body is buried and which of them are still breathing.',
      '- Press Secretary Imani — 28, a former White House intern who treats the briefing room like a venue.',
      '',
      'Tone: dry political satire in the tradition of Veep and Thank You for Smoking — not mean, just unflinching. Comedy of competence and incompetence in equal measure.',
      '',
      'Suggested chapter structure: 12 chapters covering swearing-in, discovery of the folder, first leverage play, media leak, Speaker\'s counterattack, family revelation, midterm election, climax in the Senate cloakroom.',
    ].join('\n');

    const conceptField = page.getByPlaceholder(/paste your book idea/i);
    await conceptField.fill(concept);

    // Step 2: title + chapter count + genre + arc + themes.
    // We DON'T submit — just fill the visible Step-2 fields so the screenshot
    // demonstrates what each field expects.
    await page.getByPlaceholder('Book title').fill('Term Limits');
    await page.getByPlaceholder('e.g. 15').fill('12');

    // Genre + Story Arc dropdowns are optional for the capture — we skip
    // selecting them rather than create or pick something tier-specific.
    // (The empty form already shows the dropdown options.)

    // Themes — add four chips.
    const themeInput = page.getByPlaceholder('Add a theme...');
    for (const theme of ['satire', 'power', 'media', 'idealism vs cynicism']) {
      await themeInput.fill(theme);
      await themeInput.press('Enter');
    }

    // Scroll to the top so the screenshot is anchored consistently.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await shoot(page, '10b-brainstorm-filled-political-comedy');
  });

  test('11 — outlines list', async ({ page }) => {
    await page.goto('/outlines');
    await shoot(page, '11-outlines-list');
  });

  test('12 — genres', async ({ page }) => {
    await page.goto('/genres');
    await shoot(page, '12-genres-list', { waitFor: 'text=/Genre/i' });
  });

  test('12a — genre form (empty) + 12b — filled with Political Comedy', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/genres');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Open the inline create form.
    await page.getByRole('button', { name: /\+ New Genre/i }).click();
    await page.waitForSelector('input[placeholder*="Post-Apocalyptic" i]', { timeout: 10_000 });
    await shoot(page, '12a-genre-form-empty');

    // Fill with Political Comedy values, demonstrating each field. We do NOT
    // click Save — this is a form-fill demo only, no row created in PROD.
    await page.getByPlaceholder(/Post-Apocalyptic Science Fiction/i).fill('Political Comedy');
    // Slug auto-derives from name on first edit; leave the auto-filled value.

    await page
      .getByPlaceholder(/Stories set after civilization-ending events/i)
      .fill(
        'Sharp, character-driven satire set in and around modern political institutions — campaign trails, congressional hallways, war rooms, late-night greenrooms. Tone is dry and observational; the humor comes from competence colliding with vanity, not from caricature. Influences: Veep, Thank You for Smoking, Primary Colors, The Thick of It.',
      );

    await page
      .getByPlaceholder(/post-apocalyptic, dystopian, survival/i)
      .fill('political satire, dry humor, congressional intrigue, campaign trail, dark comedy, media circus, partisan absurdity');

    // Helper: fill an ArrayField. The form starts each list with one default
    // empty row; fill that one first, then click "+ Add" for each subsequent
    // value. inputSelector targets the row inputs by their placeholder.
    async function fillArrayField(addBtnText: string, inputSelector: string, values: string[]) {
      const addBtn = page.locator(`button:has-text("${addBtnText}")`).first();
      for (let i = 0; i < values.length; i++) {
        if (i > 0) await addBtn.click();
        const rows = page.locator(inputSelector);
        await rows.nth(i).fill(values[i]);
      }
    }

    // RSS feed URLs — political-satire feeds. (Discovery sources for the
    // future newsletter ingestion pipeline.)
    await fillArrayField('+ Add rss feed url', 'input[placeholder*="medium.com/feed" i]', [
      'https://www.theonion.com/rss',
      'https://www.mcsweeneys.net/rss',
      'https://reductress.com/feed/',
    ]);

    // Source URLs — political-comedy article archives.
    await fillArrayField('+ Add source url', 'input[placeholder*="reddit.com" i]', [
      'https://www.politico.com/',
      'https://www.thebulwark.com/',
    ]);

    // Subreddit names.
    await fillArrayField('+ Add subreddit name', 'input[placeholder*="PostApocalypticFiction" i]', [
      'PoliticalHumor',
      'TheThickOfIt',
    ]);

    // Goodreads shelves. Note placeholder "post-apocalyptic" also matches the
    // top-level Slug field — locator returns slug + keywords + shelves; nth()
    // skips past those because the array's empty default row is appended LAST
    // in DOM order, so .nth(2) (slug, keywords, then array idx 0) is the
    // first shelf row. We narrow with a parent locator instead to keep it
    // robust against layout changes.
    const goodreadsSection = page.locator('section, div').filter({ hasText: 'Goodreads Shelves' }).last();
    const goodreadsAdd = goodreadsSection.getByRole('button', { name: /\+ Add goodreads/i });
    const goodreadsInputs = goodreadsSection.locator('input[placeholder*="post-apocalyptic" i]');
    for (let i = 0; i < 2; i++) {
      if (i > 0) await goodreadsAdd.click();
      await goodreadsInputs.nth(i).fill(['political-satire', 'comedy'][i]);
    }

    // Writing guidelines.
    await page
      .getByPlaceholder(/Tone: gritty, visceral, intimate/i)
      .fill(
        'Tone: dry, observational, professional. Avoid caricature — characters should be competent at their jobs and the humor should emerge from their incentives, not from making them stupid. Avoid partisan editorializing — both parties should look human, foolish, and occasionally dignified by turns. Pacing: scene-driven, dialogue-heavy. Episodes should function like late-night sketches connected by character continuity. Assume an adult audience familiar with how legislative process actually works.',
      );

    // Form is taller than viewport and lives inside a scroll container.
    // Use scrollIntoViewIfNeeded on specific anchor elements to reliably
    // position the form, then take viewport-sized stills (1440×900).
    // Top anchor: the "New Genre" heading. Bottom anchor: the Active checkbox
    // at the form's tail.
    await page.getByRole('heading', { name: /^New Genre$/i }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page, '12b-genre-form-filled-top', { fullPage: false });

    await page.getByText(/Active/i).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page, '12b-genre-form-filled-bottom', { fullPage: false });

    // Cancel back to the list — does NOT save.
    const cancelBtn = page.getByRole('button', { name: /cancel/i }).first();
    if (await cancelBtn.count() > 0) {
      await cancelBtn.click();
    }
  });

  test('13 — story arcs', async ({ page }) => {
    await page.goto('/story-arcs');
    await shoot(page, '13-story-arcs');
  });

  test('14 — research list and detail', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/research', { timeout: 15_000 });
    await shoot(page, '14-research-list');

    // Open the first research report if any exist
    try {
      const firstRow = page.locator('table tbody tr, [role="row"]').first();
      if (await firstRow.count() > 0) {
        await firstRow.click({ timeout: 5_000 });
        await page.waitForURL(/\/research\/[a-f0-9-]+/, { timeout: 10_000 });
        await shoot(page, '14-research-detail');
      }
    } catch (err) {
      console.log('  ⚠️  skipped research detail:', (err as Error).message.split('\n')[0]);
    }
  });

  test('15 — sources browser', async ({ page }) => {
    await page.goto('/sources');
    await shoot(page, '15-sources');
  });

  test('16 — cost tracking', async ({ page }) => {
    await page.goto('/cost');
    await shoot(page, '16-cost-tracking', { waitFor: 'text=/Cost|Token|Spend/i' });
  });

  test('17 — trash', async ({ page }) => {
    await page.goto('/trash');
    await shoot(page, '17-trash');
  });

  test('18 — settings', async ({ page }) => {
    await page.goto('/settings');
    await shoot(page, '18-settings', { waitFor: 'text=/Settings|Account|Theme/i' });
  });

  test('19 — admin panel (admin only — may show 403)', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await shoot(page, '19-admin');
  });

  test('20 — chat with Eve drawer (open)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Click the chat icon in the top bar to open the drawer
    const chatTrigger = page.locator(
      'button[aria-label*="Chat" i], button[aria-label*="Eve" i], button[title*="Chat" i]'
    ).first();
    if (await chatTrigger.count() > 0) {
      await chatTrigger.click();
      await page.waitForTimeout(600);
    }
    await shoot(page, '20-chat-drawer-open', { fullPage: false });
  });

  test('21 — Eve voice widget (popover open)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Click "Talk to Eve" in the sidebar
    const eveBtn = page.locator('button:has-text("Talk to Eve")').first();
    if (await eveBtn.count() > 0) {
      await eveBtn.click();
      await page.waitForTimeout(1500); // widget needs time to mount
    }
    await shoot(page, '21-eve-widget-open', { fullPage: false });
  });

  test('23 — global search (Cmd+K)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Trigger Cmd+K (or Ctrl+K)
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+K' : 'Control+K');
    await page.waitForTimeout(400);
    await shoot(page, '23-global-search', { fullPage: false });
  });

  test('after — write index file', async () => {
    // Generate an index.md so the docs folder is self-documenting
    const files = fs.readdirSync(SHOTS_DIR).filter(f => f.endsWith('.png')).sort();
    const indexPath = path.join(SHOTS_DIR, 'INDEX.md');
    const lines = [
      '# Manual Screenshots',
      '',
      `Captured: ${new Date().toISOString()}  `,
      `Theme: ${THEME}  `,
      `Viewport: 1440×900  `,
      `Source: \`e2e/capture-manual-screenshots.spec.ts\``,
      '',
      '## Files',
      '',
      ...files.map(f => `- ![${f}](./${f})`),
    ];
    fs.writeFileSync(indexPath, lines.join('\n'));
    console.log(`  📝 wrote ${indexPath}`);
  });
});
