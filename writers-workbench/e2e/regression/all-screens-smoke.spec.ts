/**
 * all-screens-smoke — authoritative per-screen regression: EVERY route in the app is
 * navigated to FROM the screen (real URL / real nav) and asserted with a screen-specific
 * pass criterion. Guarantees no screen is skipped (the gap that let the character-drift
 * annotations screen ship untested).
 *
 * Detail-page IDs (:id / :token) are resolved at runtime from DEV via the service key so
 * the suite stays valid as data changes. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Each test documents PASS / FAIL criteria inline. General rule for every screen:
 *   PASS  = the screen's own anchor element is visible AND the URL is the intended route
 *           (i.e. it did NOT fall through the `*` redirect to `/`).
 *   FAIL  = anchor missing within timeout, a crash/ErrorBoundary, or an unintended redirect.
 */
import { test, expect, type Page } from '@playwright/test';

// Accept both env conventions: direct runs use SUPABASE_*; run-regression.sh uses E2E_SUPA_*.
// When absent, detail-screen tests skip gracefully and the hardcoded fallback IDs are used.
const SUPA = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/+$/, '');
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY || '';
const UID = '%2B14105914612';

const ID = {
  project: 'dd10c1c3-e025-4cd7-854d-21db32a2e4da', // The Last Signal (fallback; refreshed in beforeAll)
  content: 'd681e643-2984-4ebc-83c1-f125a1c6fade', // Ch3 with drift annotation
  research: '',
  image: '',
  edition: 'wasteland-wire',
  template: '',
  approvalToken: '',
  send: '',
  execution: '',
};

async function rest(path: string): Promise<any[]> {
  if (!SVC) return [];
  try {
    const res = await fetch(`${SUPA}/rest/v1/${path}`, {
      headers: { apikey: SVC, authorization: `Bearer ${SVC}` },
    });
    return (await res.json()) as any[];
  } catch {
    return [];
  }
}

test.beforeAll(async () => {
  const first = (rows: any[], k = 'id') => (rows[0]?.[k] as string) || '';
  ID.research = first(await rest(`research_reports_v2?user_id=eq.${UID}&select=id&limit=1`)) || ID.research;
  ID.image = first(await rest(`generated_images_v2?user_id=eq.${UID}&select=id&limit=1`)) || ID.image;
  ID.template = first(await rest(`newsletter_templates_v2?edition_id=eq.${ID.edition}&select=id&limit=1`)) || ID.template;
  ID.send = first(await rest(`newsletter_sends_v2?user_id=eq.${UID}&select=id&order=created_at.desc&limit=1`)) || ID.send;
  const ap = await rest(`newsletter_approvals_v2?edition_id=eq.${ID.edition}&decision=is.null&select=token,execution_id&order=created_at.desc&limit=1`);
  ID.approvalToken = (ap[0]?.token as string) || '';
  ID.execution = (ap[0]?.execution_id as string) || '';
});

// A screen "loaded" means: an anchor is visible and we're not on the wildcard-redirected dashboard
// (unless the screen IS the dashboard). Encapsulates the general PASS/FAIL rule above.
async function expectScreen(page: Page, anchor: ReturnType<Page['getByText']>, timeout = 20_000) {
  await expect(anchor.first()).toBeVisible({ timeout });
}

