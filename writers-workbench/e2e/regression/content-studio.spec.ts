import { test, expect, type Page } from '@playwright/test';
import { DEMO_USER_ID, easternToday, supaGet } from '../pages/api';
import {
  STUDIO_EDITION, apiAs, cleanupStudio, createOtherUser, deleteOtherUser, seedStudio, seedStudioPost,
  type OtherUser, type StudioFixture,
} from '../pages/studio';

/**
 * Content Studio (migration 050) — the light, LLM-free data path. Result-asserting: every UI and
 * assistant step is checked in the DB, and every seeded row is checked on screen.
 *
 * PASS: the slate shows the week's topics and which became posts; a draft is edited inline, approved,
 * scheduled to a day + slot (pending in social_schedule_v2, shown on the Post calendar) and cancelled
 * from the queue; assistant commands ("list my drafts", "approve #N", "schedule #N tomorrow
 * afternoon", "cancel #N", "put 1-3 in the newsletter", "remove #N from the newsletter") change the
 * same rows; the next-issue selection is saved in order; the RSS feeds are valid RSS with only posted
 * posts and no subscribe CTA / hashtags; and a different user gets nothing — 404 on every studio
 * route, an empty edition list, and RLS returns none of the owner's studio rows.
 *
 * Isolation: each test makes its own disposable edition (`e2e-studio-<RUN_TAG>-…`) and a fake 1990s
 * slate week, and deletes exactly those rows. The real ai-mvp / ai-dev-roundup editions are only read.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const enc = encodeURIComponent;

async function post(id: string): Promise<any> {
  return (await supaGet('social_schedule_v2', `id=eq.${id}&select=*`))[0];
}

/** A weekday two weeks out, so no publisher tick reaches it during the test. */
function futureDay(): string {
  for (let n = 14; n < 21; n++) {
    const d = easternToday(n);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return d;
  }
  return easternToday(14);
}

async function openStudio(page: Page, fx: StudioFixture): Promise<void> {
  // ?week= opens the fake (1990s) slate week, which is older than the recent-weeks list.
  await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('content-studio')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('slate-week')).toHaveValue(fx.week, { timeout: 15_000 });
  await expect(page.getByTestId('slate-topic-1')).toContainText(fx.topics[0].title, { timeout: 15_000 });
}

async function ask(page: Page, message: string): Promise<string> {
  const before = await page.getByTestId('assistant-reply').count();
  await page.getByTestId('assistant-input').fill(message);
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-reply')).toHaveCount(before + 1, { timeout: 60_000 });
  return (await page.getByTestId('assistant-reply').nth(before).textContent()) ?? '';
}

