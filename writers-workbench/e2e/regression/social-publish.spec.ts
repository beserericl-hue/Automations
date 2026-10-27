import { test, expect } from '@playwright/test';
import { DEMO_USER_ID, deleteCalendarPost, easternToday, seedCalendarPost, supaGet } from '../pages/api';

/**
 * The engine's publisher drains the calendar (writer_engine.social.poster, every 5 minutes). On DEV
 * SOCIAL_POSTING_MODE is not `live`, so it must record a dry run and send nothing — this proves the
 * deployed engine claims a due post, writes a delivery per channel, settles the row, and that the
 * calendar shows it. Heavy: it waits on the real tick.
 *
 * PASS: a post in a slot that has already passed becomes `posted` with a `dry_run` delivery whose
 * request is the LinkedIn payload for its channel, and the calendar shows it posted with the
 * dry-run banner.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);

test.describe('Calendar publisher on DEV (result-asserting)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(12 * 60_000);

  test('a due post is claimed by the engine, recorded as a dry run, and shown as posted', async ({ page }) => {
    // Yesterday 9 AM ET: already due, whenever the test runs.
    const day = easternToday(-1);
    const title = `E2E publisher ${Date.now()}`;
    const seeded = await seedCalendarPost({ title, scheduledDate: day, slot: 'morning', channels: ['li_personal'],
      linkedinContent: `${title}\n\nA dry-run post from the E2E suite.` });
    try {
      let row: any;
      await expect.poll(async () => {
        [row] = await supaGet<any>('social_schedule_v2', `id=eq.${seeded.id}&select=state,attempts,posted_at`);
        return row?.state;
      }, { timeout: 11 * 60_000, intervals: [15_000] }).toBe('posted');
      expect(row.attempts).toBe(1);
      const [d] = await supaGet<any>('social_schedule_deliveries_v2', `schedule_id=eq.${seeded.id}&select=*`);
      expect(d).toMatchObject({ channel: 'li_personal', status: 'dry_run' });
      expect(d.request.post.target).toEqual({ targetType: 'linkedin' }); // the profile: no page id
      expect(d.request.post.accountId).toBe('9115');
      expect(d.request.post.content.text).toContain(title);

      await page.goto(`/newsletter/calendar?week=${day}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(`post-${seeded.display_number}`)).toContainText('Posted', { timeout: 20_000 });
      await expect(page.getByTestId('dry-run-banner')).toBeVisible();
      await page.getByTestId(`post-${seeded.display_number}`).click();
      await expect(page.getByTestId('deliveries')).toContainText('Personal LinkedIn profile: Dry run (not sent)');
    } finally {
      await deleteCalendarPost(seeded.id);
    }
    expect(DEMO_USER_ID).toBeTruthy();
  });
});
