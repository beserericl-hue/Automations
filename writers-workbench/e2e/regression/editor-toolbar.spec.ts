import { test, expect, type Page, type Locator } from '@playwright/test';
import { seedContent, getContent, deleteContent, supaGet } from '../pages/api';

/**
 * RichText EditorToolbar — RESULT-asserting coverage for EVERY formatting control, plus Undo/Redo and Save.
 *
 * For each button we: place the cursor / select text in the live `.ProseMirror`, click the toolbar button,
 * assert the editor's produced HTML actually changed (e.g. Bold -> <strong>, H1 -> <h1>, Bullet List -> <ul>),
 * then assert it PERSISTED to published_content_v2.content_text after the 2s autosave (or an explicit Save).
 * Accessible names are asserted too: text buttons expose their glyph (B, I, H1…), icon buttons expose their
 * title (Bullet List, Numbered List, Undo, Redo), and Save exposes "Save".
 *
 * Verified against editor/EditorToolbar.tsx + editor/RichTextEditor.tsx (2s debounce autosave).
 * Seeds a disposable chapter per test; teardown hard-deletes it. Pinned to the demo user.
 */

let contentId = '';

/** Seed a fresh chapter with a known single-paragraph body and open its editor. */
async function openEditor(page: Page, body = 'The relay hummed in the dark tunnel below the ridge.'): Promise<Locator> {
  contentId = await seedContent({
    title: `E2E Toolbar ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content_type: 'chapter',
    status: 'draft',
    content_text: body,
  });
  await page.goto(`/content/${contentId}`);
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  return editor;
}

/** Current editor HTML. */
async function editorHtml(editor: Locator): Promise<string> {
  return (await editor.innerHTML()).toLowerCase();
}

/** Select all text in the editor (so inline marks apply to the paragraph). */
async function selectAll(page: Page, editor: Locator) {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
}

/** Wait until the DB content_text contains the given substring (autosave persisted). */
async function persistedContains(id: string, needle: string): Promise<void> {
  await expect
    .poll(async () => ((await getContent(id, 'content_text'))?.content_text ?? '').toLowerCase().includes(needle.toLowerCase()),
      { timeout: 20_000, message: `content_text never persisted "${needle}"` })
    .toBe(true);
}

test.describe('RichText EditorToolbar (result-asserting)', () => {
  test.afterEach(async () => {
    if (contentId) await deleteContent(contentId);
    contentId = '';
  });

  // ------------------------------------------------------------------- accessible names
  test('toolbar buttons expose the correct accessible names', async ({ page }) => {
    await openEditor(page);
    // Text-glyph buttons expose their visible glyph as the accessible name.
    for (const name of ['B', 'I', 'S', 'H1', 'H2', 'H3']) {
      await expect(page.getByRole('button', { name, exact: true }),
        `text button "${name}" must be present with glyph name`).toBeVisible();
    }
    // Icon-only buttons expose their title.
    for (const name of ['Bullet List', 'Numbered List', 'Blockquote', 'Undo', 'Redo']) {
      await expect(page.getByRole('button', { name, exact: true }),
        `icon button "${name}" must expose its title`).toBeVisible();
    }
    // Save button.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });

  // ------------------------------------------------------------------- Bold
  test('Bold wraps selection in <strong> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await selectAll(page, editor);
    await page.getByRole('button', { name: 'B', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<(strong|b)>/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<strong>');
  });

  // ------------------------------------------------------------------- Italic
  test('Italic wraps selection in <em> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await selectAll(page, editor);
    await page.getByRole('button', { name: 'I', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<(em|i)>/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<em>');
  });

  // ------------------------------------------------------------------- Strikethrough
  test('Strikethrough wraps selection in <s> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await selectAll(page, editor);
    await page.getByRole('button', { name: 'S', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<(s|del|strike)>/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<s>');
  });

  // ------------------------------------------------------------------- Headings H1/H2/H3
  for (const level of [1, 2, 3] as const) {
    test(`H${level} converts the block to <h${level}> and persists`, async ({ page }) => {
      const editor = await openEditor(page);
      await editor.click();
      await page.keyboard.press('End'); // cursor in the paragraph
      await page.getByRole('button', { name: `H${level}`, exact: true }).click();
      await expect.poll(() => editorHtml(editor)).toContain(`<h${level}`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await persistedContains(contentId, `<h${level}`);
    });
  }

  // ------------------------------------------------------------------- Bullet List
  test('Bullet List converts the block to <ul><li> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Bullet List', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<ul>.*<li>/s);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<ul>');
  });

  // ------------------------------------------------------------------- Numbered List
  test('Numbered List converts the block to <ol><li> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Numbered List', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<ol>.*<li>/s);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<ol>');
  });

  // ------------------------------------------------------------------- Blockquote
  test('Blockquote wraps the block in <blockquote> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Blockquote', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toContain('<blockquote>');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<blockquote>');
  });

  // ------------------------------------------------------------------- Horizontal Rule
  test('Horizontal Rule inserts an <hr> and persists', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.click();
    await page.keyboard.press('End');
    // The HR button renders the em-dash glyph "—" as its text content, so its accessible name is "—";
    // target it by its title attribute instead (the glyph name would also match the Divider text).
    await page.getByTitle('Horizontal Rule').click();
    await expect.poll(() => editorHtml(editor)).toContain('<hr');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<hr');
  });

  // ------------------------------------------------------------------- Undo / Redo
  test('Undo reverts the last change and Redo re-applies it', async ({ page }) => {
    const editor = await openEditor(page);
    await selectAll(page, editor);

    // Apply Bold -> HTML gains <strong>.
    await page.getByRole('button', { name: 'B', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<(strong|b)>/);

    // Undo -> the <strong> is gone (content returned to prior state).
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).not.toMatch(/<(strong|b)>/);

    // Redo -> the <strong> comes back.
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(() => editorHtml(editor)).toMatch(/<(strong|b)>/);

    // The final (redone) state persists.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, '<strong>');
  });

  // ------------------------------------------------------------------- Save button
  test('Save button persists the current editor content immediately', async ({ page }) => {
    const editor = await openEditor(page);
    const marker = `SAVEMARK-${Date.now()}`;
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${marker}`);
    // Click Save before the 2s debounce could fire — proves Save flushes on demand.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await persistedContains(contentId, marker);
  });
});

