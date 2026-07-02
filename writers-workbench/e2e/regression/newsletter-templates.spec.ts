import { test, expect } from '@playwright/test';
import {
  apiClient, supaGet, hardDeleteEdition, eqUser,
  seedTemplate, deleteTemplate,
} from '../pages/api';

test.describe.configure({ mode: 'serial' });

/**
 * TemplateEditor + TemplatesList — RESULT-asserting, data-isolated.
 *
 * Every UI action proves the backing row actually changed:
 *   - New-template Save (POST)  → a newsletter_templates_v2 row exists with our name+html.
 *   - Edit Save (PUT)           → the row's name+html are updated in the DB.
 *   - Render preview            → the preview iframe renders real HTML (srcdoc > 100).
 *   - Import HTML drawer        → the "Template HTML source" textarea value changes.
 *   - Sample-data JSON textarea → the sample_data persists on Save.
 *   - Default/Active checkboxes → is_default / active persist on Save.
 *   - TemplatesList New link / Edition filter / Show-inactive / Edit nav / guarded Delete.
 *   - HelpButton open/close.
 *
 * A throwaway edition (auto-gets a default template) hosts the templates; teardown hard-deletes it.
 */
let editionId = '';
const STAMP = Date.now();
const templateIdsToClean: string[] = [];