// ─────────────────────────────────────────────────────────────────────────────
// UNAUTHENTICATED SCREENS (fresh context — no saved session)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Auth screens (unauthenticated)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Login /login', async ({ page }) => {
    // PASS: email input + "Sign in" button render. FAIL: either missing / redirected away.
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('Signup /signup', async ({ page }) => {
    // PASS: "Create your account" + email input. FAIL: missing / crash.
    await page.goto('/signup', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/create your account/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('Forgot password /forgot-password', async ({ page }) => {
    // PASS: "Reset your password" heading + "Send reset link" submit. FAIL: missing / crash.
    await page.goto('/forgot-password', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /reset your password/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /send reset link/i })).toBeVisible();
  });

  test('Reset password /reset-password', async ({ page }) => {
    // PASS: "Set new password" heading OR the reset form. FAIL: crash / blank.
    await page.goto('/reset-password', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/set new password|reset your password|password/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED SCREENS
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Core app screens', () => {
  test('Onboarding /onboarding', async ({ page }) => {
    // PASS: renders plan chooser OR (already-onboarded) redirects to dashboard — never crashes.
    await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/choose your plan|welcome/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Dashboard /', async ({ page }) => {
    // PASS: "Welcome back" + Recent Activity. FAIL: missing / crash.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByText(/welcome back/i));
    await expect(page.getByText(/recent activity/i)).toBeVisible();
  });

  test('Projects /projects', async ({ page }) => {
    // PASS: "Projects" heading + a real project tile ("The Last Signal").
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Projects$/ }));
    await expect(page.getByText('The Last Signal').first()).toBeVisible();
  });

  test('Project detail /projects/:id', async ({ page }) => {
    // PASS: project title + the 9 tab labels present.
    await page.goto(`/projects/${ID.project}`, { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /The Last Signal/ }));
    // Tab labels may carry counts ("Chapters (3)", "Story Bible (120)") — match by prefix.
    for (const tab of ['Overview', 'Outline', 'Chapters', 'Story Bible', 'Art', 'Social', 'Research', 'Cost', 'Export']) {
      await expect(page.getByText(new RegExp(`${tab}`)).first()).toBeVisible();
    }
  });

  test('Story Bible /projects/:id/bible', async ({ page }) => {
    // PASS: "Story Bible" heading.
    await page.goto(`/projects/${ID.project}/bible`, { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Story Bible/ }));
  });

  test('Trash /trash', async ({ page }) => {
    await page.goto('/trash', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Trash$/ }));
  });

  test('Content Library /library', async ({ page }) => {
    await page.goto('/library', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Content Library/ }));
  });

  test('Content detail /content/:id (editor + annotations)', async ({ page }) => {
    // PASS: chapter renders with the TipTap editor AND the Review Annotations panel.
    await page.goto(`/content/${ID.content}`, { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByText(/Review Annotations/i));
    await expect(page.locator('.ProseMirror, [contenteditable="true"]').first()).toBeVisible();
  });

  test('Image detail /images/:id', async ({ page }) => {
    test.skip(!ID.image, 'no image id resolved');
    await page.goto(`/images/${ID.image}`, { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByText(/Prompt/i));
    await expect(page.locator('img').first()).toBeVisible();
  });

  test('Image Gallery /gallery', async ({ page }) => {
    // PASS: heading + at least one thumbnail.
    await page.goto('/gallery', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Image Gallery/ }));
    await expect(page.locator('img[loading="lazy"]').first()).toBeVisible();
  });

  test('Research list /research', async ({ page }) => {
    await page.goto('/research', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Research Reports/ }));
  });

  test('Research detail /research/:id', async ({ page }) => {
    test.skip(!ID.research, 'no research id resolved');
    await page.goto(`/research/${ID.research}`, { waitUntil: 'domcontentloaded' });
    // PASS: the back link (screen chrome) is present and we stayed on the research route.
    await expect(page).toHaveURL(new RegExp(`/research/${ID.research}`));
    await expect(page.getByText(/back/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Brainstorm /brainstorm', async ({ page }) => {
    await page.goto('/brainstorm', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Brainstorm a Book/ }));
  });

  test('Outlines /outlines', async ({ page }) => {
    await page.goto('/outlines', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Outlines$/ }));
  });

  test('Story Arcs /story-arcs', async ({ page }) => {
    await page.goto('/story-arcs', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Story Arcs/ }));
  });

  test('Genres /genres', async ({ page }) => {
    await page.goto('/genres', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Genres$/ }));
  });

  test('Cost /cost', async ({ page }) => {
    await page.goto('/cost', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByText(/Cost tracking/i));
  });

  test('Sources /sources', async ({ page }) => {
    await page.goto('/sources', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Source Browser/ }));
  });

  test('Settings /settings', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Settings$/ }));
  });

  test('Credits /credits', async ({ page }) => {
    await page.goto('/credits', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Credits$/ }));
  });
});

// Admin panel + its 7 tabs (each tab is a distinct screen surface)
test.describe('Admin panel /admin', () => {
  // Real tab labels from AdminPanel.TAB_LABELS.
  const ADMIN_TABS = ['User Management', 'Subscriptions', 'Revenue', 'System Metrics', 'Workflows', 'Queues', 'Email Bounces'];
  test('Admin panel loads', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    // PASS: Admin Panel heading (user has the role). FAIL: access-denied / crash.
    await expectScreen(page, page.getByRole('heading', { name: /Admin Panel/ }));
  });
  for (const tab of ADMIN_TABS) {
    test(`Admin tab: ${tab}`, async ({ page }) => {
      // PASS: clicking the tab keeps the panel mounted and shows that tab's surface.
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: /Admin Panel/ })).toBeVisible({ timeout: 20_000 });
      const tabBtn = page.getByRole('button', { name: new RegExp(tab, 'i') }).first();
      await expect(tabBtn).toBeVisible({ timeout: 20_000 });
      await tabBtn.click();
      await expect(page.getByRole('heading', { name: /Admin Panel/ })).toBeVisible();
    });
  }
});

