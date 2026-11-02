import { test, expect } from '@playwright/test';
import { apiClient, deleteCalendarPost, easternToday, seedCalendarPost, supaGet } from '../pages/api';

/**
 * Humanizer coverage (E6) — the record of whether the pass was applied is STORED and DISPLAYED.
 *
 * The radar drafter now humanizes the posts it puts on the calendar and records the outcome in
 * social_schedule_v2.humanize (migration 042); the newsletter saga records its sections' outcome in
 * newsletter_sends_v2.metadata.humanize. Running the real pass costs money per word, so this spec
 * does not call StealthGPT: it seeds the two outcomes a radar run writes and proves the API returns
 * them and the post editor shows them. The live pass itself is verified on DEV by hand (see PR).
 *
 * PASS: GET /api/social/calendar returns the stored humanize record; the editor says "Humanized" for
 *       an applied post and "every rewrite was rejected" for one that ran and kept its draft; a manual
 *       post (no record) shows neither.
 * Light (REST + render) — Pass A. Seeded rows are cancelled (the publisher never picks them up) and
 * deleted after.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

function futureDay(): string {
  for (let n = 15; n < 22; n++) {
    const d = easternToday(n);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return d;
  }
  return easternToday(15);
}

test.describe('Humanizer outcome on radar-drafted posts (result-asserting)', () => {
  test.skip(!HAS_KEY, 'requires service key');

  test('the stored humanize record is returned by the API and shown in the post editor', async ({ page }) => {
    const day = futureDay();
    const stamp = Date.now();
    const applied = await seedCalendarPost({
      title: `E2E humanized ${stamp}`, scheduledDate: day, slot: 'morning', state: 'cancelled',
      humanize: { applied: true, linkedin_content: { applied: true, chunks: 1, humanized_chunks: 1, words_spent: 410 } },
    });
    const kept = await seedCalendarPost({
      title: `E2E kept ${stamp}`, scheduledDate: day, slot: 'afternoon', state: 'cancelled',
      humanize: { applied: false, linkedin_content: { applied: false, chunks: 1, humanized_chunks: 0, rejected: { 0: 'links_lost:1' } } },
    });
    const manual = await seedCalendarPost({ title: `E2E manual ${stamp}`, scheduledDate: easternToday(16), state: 'cancelled' });
    try {
      // STORED
      const rows = await supaGet<{ id: string; humanize: { applied: boolean } | null }>(
        'social_schedule_v2', `id=in.(${applied.id},${kept.id},${manual.id})&select=id,humanize`,
      );
      const byId = new Map(rows.map((r) => [r.id, r.humanize]));
      expect(byId.get(applied.id)?.applied).toBe(true);
      expect(byId.get(kept.id)?.applied).toBe(false);
      expect(byId.get(manual.id)).toBeNull();

      // RETURNED by the calendar API (POST_COLUMNS includes humanize)
      const api = await apiClient();
      const resp = await api.get(`/api/social/calendar?from=${day}&to=${day}`);
      expect(resp.ok(), `GET /api/social/calendar ${resp.status()}`).toBeTruthy();
      const body = await resp.json();
      const posts: Array<{ id: string; humanize?: { applied?: boolean } | null }> = body.data ?? [];
      expect(posts.find((p) => p.id === applied.id)?.humanize?.applied).toBe(true);

      // DISPLAYED in the editor
      await page.goto(`/newsletter/calendar?week=${day}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId(`post-${applied.display_number}`).click({ timeout: 20_000 });
      await expect(page.getByTestId('post-humanize')).toContainText('Humanized');
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByTestId(`post-${kept.display_number}`).click();
      await expect(page.getByTestId('post-humanize')).toContainText('every rewrite was rejected');
      await page.getByRole('button', { name: 'Close' }).click();

      await page.goto(`/newsletter/calendar?week=${easternToday(16)}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId(`post-${manual.display_number}`).click({ timeout: 20_000 });
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByTestId('post-humanize')).toHaveCount(0);
    } finally {
      await deleteCalendarPost(applied.id);
      await deleteCalendarPost(kept.id);
      await deleteCalendarPost(manual.id);
    }
  });
});