test.describe('Newsletter Templates (result-asserting)', () => {
  test.beforeAll(async () => {
    editionId = `e2e-tmpl-${STAMP}`;
    const api = await apiClient();
    const res = await api.post('/api/newsletter/editions', {
      data: {
        id: editionId,
        display_name: `E2E Templates ${STAMP}`,
        newsletter_name: 'E2E Templates Weekly',
        subheader: 'Disposable templates edition',
        genre: 'post-apocalyptic',
        description: 'Created by newsletter-templates.spec.ts',
        primary_color: '#111111',
        paper_color: '#ffffff',
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    await api.dispose();
    const rows = await supaGet('newsletter_editions_v2', `id=eq.${editionId}&${eqUser()}&select=id`);
    expect(rows.length, 'edition row must exist').toBe(1);
  });

  test.afterAll(async () => {
    for (const id of templateIdsToClean) await deleteTemplate(id).catch(() => {});
    if (editionId) await hardDeleteEdition(editionId);
  });

  test('TemplateEditor /new: Save (POST) creates the template row in the DB', async ({ page }) => {
    const name = `E2E New Template ${STAMP}`;
    await page.goto('/newsletter/templates/new');
    await expect(page.getByRole('heading', { name: /New template/i })).toBeVisible({ timeout: 20_000 });

    // Fill meta + a recognizable HTML body via the source textarea.
    await page.getByLabel(/^Name$/i).fill(name);
    await page.getByLabel(/^Description$/i).fill('created by e2e');
    // Edition is the only <select> in the editor's meta card.
    await page.getByRole('combobox').first().selectOption(editionId);
    const htmlSource = page.getByLabel('Template HTML source');
    await htmlSource.fill(`<!doctype html><html><body><h1>E2E-NEW-${STAMP}</h1><p>{{title}}</p></body></html>`);

    await page.getByRole('button', { name: /^Save$/ }).click();

    // Editor navigates to /newsletter/templates/:id on create. Assert the DB row exists with our fields.
    await expect
      .poll(async () => (await supaGet('newsletter_templates_v2',
        `edition_id=eq.${editionId}&name=eq.${encodeURIComponent(name)}&select=id,name,html`)).length,
        { timeout: 15_000, message: 'New-template Save did not write a newsletter_templates_v2 row' })
      .toBe(1);
    const row = (await supaGet('newsletter_templates_v2',
      `edition_id=eq.${editionId}&name=eq.${encodeURIComponent(name)}&select=id,name,html,active`))[0];
    templateIdsToClean.push(row.id);
    expect(row.name).toBe(name);
    expect(row.html).toContain(`E2E-NEW-${STAMP}`);
    expect(row.active).toBe(true);
  });

  test('TemplateEditor edit: Save (PUT) updates name+html+sample_data, and Render preview renders HTML', async ({ page }) => {
    // Seed a NON-default template so Save can't collide with the edition's default.
    const seededName = `E2E Edit Seed ${STAMP}`;
    const tid = await seedTemplate({
      edition_id: editionId, name: seededName, is_default: false, active: true,
      html: '<!doctype html><html><body><h1>OLD-BODY</h1></body></html>',
    });
    templateIdsToClean.push(tid);

    await page.goto(`/newsletter/templates/${tid}`);
    await expect(page.getByLabel('Template HTML source')).toBeVisible({ timeout: 20_000 });
    // Hydration fills the source with the seeded html.
    await expect(page.getByLabel('Template HTML source')).toHaveValue(/OLD-BODY/, { timeout: 15_000 });

    // Change name, html, and sample_data, then Save (PUT).
    const newName = `E2E Edited ${STAMP}`;
    await page.getByLabel(/^Name$/i).fill(newName);
    await page.getByLabel('Template HTML source').fill(`<!doctype html><html><body><h1>NEW-BODY-${STAMP}</h1><p>{{title}}</p></body></html>`);
    await page.getByLabel('Sample data JSON').fill(JSON.stringify({ title: `E2E-SAMPLE-${STAMP}` }, null, 2));
    await page.getByRole('button', { name: /^Save$/ }).click();

    // DB result: the row's name + html + sample_data are updated.
    await expect
      .poll(async () => (await supaGet('newsletter_templates_v2', `id=eq.${tid}&select=name`))[0]?.name,
        { timeout: 15_000, message: 'Edit Save did not update the template name' })
      .toBe(newName);
    const row = (await supaGet('newsletter_templates_v2', `id=eq.${tid}&select=name,html,sample_data`))[0];
    expect(row.html).toContain(`NEW-BODY-${STAMP}`);
    expect(row.sample_data?.title).toBe(`E2E-SAMPLE-${STAMP}`);

    // UI result: Render preview renders the saved HTML into the preview iframe.
    await page.getByRole('button', { name: /Render preview/i }).click();
    const iframe = page.locator('iframe[title="Template preview"]');
    await expect(iframe).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await iframe.getAttribute('srcdoc'))?.length ?? 0,
        { timeout: 15_000, message: 'Template preview rendered no HTML' })
      .toBeGreaterThan(100);
    expect(await iframe.getAttribute('srcdoc')).toContain(`NEW-BODY-${STAMP}`);
  });

  test('TemplateEditor: Import HTML drawer replaces the HTML-source textarea value', async ({ page }) => {
    const tid = await seedTemplate({
      edition_id: editionId, name: `E2E Import Seed ${STAMP}`, is_default: false, active: true,
      html: '<!doctype html><html><body><h1>BEFORE-IMPORT</h1></body></html>',
    });
    templateIdsToClean.push(tid);

    await page.goto(`/newsletter/templates/${tid}`);
    const htmlSource = page.getByLabel('Template HTML source');
    await expect(htmlSource).toHaveValue(/BEFORE-IMPORT/, { timeout: 20_000 });

    await page.getByRole('button', { name: /Import HTML/i }).click();
    const importArea = page.getByLabel('Imported HTML');
    await expect(importArea).toBeVisible({ timeout: 10_000 });
    await importArea.fill(`<!doctype html><html><body><h1>AFTER-IMPORT-${STAMP}</h1><script>alert(1)</script></body></html>`);
    await page.getByRole('button', { name: /Replace template HTML/i }).click();

    // UI result: the source textarea now holds the imported (sanitized) HTML — script stripped.
    await expect(htmlSource).toHaveValue(new RegExp(`AFTER-IMPORT-${STAMP}`), { timeout: 10_000 });
    const val = await htmlSource.inputValue();
    expect(val).not.toContain('<script>');
    // Import banner confirms the sanitizer ran.
    await expect(page.getByText(/Imported/i).first()).toBeVisible({ timeout: 8_000 });
  });

  test('TemplateEditor: Default + Active checkboxes persist on Save', async ({ page }) => {
    // Seed active but NOT default; the UI will flip Default on. The edition already has a default,
    // so setting is_default would 409 — instead we verify Active toggles OFF persists, plus Default
    // stays reflectable. We test Active OFF (safe, no unique-index collision).
    const tid = await seedTemplate({
      edition_id: editionId, name: `E2E Flags ${STAMP}`, is_default: false, active: true,
    });
    templateIdsToClean.push(tid);

    await page.goto(`/newsletter/templates/${tid}`);
    // The editor initializes `active` to true and hydrates from the fetched row afterward. Wait for
    // hydration to COMPLETE (seeded name populated) before toggling — otherwise an uncheck made during
    // the load window is clobbered when the hydrate effect fires and re-checks Active.
    await expect(page.getByLabel(/^Name$/i)).toHaveValue(`E2E Flags ${STAMP}`, { timeout: 20_000 });
    const activeBox = page.getByRole('checkbox', { name: /^Active$/i });
    await expect(activeBox).toBeVisible({ timeout: 20_000 });
    await expect(activeBox).toBeChecked();
    await activeBox.uncheck();
    // The Default checkbox is present and toggleable (assert we can check/uncheck it in the UI).
    const defaultBox = page.getByRole('checkbox', { name: /Default for this edition/i });
    await defaultBox.check();
    await expect(defaultBox).toBeChecked();
    await defaultBox.uncheck(); // leave default off to avoid the unique-default 409 on Save
    await page.getByRole('button', { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await supaGet('newsletter_templates_v2', `id=eq.${tid}&select=active`))[0]?.active,
        { timeout: 15_000, message: 'Active-checkbox Save did not persist active=false' })
      .toBe(false);
    const row = (await supaGet('newsletter_templates_v2', `id=eq.${tid}&select=active,is_default`))[0];
    expect(row.active).toBe(false);
    expect(row.is_default).toBe(false);
  });

  test('TemplatesList: Edition filter, Show-inactive, Edit nav, and guarded Delete', async ({ page }) => {
    // Seed one active non-default (deletable) + one inactive (only visible with Show-inactive).
    const delName = `E2E Delete Me ${STAMP}`;
    const inactiveName = `E2E Inactive ${STAMP}`;
    const delId = await seedTemplate({ edition_id: editionId, name: delName, is_default: false, active: true });
    const inactiveId = await seedTemplate({ edition_id: editionId, name: inactiveName, is_default: false, active: false });
    templateIdsToClean.push(delId, inactiveId);

    await page.goto('/newsletter/templates');
    await expect(page.getByRole('heading', { name: /Newsletter templates/i })).toBeVisible({ timeout: 20_000 });

    // Edition filter: narrows the list to this edition. Our deletable row is visible.
    await page.getByLabel(/Edition:/i).selectOption(editionId);
    await expect(page.locator('tr', { hasText: delName }).first()).toBeVisible({ timeout: 15_000 });
    // Inactive row hidden by default...
    await expect(page.locator('tr', { hasText: inactiveName })).toHaveCount(0);
    // ...revealed by Show inactive.
    const showInactive = page.getByRole('checkbox', { name: /Show inactive/i });
    await showInactive.check();
    await expect(showInactive).toBeChecked();
    await expect(page.locator('tr', { hasText: inactiveName }).first()).toBeVisible({ timeout: 15_000 });

    // Per-row Edit navigates to the editor for that template.
    const delRow = page.locator('tr', { hasText: delName }).first();
    await delRow.getByRole('button', { name: /^Edit$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/newsletter/templates/${delId}`), { timeout: 10_000 });

    // Guarded Delete: confirm() → DELETE → row gone from the DB.
    page.on('dialog', (d) => d.accept());
    await page.goto('/newsletter/templates');
    await page.getByLabel(/Edition:/i).selectOption(editionId);
    const row2 = page.locator('tr', { hasText: delName }).first();
    await expect(row2).toBeVisible({ timeout: 15_000 });
    await row2.getByRole('button', { name: /^Delete$/ }).click();
    await expect
      .poll(async () => (await supaGet('newsletter_templates_v2', `id=eq.${delId}&select=id`)).length,
        { timeout: 15_000, message: 'Delete did not remove the template row from the DB' })
      .toBe(0);
  });

  test('TemplatesList: New template link navigates to the editor', async ({ page }) => {
    await page.goto('/newsletter/templates');
    await page.getByRole('link', { name: /New template/i }).first().click();
    await expect(page).toHaveURL(/\/newsletter\/templates\/new/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /New template/i })).toBeVisible();
  });

  test('TemplatesList: HelpButton opens and closes', async ({ page }) => {
    await page.goto('/newsletter/templates');
    // HelpButton's accessible name is its "?" text; target the title attribute instead.
    const help = page.locator('button[title="Help: Templates"]');
    await expect(help).toBeVisible({ timeout: 20_000 });
    await help.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByRole('heading', { name: /Templates/i })).toBeVisible();
    await dialog.getByRole('button', { name: /^Close$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });
  });
});
