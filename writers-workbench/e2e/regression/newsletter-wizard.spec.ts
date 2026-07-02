import { test, expect } from '@playwright/test';
import { apiClient, supaGet, hardDeleteEdition, eqUser } from '../pages/api';

/**
 * Newsletter Setup Wizard — RESULT-asserting, data-isolated.
 *
 * Creates a throwaway edition, walks Feeds → Template → Subscriber → Done, and at each step proves the
 * FUNCTION actually worked: the feed list grows AND newsletter_feed_sources_v2 rows exist; the template
 * step PREVIEWS real HTML (iframe srcdoc length > 0 — not the "no default template" empty state); the
 * subscriber submit creates a newsletter_subscribers_v2 row. Teardown hard-deletes the edition + children.
 *
 * Verified against components/newsletter/EditionSetupWizard.tsx and server routes
 * newsletter.ts / newsletter-feeds.ts / newsletter-edition-extras.ts.
 */
const GENRE = 'post-apocalyptic'; // has 15 curated feeds on DEV
let editionId = '';
let subscriberEmail = '';

test.describe('Newsletter Setup Wizard (result-asserting)', () => {
  test.beforeAll(async () => {
    const stamp = Date.now();
    editionId = `e2e-wiz-${stamp}`;
    subscriberEmail = `e2e-wiz-${stamp}@example.com`;
    const api = await apiClient();
    const res = await api.post('/api/newsletter/editions', {
      data: {
        id: editionId,
        display_name: `E2E Wizard ${stamp}`,
        newsletter_name: 'E2E Wizard Weekly',
        subheader: 'Disposable regression edition',
        genre: GENRE,
        description: 'Created by newsletter-wizard.spec.ts',
        primary_color: '#111111',
        paper_color: '#ffffff',
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.edition.id).toBe(editionId);
    await api.dispose();

    // Prove the row exists in the DB (not just a 201).
    const rows = await supaGet('newsletter_editions_v2', `id=eq.${editionId}&${eqUser()}&select=id,genre`);
    expect(rows.length, 'edition row must exist in the DB').toBe(1);
    expect(rows[0].genre).toBe(GENRE);
  });

  test.afterAll(async () => {
    if (editionId) await hardDeleteEdition(editionId);
  });

  test('wizard: feeds import, template preview, subscriber add all produce real results', async ({ page }) => {
    await page.goto(`/newsletter/editions/${editionId}/setup`);
    await expect(page.getByRole('heading', { name: /Add feeds/i })).toBeVisible({ timeout: 20_000 });

    // ---- Feeds step: import from genre must GROW the feed list AND write DB rows ----
    const before = await supaGet('newsletter_feed_sources_v2', `edition_id=eq.${editionId}&select=id`);
    expect(before.length).toBe(0);

    const copyBtn = page.getByRole('button', { name: /Copy \d+ feeds? from/i });
    await expect(copyBtn).toBeVisible({ timeout: 15_000 });
    await copyBtn.click();

    // UI result: the "N feeds attached" count becomes > 0 (anchored so it can't match the
    // "Copy N feeds from <genre>" button text).
    const attached = page.getByText(/\d+\s+feeds?\s+attached/i).first();
    await expect
      .poll(async () => {
        const t = (await attached.textContent().catch(() => '')) ?? '';
        const m = t.match(/(\d+)\s+feeds?\s+attached/i);
        return m ? Number(m[1]) : 0;
      }, { timeout: 25_000, message: 'feed count never grew in the UI' })
      .toBeGreaterThan(0);
    await expect(page.getByText(/Imported \d+ new feed/i)).toBeVisible({ timeout: 10_000 });

    // DB result: feed rows actually exist for this edition.
    const afterFeeds = await supaGet('newsletter_feed_sources_v2', `edition_id=eq.${editionId}&select=id,url`);
    expect(afterFeeds.length, 'feed rows must be written to newsletter_feed_sources_v2').toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Next: Template →' }).click();

    // ---- Template step: the preview MUST render real HTML (regression guard for the no-default bug) ----
    await expect(page.getByRole('heading', { name: /Confirm template/i })).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/No active default template/i),
      'a new edition must have a default template (else the preview is blank and generation fails)',
    ).toHaveCount(0);
    const iframe = page.locator('iframe[title="Template preview"]');
    await expect(iframe).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await iframe.getAttribute('srcdoc'))?.length ?? 0,
        { timeout: 20_000, message: 'template preview iframe rendered no HTML' })
      .toBeGreaterThan(100);
    // And the default template row exists in the DB for this edition.
    const tmpl = await supaGet('newsletter_templates_v2',
      `edition_id=eq.${editionId}&is_default=eq.true&active=eq.true&select=id,name`);
    expect(tmpl.length, 'edition must have an active default template row').toBe(1);

    await page.getByRole('button', { name: 'Next: Subscriber →' }).click();

    // ---- Subscriber step: add produces a real newsletter_subscribers_v2 row ----
    await expect(page.getByRole('heading', { name: /Add the first subscriber/i })).toBeVisible({ timeout: 15_000 });
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.fill(subscriberEmail);
    await page.getByRole('button', { name: /^Add$/ }).click();
    await expect(page.getByRole('button', { name: /Added ✓/ })).toBeVisible({ timeout: 15_000 });

    const subs = await supaGet('newsletter_subscribers_v2',
      `edition_id=eq.${editionId}&email=eq.${encodeURIComponent(subscriberEmail)}&select=id,email,status`);
    expect(subs.length, 'subscriber row must be written to newsletter_subscribers_v2').toBe(1);
    expect(subs[0].email).toBe(subscriberEmail);

    await page.getByRole('button', { name: 'Done →' }).click();

    // ---- Done step ----
    await expect(page.getByRole('heading', { name: /All set/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Generate now/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Back to my newsletters/i })).toBeVisible();
  });

  test('editions-list Preview renders the newsletter default template as real HTML', async ({ page }) => {
    await page.goto('/newsletter/editions');
    // Find this edition's row (its slug === editionId is shown) and click its Preview action.
    const row = page.locator('tr', { hasText: editionId }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Preview' }).click();

    const dialog = page.getByRole('dialog', { name: /Preview of/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const iframe = dialog.locator('iframe[title="Newsletter preview"]');
    await expect(iframe).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await iframe.getAttribute('srcdoc'))?.length ?? 0,
        { timeout: 15_000, message: 'newsletter preview iframe rendered no HTML' })
      .toBeGreaterThan(100);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });
  });
});
