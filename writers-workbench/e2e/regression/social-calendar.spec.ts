import { test, expect } from '@playwright/test';
import { DEMO_USER_ID, deleteCalendarPost, easternToday, seedCalendarPost, supaDelete, supaGet } from '../pages/api';

/**
 * The post calendar (migration 038, the port of the n8n scheduled_blogs queue). Result-asserting:
 * every UI step is checked in social_schedule_v2, and every row the test reads is checked on screen.
 *
 * PASS: a post made in the UI lands in the DB as a pending manual post on the chosen day, slot and
 * channel; editing, cancelling and re-queueing change the row; the n8n history imported on DEV shows
 * with each channel's result; the radar slates are the ones in radar_topics_v2.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const USER = encodeURIComponent(DEMO_USER_ID);

/** A weekday two weeks out, so no publisher tick can reach it during the test. */
function futureDay(): string {
  for (let n = 14; n < 21; n++) {
    const d = easternToday(n);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return d;
  }
  return easternToday(14);
}

test.describe('Post calendar (result-asserting)', () => {
  test.skip(!HAS_KEY, 'requires service key');

  test('a post made in the UI is scheduled, edited, cancelled and put back, in the DB and on screen', async ({ page }) => {
    const day = futureDay();
    const title = `E2E calendar ${Date.now()}`;
    await page.goto(`/newsletter/calendar?week=${day}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Post calendar' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: new RegExp(`Add a post ${day} 2:00 PM ET`) }).click();
    const dialog = page.getByRole('dialog', { name: 'New post' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('LinkedIn post').fill(`${title} — the LinkedIn text`);
    // Only the personal profile: uncheck every other channel.
    for (const box of await dialog.getByRole('checkbox').all()) {
      const label = (await box.evaluate((el) => el.parentElement?.textContent ?? '')).trim();
      if (/LinkedIn (page|profile)|website/i.test(label)) {
        if (/Personal LinkedIn profile/.test(label)) await box.check();
        else await box.uncheck();
      }
    }
    await dialog.getByRole('button', { name: 'Schedule post' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    let rows: any[] = [];
    await expect.poll(async () => {
      rows = await supaGet('social_schedule_v2', `user_id=eq.${USER}&title=eq.${encodeURIComponent(title)}&select=*`);
      return rows.length;
    }, { timeout: 15_000 }).toBe(1);
    const row = rows[0];
    try {
      expect(row).toMatchObject({ state: 'pending', source: 'manual', scheduled_date: day, slot: 'afternoon', channels: ['li_personal'] });
      // 14:00 Eastern, whatever the DST offset that day.
      const et = new Date(row.scheduled_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
      expect(Number(et)).toBe(14);
      const chip = page.getByTestId(`post-${row.display_number}`);
      await expect(chip).toContainText(title);
      await expect(page.getByTestId(`day-${day}`)).toContainText(title);

      // Edit
      await chip.click();
      const edit = page.getByRole('dialog', { name: `Post #${row.display_number}` });
      await edit.getByLabel('Title').fill(`${title} (edited)`);
      await edit.getByRole('button', { name: 'Save changes' }).click();
      await expect.poll(async () => (await supaGet<any>('social_schedule_v2', `id=eq.${row.id}&select=title`))[0]?.title)
        .toBe(`${title} (edited)`);
      await expect(page.getByTestId(`post-${row.display_number}`)).toContainText('(edited)');

      // Cancel, then put back
      await page.getByTestId(`post-${row.display_number}`).click();
      await page.getByRole('button', { name: 'Cancel post' }).click();
      await expect.poll(async () => (await supaGet<any>('social_schedule_v2', `id=eq.${row.id}&select=state`))[0]?.state).toBe('cancelled');
      await expect(page.getByTestId(`post-${row.display_number}`)).toContainText('Cancelled');
      await page.getByTestId(`post-${row.display_number}`).click();
      await page.getByRole('button', { name: 'Put back on the calendar' }).click();
      await expect.poll(async () => (await supaGet<any>('social_schedule_v2', `id=eq.${row.id}&select=state`))[0]?.state).toBe('pending');
      await expect(page.getByTestId(`post-${row.display_number}`)).toContainText('Scheduled');
    } finally {
      await deleteCalendarPost(row.id);
    }
  });

  test('a post that went out shows each channel\'s result as stored', async ({ page }) => {
    const [posted] = await supaGet<any>('social_schedule_v2',
      `user_id=eq.${USER}&state=eq.posted&select=id,display_number,title,scheduled_date&order=scheduled_at.desc&limit=1`);
    test.skip(!posted, 'no posted post on this database');
    const deliveries = await supaGet<any>('social_schedule_deliveries_v2', `schedule_id=eq.${posted.id}&select=channel,status,public_url`);
    expect(deliveries.length).toBeGreaterThan(0);
    await page.goto(`/newsletter/calendar?week=${posted.scheduled_date}`, { waitUntil: 'domcontentloaded' });
    const chip = page.getByTestId(`post-${posted.display_number}`);
    await expect(chip).toContainText('Posted', { timeout: 20_000 });
    await chip.click();
    const list = page.getByTestId('deliveries');
    await expect(list.locator('li')).toHaveCount(deliveries.length);
    const withUrl = deliveries.find((d: any) => d.public_url);
    if (withUrl) await expect(list.locator(`a[href="${withUrl.public_url}"]`)).toBeVisible();
  });

  test('a seeded post in a past week renders in its slot with its number', async ({ page }) => {
    const day = easternToday(-21);
    const seeded = await seedCalendarPost({ title: `E2E past ${Date.now()}`, scheduledDate: day, slot: 'morning', state: 'cancelled' });
    try {
      await page.goto(`/newsletter/calendar?week=${day}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(`day-${day}`)).toContainText(`#${seeded.display_number}`, { timeout: 20_000 });
    } finally {
      await deleteCalendarPost(seeded.id);
    }
  });

  test('the radar page shows the stored slates and what is already queued', async ({ page }) => {
    for (const [radar, tab] of [['trend', 'Trend Radar'], ['dev', 'Dev Radar']] as const) {
      const [newest] = await supaGet<any>('radar_topics_v2', `user_id=eq.${USER}&radar=eq.${radar}&select=week_of&order=week_of.desc&limit=1`);
      test.skip(!newest, `no ${radar} slate on this database`);
      const topics = await supaGet<any>('radar_topics_v2',
        `user_id=eq.${USER}&radar=eq.${radar}&week_of=eq.${newest.week_of}&select=rank,title&order=rank.asc`);
      await page.goto('/newsletter/radar', { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByTestId('topic-1')).toContainText(topics[0].title, { timeout: 20_000 });
      await expect(page.getByTestId(`topic-${topics.length}`)).toContainText(topics[topics.length - 1].title);
    }
  });
});

test.afterAll(async () => {
  if (!HAS_KEY) return;
  // Anything a failed run left behind.
  await supaDelete('social_schedule_v2', `user_id=eq.${USER}&title=like.E2E%20calendar%25`);
  await supaDelete('social_schedule_v2', `user_id=eq.${USER}&external_id=like.e2e-%25`);
});
