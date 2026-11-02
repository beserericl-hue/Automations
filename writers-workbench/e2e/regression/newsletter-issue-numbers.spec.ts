import { test, expect } from '@playwright/test';
import { supaGet, seedEdition, upsertSend, hardDeleteEdition } from '../pages/api';

test.describe.configure({ mode: 'serial' });

/**
 * Newsletter issue numbers (migration 041) — CREATED and DISPLAYED.
 *
 * The database numbers each send of an edition 1, 2, 3 … when it is saved (an advisory-locked
 * trigger), keeps the number when the same edition + date is saved again (the engine's upsert), and
 * the Workbench shows the number on the Sends list, the send detail and the Newsletter home.
 *
 * PASS: five concurrent saves to a fresh edition get exactly #1..#5 (no duplicates, no gaps); a
 *       re-save of the same date keeps its number; a proposed number that is already taken is
 *       replaced by the next free one; every sent row on DEV has a number (backfill); the numbers
 *       render on /newsletter/sends, /newsletter/sends/:id and /newsletter.
 * FAIL: duplicates / nulls / gaps, a re-save that burns a new number, or "—" in the UI.
 *
 * Light (REST + render only) — Pass A. Data-isolated: a disposable edition, hard-deleted after.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const STAMP = Date.now();
const SLUG = `e2e-issue-${STAMP}`;
// Far-future dates: (user_id, send_date) is unique across the user's live sends, so stay clear of
// real sends and of parallel runs of this spec.
const YEAR = 2200 + (STAMP % 700);
const dateFor = (i: number) => `${YEAR}-03-${String(i).padStart(2, '0')}`;

test.describe('Newsletter issue numbers (result-asserting)', () => {
  test.skip(!HAS_KEY, 'requires SUPABASE_SERVICE_ROLE_KEY / E2E_SUPA_SERVICE_KEY');

  test.beforeAll(async () => {
    await seedEdition(SLUG, `E2E Issues ${STAMP}`);
  });
  test.afterAll(async () => {
    await hardDeleteEdition(SLUG);
  });

  test('concurrent saves get sequential, unique numbers; a re-save keeps its number', async () => {
    // Five saves at once — the trigger's per-edition lock must serialise them.
    const saved = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => upsertSend({ edition_id: SLUG, send_date: dateFor(i), subject: `E2E issue ${STAMP} ${i}` })),
    );
    const numbers = saved.map((r) => r.issue_number).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(numbers, 'five concurrent saves → #1..#5').toEqual([1, 2, 3, 4, 5]);

    // Re-saving the same edition + date (the engine's upsert) keeps the number.
    const before = saved.find((r) => r.id)!;
    const beforeRow = (await supaGet<{ send_date: string; issue_number: number }>(
      'newsletter_sends_v2', `id=eq.${before.id}&select=send_date,issue_number`,
    ))[0];
    const again = await upsertSend({ edition_id: SLUG, send_date: beforeRow.send_date, subject: `E2E issue ${STAMP} resaved` });
    expect(again.id).toBe(before.id);
    expect(again.issue_number, 're-save must not burn a new number').toBe(beforeRow.issue_number);

    // A proposed number already held by another send is replaced by the next free one.
    const clash = await upsertSend({ edition_id: SLUG, send_date: dateFor(6), subject: `E2E issue ${STAMP} 6`, issue_number: 2 });
    expect(clash.issue_number).toBe(6);

    const all = await supaGet<{ issue_number: number | null }>('newsletter_sends_v2', `edition_id=eq.${SLUG}&select=issue_number`);
    expect(all.length).toBe(6);
    expect(new Set(all.map((r) => r.issue_number)).size, 'no duplicate numbers in the edition').toBe(6);
  });

  test('backfill: every sent send of an edition on DEV has an issue number', async () => {
    const missing = await supaGet('newsletter_sends_v2', 'status=eq.sent&edition_id=not.is.null&issue_number=is.null&select=id');
    expect(missing.length, 'sent rows without an issue number').toBe(0);
  });

  test('the numbers are displayed on Sends, the send detail and the Newsletter home', async ({ page }) => {
    const rows = await supaGet<{ id: string; issue_number: number; subject: string }>(
      'newsletter_sends_v2', `edition_id=eq.${SLUG}&select=id,issue_number,subject&order=issue_number.asc`,
    );
    expect(rows.length).toBe(6);

    // Sends list: Status → draft, Edition → ours.
    await page.goto('/newsletter/sends', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /^Sends$/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('combobox').first().selectOption('draft');
    await page.getByRole('combobox').nth(1).selectOption(SLUG);
    await expect(page.getByTestId('send-issue')).toHaveCount(6, { timeout: 20_000 });
    const shown = (await page.getByTestId('send-issue').allInnerTexts()).map((t) => t.trim()).sort();
    expect(shown).toEqual(['#1', '#2', '#3', '#4', '#5', '#6']);

    // Detail: the sidebar Issue tile.
    const third = rows.find((r) => r.issue_number === 3)!;
    await page.goto(`/newsletter/sends/${third.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('send-detail-issue')).toHaveText('#3', { timeout: 20_000 });

    // Newsletter home: the recent-runs table carries the Issue column (our rows are the newest).
    await page.goto('/newsletter', { waitUntil: 'domcontentloaded' });
    const homeRow = page.getByRole('button').filter({ hasText: rows[rows.length - 1].subject });
    await expect(homeRow.getByTestId('recent-run-issue')).toHaveText(`#${rows[rows.length - 1].issue_number}`, { timeout: 20_000 });
  });
});