test.describe('Content Studio (result-asserting, no LLM)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(4 * 60_000);

  test('slate → review → edit → approve → schedule → calendar → cancel', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-a`);
      const a = await seedStudioPost(fx, { title: `E2E ${fx.edition} draft A`, state: 'draft', topicId: fx.topics[0].id });
      await openStudio(page, fx);

      // The slate shows source/type/angle/link, and which topic already became a post.
      await expect(page.getByTestId('slate-topic-2')).toContainText('VIDEO');
      await expect(page.getByTestId('slate-topic-1-post')).toContainText(`#${a.display_number} · Draft`);
      await page.getByTestId('slate-range').fill('1, 3');
      await page.getByTestId('slate-range-apply').click();
      await expect(page.getByLabel('Select topic 1')).toBeChecked();
      await expect(page.getByLabel('Select topic 3')).toBeChecked();
      await expect(page.getByLabel('Select topic 2')).not.toBeChecked();
      await expect(page.getByTestId('slate-generate')).toHaveText(/Generate 2 drafts/);

      // Review: the LinkedIn text with its count; edit inline.
      await page.getByTestId('studio-tab-review').click();
      const card = page.getByTestId(`draft-${a.display_number}`);
      await card.getByTestId(`draft-${a.display_number}-open`).click();
      const before = (await post(a.id)).linkedin_content as string;
      await expect(card.getByTestId(`draft-${a.display_number}-count`)).toHaveText(`${before.length} / 3000`);
      await card.getByTestId(`draft-${a.display_number}-edit`).click();
      const edited = `Edited in the studio ${fx.edition}\n🔗 Read: https://example.com/e2e`;
      await card.getByLabel('LinkedIn text').fill(edited);
      await card.getByTestId(`draft-${a.display_number}-save`).click();
      await expect.poll(async () => (await post(a.id)).linkedin_content, { timeout: 15_000 }).toBe(edited);

      // Approve.
      await card.getByTestId(`draft-${a.display_number}-approve`).click();
      await expect.poll(async () => (await post(a.id)).state, { timeout: 15_000 }).toBe('approved');
      await expect(card.getByTestId(`draft-${a.display_number}-state`)).toHaveText('Approved', { timeout: 15_000 });

      // Schedule to a day + slot from the publish bar.
      const day = futureDay();
      await card.getByLabel(`Select #${a.display_number}`).check();
      const bar = page.getByTestId('publish-bar');
      await bar.getByTestId('schedule-mode').selectOption('slot');
      await bar.getByLabel('Day').fill(day);
      await bar.getByLabel('Slot').selectOption('afternoon');
      await bar.getByTestId('bulk-schedule').click();
      await expect.poll(async () => {
        const r = await post(a.id);
        return `${r.state} ${r.scheduled_date} ${r.slot}`;
      }, { timeout: 15_000 }).toBe(`pending ${day} afternoon`);
      expect((await post(a.id)).channels).toEqual(['li_personal']);

      // The same post on the Post calendar.
      await page.goto(`/newsletter/calendar?week=${day}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(`post-${a.display_number}`)).toBeVisible({ timeout: 20_000 });

      // The queue, and cancel from it.
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-queue').click();
      await expect(page.getByTestId(`queue-${a.display_number}-state`)).toHaveText('Scheduled', { timeout: 15_000 });
      await page.getByTestId(`queue-${a.display_number}-cancel`).click();
      await expect.poll(async () => (await post(a.id)).state, { timeout: 15_000 }).toBe('cancelled');
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('assistant commands act on the same data', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-b`);
      const c = await seedStudioPost(fx, { title: `E2E ${fx.edition} draft C`, state: 'draft', topicId: fx.topics[2].id });
      await openStudio(page, fx);

      expect(await ask(page, 'list my drafts')).toContain(`#${c.display_number}`);
      expect(await ask(page, `approve #${c.display_number}`)).toContain(`Approved: #${c.display_number}`);
      expect((await post(c.id)).state).toBe('approved');

      const reply = await ask(page, `schedule #${c.display_number} tomorrow afternoon`);
      expect(reply).toContain(`#${c.display_number}`);
      const row = await post(c.id);
      expect(row).toMatchObject({ state: 'pending', scheduled_date: easternToday(1), slot: 'afternoon' });

      expect(await ask(page, `cancel #${c.display_number}`)).toContain(`Cancelled: #${c.display_number}`);
      expect((await post(c.id)).state).toBe('cancelled');
      expect(await ask(page, 'cancel #99999999')).toMatch(/No post/);

      // Requeue it back to review so it can go in the issue as a post.
      expect(await ask(page, `requeue #${c.display_number}`)).toContain('Requeued');
      expect(await ask(page, `unschedule #${c.display_number}`)).toContain(`#${c.display_number}`);
      expect((await post(c.id)).state).toBe('approved');

      // "put 1-3 in the newsletter": ranks 1 and 2 as topics, rank 3 as its post C (the reviewed text).
      await ask(page, 'put 1-3 in the newsletter');
      const sel = (await supaGet('newsletter_issue_selections_v2', `edition_id=eq.${enc(fx.edition)}&status=eq.open&select=id`))[0];
      expect(sel).toBeTruthy();
      let items = await supaGet('newsletter_issue_items_v2', `selection_id=eq.${sel.id}&select=position,kind,schedule_id,radar_topic_id&order=position`);
      expect(items.map((i: any) => i.schedule_id ?? i.radar_topic_id)).toEqual([fx.topics[0].id, fx.topics[1].id, c.id]);
      expect(await ask(page, 'show the newsletter')).toContain(fx.topics[0].title);
      await ask(page, `remove #${c.display_number} from the newsletter`);
      items = await supaGet('newsletter_issue_items_v2', `selection_id=eq.${sel.id}&select=position,radar_topic_id&order=position`);
      expect(items.map((i: any) => i.radar_topic_id)).toEqual([fx.topics[0].id, fx.topics[1].id]);
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('the next issue is chosen in order, and the RSS feeds serve only posted posts', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-c`);
      const posted = await seedStudioPost(fx, { title: `E2E ${fx.edition} posted`, state: 'posted' });
      const draft = await seedStudioPost(fx, { title: `E2E ${fx.edition} still a draft`, state: 'draft' });
      await openStudio(page, fx);
      await page.getByTestId('studio-tab-issue').click();
      await page.getByTestId(`issue-add-topic-2`).click();
      await page.getByTestId(`issue-add-post-${posted.display_number}`).click();
      await page.getByTestId('issue-save').click();
      await expect.poll(async () => {
        const sel = (await supaGet('newsletter_issue_selections_v2', `edition_id=eq.${enc(fx!.edition)}&status=eq.open&select=id`))[0];
        if (!sel) return [];
        const it = await supaGet('newsletter_issue_items_v2', `selection_id=eq.${sel.id}&select=position,schedule_id,radar_topic_id&order=position`);
        return it.map((i: any) => i.schedule_id ?? i.radar_topic_id);
      }, { timeout: 15_000 }).toEqual([fx.topics[1].id, posted.id]);
      await expect(page.getByTestId('issue-item-1')).toContainText(fx.topics[1].title);
      await expect(page.getByTestId('issue-item-2')).toContainText(`E2E ${fx.edition} posted`);

      // RSS: the URLs the studio shows, fetched without any login.
      const itemsUrl = (await page.getByTestId('feed-items-url').textContent())!.trim();
      const digestUrl = (await page.getByTestId('feed-digest-url').textContent())!.trim();
      expect(itemsUrl).toMatch(/\/feeds\/[A-Za-z0-9_-]{32}\/items\.xml$/);
      const items = await fetch(itemsUrl);
      expect(items.status).toBe(200);
      expect(items.headers.get('content-type')).toContain('application/rss+xml');
      const xml = await items.text();
      expect(xml).toContain(`<title>E2E ${fx.edition} posted</title>`);
      expect(xml).not.toContain(`E2E ${fx.edition} still a draft`);
      expect(draft.display_number).toBeGreaterThan(0);
      expect(xml).not.toMatch(/want these every week|comment 'newsletter'|#AI/i);
      const digest = await (await fetch(digestUrl)).text();
      for (const doc of [xml, digest]) {
        const ok = await page.evaluate((s) => !new DOMParser().parseFromString(s, 'application/xml').querySelector('parsererror'), doc);
        expect(ok, 'well-formed XML').toBe(true);
        expect(doc).toMatch(/<rss version="2.0"/);
      }
      expect((await fetch(itemsUrl.replace(/feeds\/[^/]+\//, 'feeds/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/'))).status).toBe(404);
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('a different user gets nothing: no editions, 404 everywhere, RLS hides the rows', async () => {
    let fx: StudioFixture | null = null;
    let other: OtherUser | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-d`);
      const d = await seedStudioPost(fx, { title: `E2E ${fx.edition} private draft`, state: 'draft' });
      other = await createOtherUser();
      expect(other.userId).not.toBe(DEMO_USER_ID);
      const t = other.token;

      const list = await apiAs(t, 'GET', '/api/studio/editions');
      expect(list.status).toBe(200);
      expect(list.json.data).toEqual([]);
      for (const ed of [fx.edition, 'ai-dev-roundup', 'ai-mvp']) {
        const e = enc(ed);
        for (const [m, p, b] of [
          ['GET', `/api/studio/${e}`], ['GET', `/api/studio/${e}/slate`], ['GET', `/api/studio/${e}/posts?status=all`],
          ['GET', `/api/studio/${e}/issue`], ['GET', `/api/studio/${e}/feeds`], ['POST', `/api/studio/${e}/feeds/rotate`],
          ['POST', `/api/studio/${e}/assistant`, { message: 'list my drafts' }],
          ['POST', `/api/studio/${e}/generate`, { numbers: '1' }],
          ['PUT', `/api/studio/${e}/issue`, { items: [] }],
          ['POST', `/api/studio/${e}/posts/actions`, { ids: [d.id], action: 'discard' }],
          ['PATCH', `/api/studio/${e}/posts/${d.id}`, { title: 'not yours' }],
        ] as Array<[string, string, unknown?]>) {
          const r = await apiAs(t, m, p, b);
          expect(r.status, `${m} ${p}`).toBe(404);
        }
      }
      // The owner's draft is untouched.
      expect(await post(d.id)).toMatchObject({ state: 'draft', title: `E2E ${fx.edition} private draft` });

      // RLS: with the other user's own token, Supabase returns none of the owner's studio rows.
      const supa = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
      const anon = process.env.VITE_SUPABASE_ANON_KEY || '';
      for (const q of [
        `social_schedule_v2?edition_id=eq.${enc(fx.edition)}&select=id`,
        `newsletter_issue_selections_v2?edition_id=eq.${enc(fx.edition)}&select=id`,
        `newsletter_edition_feeds_v2?select=edition_id`,
        `radar_topics_v2?user_id=eq.${enc(DEMO_USER_ID)}&select=id&limit=1`,
      ]) {
        const r = await fetch(`${supa}/rest/v1/${q}`, { headers: { apikey: anon, Authorization: `Bearer ${t}` } });
        expect(r.status, q).toBe(200);
        expect(await r.json(), q).toEqual([]);
      }
    } finally {
      await deleteOtherUser(other);
      await cleanupStudio(fx);
    }
  });
});