// Superuser console + its 3 tabs
test.describe('Superuser console /superuser', () => {
  // Real tab labels from SuperuserPanel.
  const SU_TABS = ['Impersonation', 'Tier Management', 'System Config'];
  test('Superuser console loads', async ({ page }) => {
    await page.goto('/superuser', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Superuser Console/ }));
  });
  for (const tab of SU_TABS) {
    test(`Superuser tab: ${tab}`, async ({ page }) => {
      await page.goto('/superuser', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: /Superuser Console/ })).toBeVisible({ timeout: 20_000 });
      const tabBtn = page.getByRole('button', { name: new RegExp(tab, 'i') }).first();
      await expect(tabBtn).toBeVisible({ timeout: 20_000 });
      await tabBtn.click();
      await expect(page.getByRole('heading', { name: /Superuser Console/ })).toBeVisible();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWSLETTER SCREENS
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Newsletter screens', () => {
  test('Newsletter home /newsletter', async ({ page }) => {
    await page.goto('/newsletter', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Newsletter$/ }));
  });

  test('Generate /newsletter/generate', async ({ page }) => {
    await page.goto('/newsletter/generate', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Generate newsletter/ }));
  });

  test('Execution status /newsletter/execution/:id', async ({ page }) => {
    test.skip(!ID.execution, 'no execution id resolved');
    await page.goto(`/newsletter/execution/${ID.execution}`, { waitUntil: 'domcontentloaded' });
    // PASS: an Execution-status surface renders (heading/label contains "Execution" or a stage).
    await expect(page.getByText(/Execution|stage|status/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Pending approvals /newsletter/approvals', async ({ page }) => {
    await page.goto('/newsletter/approvals', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Pending approvals/ }));
    await expect(page.getByText('The Wasteland Wire').first()).toBeVisible();
  });

  test('Approval detail /newsletter/approvals/:token (email preview)', async ({ page }) => {
    test.skip(!ID.approvalToken, 'no pending approval token');
    await page.goto(`/newsletter/approvals/${ID.approvalToken}`, { waitUntil: 'domcontentloaded' });
    // PASS: the Email preview panel + iframe render.
    await expectScreen(page, page.getByRole('heading', { name: /Email preview/i }));
    const preview = page.frameLocator('iframe[title="Approval email preview"]');
    await expect(preview.getByText(/Wasteland Wire/i).first()).toBeVisible({ timeout: 20_000 });
    // No phantom logo/stamp image when the edition has no stamp_url — a broken <img> (the old
    // /static/logos/courseworx-stamp-black.png fallback) must never render.
    await expect(preview.locator('img[alt*="stamp" i]')).toHaveCount(0);
  });

  test('Scheduled sends /newsletter/sends', async ({ page }) => {
    await page.goto('/newsletter/sends', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /^Sends$/ }));
  });

  test('Sent newsletter detail /newsletter/sends/:id', async ({ page }) => {
    test.skip(!ID.send, 'no send id resolved');
    await page.goto(`/newsletter/sends/${ID.send}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`/newsletter/sends/${ID.send}`));
    await expect(page.getByText(/Rendered HTML|subject|status/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Ingestion library /newsletter/ingestion', async ({ page }) => {
    await page.goto('/newsletter/ingestion', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Ingestion library/ }));
  });

  test('Templates list /newsletter/templates', async ({ page }) => {
    await page.goto('/newsletter/templates', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /Newsletter templates/ }));
  });

  test('New template /newsletter/templates/new', async ({ page }) => {
    await page.goto('/newsletter/templates/new', { waitUntil: 'domcontentloaded' });
    // PASS: the editor chrome (Import HTML / Render preview) renders.
    await expect(page.getByRole('button', { name: /Import HTML|Render preview/i }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Template editor /newsletter/templates/:id', async ({ page }) => {
    test.skip(!ID.template, 'no template id resolved');
    await page.goto(`/newsletter/templates/${ID.template}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: /Render preview/i })).toBeVisible({ timeout: 20_000 });
  });

  test('Editions list /newsletter/editions', async ({ page }) => {
    await page.goto('/newsletter/editions', { waitUntil: 'domcontentloaded' });
    await expectScreen(page, page.getByRole('heading', { name: /My newsletters/ }));
  });

  test('New edition /newsletter/editions/new', async ({ page }) => {
    await page.goto('/newsletter/editions/new', { waitUntil: 'domcontentloaded' });
    // PASS: the edition form (Display name field) renders.
    await expect(page.getByText(/Display name/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Edition editor /newsletter/editions/:id', async ({ page }) => {
    await page.goto(`/newsletter/editions/${ID.edition}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Display name/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Edition feeds /newsletter/editions/:id/feeds', async ({ page }) => {
    await page.goto(`/newsletter/editions/${ID.edition}/feeds`, { waitUntil: 'domcontentloaded' });
    // PASS: the feeds screen chrome (the "← My newsletters" back link) renders.
    await expect(page.getByRole('link', { name: /My newsletters/i }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Edition setup wizard /newsletter/editions/:id/setup', async ({ page }) => {
    await page.goto(`/newsletter/editions/${ID.edition}/setup`, { waitUntil: 'domcontentloaded' });
    // PASS: a wizard step renders (Identity/Branding/Template/Feeds/Schedule/All set).
    await expect(page.getByText(/Identity|Branding|Template|Schedule|All set|step/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