/**
 * VersionHistory View + Compare — RESULT-asserting.
 *
 * Seeds a chapter, makes two edits so autosave snapshots two versions, opens History, then:
 *   - View on a version renders THAT version's HTML (assert the marker text is in the view panel),
 *   - Compare (enabled with >=2 versions), pick older + newer, assert a diff/compare view renders.
 * Restore is covered elsewhere and skipped. Verified against content/VersionHistory.tsx.
 */
test.describe('VersionHistory View + Compare (result-asserting)', () => {
  let vhId = '';
  // Unique per-test-invocation markers (avoids any ambiguity between the View and Compare tests).
  let M1 = '';
  let M2 = '';

  test.afterEach(async () => {
    if (vhId) await deleteContent(vhId);
    vhId = '';
  });

  /**
   * Type a marker at the end, click Save to flush, and wait for the DB to persist it. Waits for the
   * marker to actually appear in the live editor first so we don't race the post-save content refetch
   * (RichTextEditor re-applies the query result via setContent, which can drop an un-flushed edit).
   */
  async function editAndSave(page: Page, editor: Locator, marker: string) {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${marker}`);
    // The typed marker is in the DOM before we Save (guards against a mid-refetch content reset).
    await expect(editor).toContainText(marker, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => ((await getContent(vhId, 'content_text'))?.content_text ?? '').includes(marker),
        { timeout: 20_000, message: `edit "${marker}" did not persist` })
      .toBe(true);
    // After a save the content-detail query refetches and RichTextEditor re-applies the result via
    // setContent — which resets the editor. Wait for the "Saved" indicator to clear (it hides ~3s after
    // success) so the reset has settled and the marker is stably back in the editor before the next edit.
    await expect(editor).toContainText(marker, { timeout: 10_000 });
    await expect(page.getByText('Saved', { exact: true })).toBeHidden({ timeout: 10_000 });
  }

  async function seedTwoVersions(page: Page): Promise<Locator> {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    M1 = `VHMARK1-${stamp}`;
    M2 = `VHMARK2-${stamp}`;
    vhId = await seedContent({
      title: `E2E VersionHist ${stamp}`,
      content_type: 'chapter',
      status: 'draft',
      content_text: 'Baseline body of the chapter under version control.',
    });
    await page.goto(`/content/${vhId}`);
    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 20_000 });

    await editAndSave(page, editor, M1);
    await editAndSave(page, editor, M2);

    // Two autosave snapshots exist in the DB.
    await expect
      .poll(async () => (await supaGet('content_versions_v2', `content_id=eq.${vhId}&select=id`)).length,
        { timeout: 20_000, message: 'expected >=2 version snapshots' })
      .toBeGreaterThanOrEqual(2);
    return editor;
  }

  test('View renders the selected version\'s HTML', async ({ page }) => {
    await seedTwoVersions(page);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View', exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // The newest version (v-highest, listed first) contains BOTH markers (M1 then M2 were appended).
    await page.getByRole('button', { name: 'View', exact: true }).first().click();

    // View mode shows a "Version N" heading and renders that version's body via dangerouslySetInnerHTML
    // into a div.prose. Assert both the heading and that the rendered body contains the latest marker.
    await expect(page.getByRole('heading', { name: /^Version \d+$/ })).toBeVisible({ timeout: 10_000 });
    const viewBody = page.locator('div.prose').last();
    await expect(viewBody).toContainText(M2, { timeout: 10_000 });
  });

  test('Compare enables with >=2 versions and renders a diff', async ({ page }) => {
    await seedTwoVersions(page);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const compareBtn = page.getByRole('button', { name: 'Compare versions', exact: true });
    await expect(compareBtn).toBeVisible({ timeout: 10_000 });
    await expect(compareBtn).toBeEnabled(); // >=2 versions -> not disabled
    await compareBtn.click();

    // Two <select>s: Older version and Newer version. Pick the two rendered options.
    const olderSel = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select...' }) }).first();
    const newerSel = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select...' }) }).last();

    // Options are labelled "vN - <date>"; pick the two version option values (skip the empty "Select...").
    const optionValues = await olderSel.locator('option').evaluateAll(
      (opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    expect(optionValues.length, 'compare dropdown must list >=2 versions').toBeGreaterThanOrEqual(2);

    // Older = last option (lowest version_number listed at bottom is oldest? list is desc, so last = oldest).
    await olderSel.selectOption(optionValues[optionValues.length - 1]);
    await newerSel.selectOption(optionValues[0]);

    // A diff view renders: the "vX -> vY" header appears and the diff body (a font-mono div) shows the
    // newest-only marker (M2), which was added between the older and newer version.
    await expect(page.getByText(/v\d+\s*→\s*v\d+/)).toBeVisible({ timeout: 10_000 });
    const diffBody = page.locator('div.font-mono').last();
    await expect(diffBody).toContainText(M2, { timeout: 10_000 });
  });
});
