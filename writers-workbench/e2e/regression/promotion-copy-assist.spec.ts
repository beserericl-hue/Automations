import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { supaGet } from '../pages/api';
import { HAS_DEV_KEYS, balanceOf, cleanupFreshUsers, makeFreshUser, setBalance, signInPage, svcHeaders, userApi, type FreshUser } from '../pages/fresh-user';

/**
 * The promotion copy assistant on the Publish tab — RESULT-asserting, against DEV, as a fresh
 * NON-admin user (credits really checked and charged), on a seeded book with real chapters. Heavy
 * (Pass B): every draft is a real model call.
 *
 * PASS
 *   1. "Draft with AI" fills the empty Description from the book (it names the book's protagonist and
 *      place) and charges the assistant's price once;
 *   2. Hook: draft, "Revise with AI" ("shorter, more suspense") is shown BESIDE the text and only
 *      replaces it on "Use this"; Undo puts the previous text back;
 *   3. the author's edit + Save persists after a reload, and the KDP package's listing file carries the
 *      saved description and the subtitle (book_copy_v2);
 *   4. "Draft all missing" shows the total for the empty fields first, then fills only those;
 *   5. a front-matter field (dedication) drafts with a [placeholder] for the name, saves, persists;
 *   6. every model call is in token_usage_v2 as copy-assist.<field>, and the balance fell by exactly
 *      price x drafts;
 *   7. short of credits: 402, a message with the numbers, nothing filled.
 * The user is deleted at the end.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';

const CHAPTERS = [
  { n: 1, title: 'The Salt Road', beat: 'Mara Vell leaves the burning town of Ashgrove carrying the last water skins toward the river Ondra.' },
  { n: 2, title: 'The Glass Flats', beat: 'Crossing the salt flats, Mara meets Tobin Rook, a scavenger who claims the river has gone dry.' },
  { n: 3, title: 'The Pump House', beat: 'At the old pump house Mara and Tobin find the Wardens rationing water at gunpoint.' },
];
const prose = (c: (typeof CHAPTERS)[number]) =>
  Array.from({ length: 6 }, (_, i) =>
    `${c.beat} ${i === 0 ? 'Mara Vell counted every step.' : 'The wind came off the flats white and bitter, and Mara kept her eyes on the horizon where the river Ondra should be.'} ` +
    'Behind her the smoke of Ashgrove stood up like a column. Ahead there was only salt, and the long patience of thirst.',
  ).join('\n\n');

async function seedBook(user: FreshUser): Promise<string> {
  const p = await fetch(`${SUPA_URL}/rest/v1/writing_projects_v2`, {
    method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: user.userId, title: `The Salt Road ${Date.now().toString(36)}`, genre_slug: 'post-apocalyptic', project_type: 'book', status: 'in_progress',
      outline: {
        premise: 'After the wells fail, Mara Vell carries the last water of Ashgrove across the salt flats to find out whether the river Ondra still runs.',
        themes: ['survival', 'who owns water'],
        chapters: CHAPTERS.map((c) => ({ chapter_number: c.n, title: c.title, beat: c.beat })),
      },
    }),
  });
  if (!p.ok) throw new Error(`seed project ${p.status} ${await p.text()}`);
  const [project] = (await p.json()) as Array<{ id: string }>;
  for (const c of CHAPTERS) {
    const r = await fetch(`${SUPA_URL}/rest/v1/published_content_v2`, {
      method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: user.userId, project_id: project.id, content_type: 'chapter', chapter_number: c.n, title: c.title, content_text: prose(c), status: 'draft', genre_slug: 'post-apocalyptic', metadata: {} }),
    });
    if (!r.ok) throw new Error(`seed chapter ${r.status} ${await r.text()}`);
  }
  const bible = [
    { entry_type: 'character', name: 'Mara Vell', description: 'Water carrier from Ashgrove, nineteen, stubborn.' },
    { entry_type: 'character', name: 'Tobin Rook', description: 'Scavenger of the Glass Flats who trades in rumours.' },
    { entry_type: 'place', name: 'Ashgrove', description: 'A burning well town.' },
  ];
  await fetch(`${SUPA_URL}/rest/v1/story_bible_v2`, {
    method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(bible.map((b) => ({ ...b, user_id: user.userId, project_id: project.id }))),
  });
  await fetch(`${SUPA_URL}/rest/v1/author_profiles_v2`, {
    method: 'POST', headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: user.userId, pen_name: 'Ada Salt', background: 'Hydrologist who mapped dry aquifers for twenty years.' }),
  });
  return project.id;
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

test.describe('Promotion copy assistant on DEV', () => {
  test.skip(!HAS_DEV_KEYS, 'needs the DEV service and anon keys');
  test.setTimeout(10 * 60_000);
  test.afterAll(async () => cleanupFreshUsers());

  test('draft, revise, undo, save, export, draft all missing, matter, credits', async ({ page }) => {
    const user = await makeFreshUser('promo');
    const projectId = await seedBook(user);
    const copy = await userApi(user, 'GET', `/api/copy-assist/project/${projectId}/copy`);
    expect(copy.status, JSON.stringify(copy.json)).toBe(200);
    const price = Number(copy.json.data.assist.price);
    expect(copy.json.data.assist.charged).toBe(true);
    expect(price).toBeGreaterThan(0);
    const start = await balanceOf(user.userId);
    let drafts = 0;

    await signInPage(page, user);
    await page.goto(`/projects/${projectId}/publish`);
    await page.getByTestId('write-field-by-field').click({ timeout: 60_000 });

    // 1. Description from the book itself
    await expect(page.getByTestId('ai-draft-blurb')).toContainText(`${price} cr`);
    await page.getByTestId('ai-draft-blurb').click();
    await expect(field(page, 'Description')).not.toHaveValue('', { timeout: 120_000 });
    drafts += 1;
    const blurb = await field(page, 'Description').inputValue();
    expect(blurb).toMatch(/Mara/);
    expect(blurb).toMatch(/Ashgrove|Ondra|salt/i);
    expect(blurb).not.toMatch(/bestsell|award-winning|acclaimed|★/i);
    expect(blurb.length).toBeLessThanOrEqual(4000);
    await expect(page.getByTestId('count-blurb')).toContainText(`${blurb.length.toLocaleString('en-US')} / 4,000`);
    await expect.poll(() => balanceOf(user.userId), { timeout: 30_000 }).toBe(start - price);

    // 2. Hook: draft, revise beside the text, accept, undo
    await page.getByTestId('ai-draft-hook').click();
    await expect(field(page, 'Hook')).not.toHaveValue('', { timeout: 120_000 });
    drafts += 1;
    const hook = await field(page, 'Hook').inputValue();
    await page.getByTestId('ai-revise-hook').click();
    await page.getByTestId('ai-instruction-hook').fill('shorter, more suspense');
    await page.getByTestId('ai-revise-go-hook').click();
    await expect(page.getByTestId('ai-proposal-hook')).toBeVisible({ timeout: 120_000 });
    drafts += 1;
    await expect(field(page, 'Hook')).toHaveValue(hook); // unchanged until the author chooses
    await page.getByTestId('ai-accept-hook').click();
    const revised = await field(page, 'Hook').inputValue();
    expect(revised).not.toBe(hook);
    await page.getByTestId('ai-undo-hook').click();
    await expect(field(page, 'Hook')).toHaveValue(hook);

    // 3. edit by hand, save, reload, export
    const edited = `${blurb}\n\nEdited by the E2E author.`;
    await field(page, 'Description').fill(edited);
    await field(page, 'Subtitle').fill('A Novel of the Salt Flats');
    await page.getByRole('button', { name: 'Save my version' }).click();
    await expect(page.getByTestId('listing-editor')).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await expect(page.getByText('Edited by the E2E author.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('A Novel of the Salt Flats')).toBeVisible();

    const zipRes = await fetch(`${BASE}/api/export/kdp-package`, {
      method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, volume_index: null, only_approved: false }),
    });
    expect(zipRes.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
    const listingName = Object.keys(zip.files).find((f) => f.endsWith('kdp-listing.txt'))!;
    const listing = await zip.file(listingName)!.async('string');
    expect(listing).toContain('=== SUBTITLE ===\n\nA Novel of the Salt Flats');
    expect(listing).toContain('Edited by the E2E author.');
    expect(listing).toContain(hook);

    // 4. Draft all missing: total first, then only the empty fields
    await page.getByRole('button', { name: 'Edit it myself' }).click();
    await page.getByTestId('draft-all-missing-edit').click();
    const confirm = page.getByTestId('draft-all-confirm');
    await expect(confirm).toBeVisible();
    // Empty now: back cover, inside flap, keywords, categories, comparable titles.
    await expect(confirm.getByTestId('draft-all-total')).toHaveText(`${price * 5} credits`);
    await expect(confirm).not.toContainText('Description');
    const beforeAll = await balanceOf(user.userId);
    await confirm.getByTestId('draft-all-go').click();
    await expect(field(page, 'Keywords')).not.toHaveValue('', { timeout: 180_000 });
    await expect(field(page, 'Back cover')).not.toHaveValue('');
    await expect(field(page, 'Description')).toHaveValue(edited);
    await expect(field(page, 'Hook')).toHaveValue(hook);
    const keywords = (await field(page, 'Keywords').inputValue()).split('\n').filter(Boolean);
    expect(keywords.length).toBeLessThanOrEqual(7);
    for (const k of keywords) expect(k.length).toBeLessThanOrEqual(50);
    const afterAll = await balanceOf(user.userId);
    expect(beforeAll - afterAll).toBe(price * 5);
    drafts += 5;
    await page.getByRole('button', { name: 'Save my version' }).click();
    await expect(page.getByTestId('listing-editor')).toHaveCount(0, { timeout: 30_000 });

    // 5. a front-matter field: dedication, with a placeholder for the name
    await page.getByTestId('ai-draft-dedication').click();
    await expect(field(page, 'Dedication')).not.toHaveValue('', { timeout: 120_000 });
    drafts += 1;
    const dedication = await field(page, 'Dedication').inputValue();
    expect(dedication).toMatch(/\[[^\]]+\]/);
    await field(page, 'Dedication').fill(dedication.replace(/\[[^\]]+\]/g, 'Ruth'));
    await page.getByTestId('save-matter').click();
    await page.waitForTimeout(2000);
    await page.reload();
    await expect(field(page, 'Dedication')).toHaveValue(dedication.replace(/\[[^\]]+\]/g, 'Ruth'), { timeout: 60_000 });

    // 6. the ledger and the cost rows
    expect(await balanceOf(user.userId)).toBe(start - price * drafts);
    const usage = await supaGet<{ operation: string; cost_usd: number }>('token_usage_v2', `user_id=eq.${encodeURIComponent(user.userId)}&operation=like.copy-assist.*&select=operation,cost_usd`);
    const ops = usage.map((u) => u.operation);
    for (const op of ['copy-assist.blurb', 'copy-assist.hook', 'copy-assist.hook.revise', 'copy-assist.keywords', 'copy-assist.dedication']) {
      expect(ops, `token_usage_v2 should have ${op}`).toContain(op);
    }
    expect(usage.every((u) => Number(u.cost_usd) > 0)).toBe(true);

    // 7. short of credits
    await setBalance(user.userId, price - 1);
    await page.reload();
    await page.getByTestId('ai-draft-acknowledgements').click({ timeout: 60_000 });
    await expect(page.getByText(new RegExp(`Not enough credits: this needs ${price}, you have ${price - 1}`))).toBeVisible({ timeout: 30_000 });
    await expect(field(page, 'Acknowledgements')).toHaveValue('');
  });
});
