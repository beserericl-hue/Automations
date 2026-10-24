import { test, expect } from '@playwright/test';
import { apiClient, deleteProject, seedProject, supaDelete, supaGet } from './pages/api';

/**
 * A book's public landing page, as a stranger sees it: no session, no app bundle, a form that
 * stores a reservation the author can read.
 *
 * Runs unauthenticated. The full path needs a database, so it seeds a disposable project carrying
 * a saved landing page, publishes it through the real API (as the author), visits it with no
 * session, reserves a copy, and checks the row. It then hard-deletes the project, which cascades
 * to the reservations. Without a service key (as in CI) only the database-free checks run.
 */

const configured = Boolean(
  process.env.E2E_TEST_EMAIL &&
    (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL) &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY),
);

const HOOK = 'A test page for a book that does not exist.';

function landingFixture(title: string) {
  return {
    id: 'e2e',
    created_at: new Date().toISOString(),
    sample_url: null,
    sample: null,
    plan: [
      { kind: 'hero', cta: true },
      { kind: 'story', cta: false },
      { kind: 'offer', cta: false },
      { kind: 'author', cta: false },
      { kind: 'closing', cta: true },
    ],
    skipped: [],
    warnings: [],
    prompt: '',
    facts_audit: [],
    rejected_facts: [],
    validation: { ok: true, findings: [], facts: {} },
    copy: {
      title,
      author: 'E2E Author',
      hook: HOOK,
      blurb: 'The blurb of a book written only for a test.',
      backCover: 'The back cover of the same.',
      volumes: [{ index: 1, hook: HOOK }],
      bio: 'E2E Author is a fixture.',
      facts: [],
      images: [],
      form: {
        heading: 'Reserve your copy',
        lede: `Leave your name and email to reserve your copy of ${title}. We will write to you when it is released.`,
        button: 'Reserve my copy',
        fields: ['First name', 'Email'],
      },
      seo: { title: `${title}: a novel by E2E Author`, description: HOOK, keywords: [] },
    },
  };
}

test('an address that is not a book slug is a plain 404', async ({ request }) => {
  const res = await request.get('/books/Not%20A%20Slug');
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain('This page is not available');
});

test.describe('a published book page', () => {
  // One project, published, used, then taken down: these steps depend on each other's order.
  test.describe.configure({ mode: 'serial' });
  test.skip(!configured, 'Needs E2E_TEST_EMAIL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');

  let projectId = '';
  let slug = '';
  const title = `E2E Landing ${Date.now()}`;

  test.beforeAll(async () => {
    projectId = await seedProject({ title, outline: { _landing_page: landingFixture(title) } });
    const api = await apiClient();
    const res = await api.post(`/api/landing-page/project/${projectId}/publish`);
    expect(res.ok(), await res.text()).toBe(true);
    const body = await res.json();
    slug = body.data.slug;
    await api.dispose();
  });

  test.afterAll(async () => {
    if (!projectId) return;
    await supaDelete('landing_page_reservations_v2', `project_id=eq.${projectId}`);
    await deleteProject(projectId);
  });

  test('takes its address from the title, and anyone can read it', async ({ page }) => {
    expect(slug).toBe(title.toLowerCase().replace(/ /g, '-'));
    const res = await page.goto(`/books/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOOK);
    await expect(page).toHaveTitle(`${title}: a novel by E2E Author`);
    // Server-rendered: none of the app's bundle is on this page.
    expect(await page.locator('script').count()).toBe(0);
  });

  test('stores a reservation, once per address, and thanks the reader', async ({ page }) => {
    const email = `e2e-${Date.now()}@example.com`;
    await page.goto(`/books/${slug}`);
    await page.getByLabel('First name').fill('Ada');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Reserve my copy' }).click();
    await expect(page.getByRole('status')).toHaveText(
      `Thank you. You are on the list, and we will write to you when ${title} is released.`,
    );

    // The same person again, in capitals: still one reservation.
    await page.getByLabel('Email').fill(email.toUpperCase());
    await page.getByRole('button', { name: 'Reserve my copy' }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const rows = await supaGet<{ first_name: string; email: string; slug: string }>(
      'landing_page_reservations_v2',
      `project_id=eq.${projectId}&select=first_name,email,slug`,
    );
    expect(rows).toEqual([{ first_name: 'Ada', email, slug }]);
  });

  test('is gone once taken down', async ({ page }) => {
    const api = await apiClient();
    expect((await api.delete(`/api/landing-page/project/${projectId}/publish`)).ok()).toBe(true);
    await api.dispose();
    const res = await page.goto(`/books/${slug}`);
    expect(res?.status()).toBe(404);
  });
});
