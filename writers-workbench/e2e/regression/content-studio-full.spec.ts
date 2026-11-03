import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';
import { cleanupStudio, seedStudio, STUDIO_EDITION, type StudioFixture } from '../pages/studio';

/**
 * Content Studio FULL data path on DEV (heavy: real engine jobs, two paid Claude calls, the real
 * publisher tick). Pass B.
 *
 *   slate → select 1-2 → Generate drafts (engine studio.generate, Dev Radar prompt, ONE call)
 *   → review → Revise with AI (ONE call) → approve → Publish now (dry run: SOCIAL_POSTING_MODE is not
 *   live on DEV) → the publisher posts it as `dry_run` and it shows Posted on the Post calendar
 *   → put it and slate topic 3 in the next issue → Generate the issue → the stories approval gate holds
 *   EXACTLY those two stories in that order (no LLM pick) and the approval screen shows them
 *   → the per-item RSS feed lists the post.
 *
 * PASS: each step is visible in the DB (social_schedule_v2, its deliveries, newsletter_issue_items_v2,
 * newsletter_approvals_v2.payload) and on screen. The approval gate is left open on the disposable
 * edition and removed with it (no segment / image spend).
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const enc = encodeURIComponent;

test.describe('Content Studio full path (engine + publisher + newsletter)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(25 * 60_000);

  test('generate → revise → approve → publish now → calendar → newsletter issue with exactly the chosen posts → RSS', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-full`);
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('slate-topic-1')).toContainText(fx.topics[0].title, { timeout: 30_000 });

      // ── Generate drafts for 1-2 (one Dev Radar drafting call) ─────────────────────────────
      await page.getByTestId('slate-range').fill('1-2');
      await page.getByTestId('slate-range-apply').click();
      await page.getByTestId('slate-generate').click();
      await expect(page.getByTestId('studio-activity')).toContainText('Drafting 2 topics');
      let drafts: any[] = [];
      await expect.poll(async () => {
        drafts = await supaGet('social_schedule_v2', `edition_id=eq.${enc(fx!.edition)}&state=eq.draft&select=*&order=display_number`);
        return drafts.length;
      }, { timeout: 8 * 60_000, intervals: [10_000] }).toBeGreaterThanOrEqual(1);
      const d = drafts[0];
      expect(d).toMatchObject({ source: 'studio', scheduled_date: null, scheduled_at: null });
      expect([fx.topics[0].id, fx.topics[1].id]).toContain(d.radar_topic_id);
      const topicUrl = fx.topics.find((t) => t.id === d.radar_topic_id)!.url;
      expect(d.linkedin_content).toContain(topicUrl); // the roundup post IS its link
      // The run reports per-topic outcome; the slate shows the topic as a draft.
      await expect(page.getByTestId('studio-activity')).toContainText(/Drafted \d/, { timeout: 120_000 });

      // ── Review + revise with AI (one call) ───────────────────────────────────────────────
      await page.getByTestId('studio-tab-review').click();
      const card = page.getByTestId(`draft-${d.display_number}`);
      await card.getByTestId(`draft-${d.display_number}-open`).click();
      await expect(card.getByTestId(`draft-${d.display_number}-linkedin`)).toContainText(topicUrl);
      await card.getByTestId(`draft-${d.display_number}-instruction`).fill('Make it shorter and keep the link exactly as it is.');
      await card.getByTestId(`draft-${d.display_number}-revise`).click();
      let revised: any;
      await expect.poll(async () => {
        [revised] = await supaGet('social_schedule_v2', `id=eq.${d.id}&select=*`);
        return (revised?.studio?.revisions ?? []).length;
      }, { timeout: 5 * 60_000, intervals: [5_000] }).toBeGreaterThanOrEqual(1);
      expect(revised.studio.previous.linkedin_content).toBe(d.linkedin_content);
      expect(revised.linkedin_content).toContain(topicUrl);

      // ── Approve, then publish now on the personal profile only ───────────────────────────
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-review').click();
      await page.getByTestId(`draft-${d.display_number}-approve`).click();
      await expect.poll(async () => (await supaGet('social_schedule_v2', `id=eq.${d.id}&select=state`))[0]?.state, { timeout: 15_000 }).toBe('approved');
      await page.getByTestId(`draft-${d.display_number}-open`).click();
      const bar = page.getByTestId(`draft-${d.display_number}`);
      for (const box of await bar.getByRole('checkbox', { name: /^Channel / }).all()) {
        const label = (await box.getAttribute('aria-label')) ?? '';
        if (/Personal LinkedIn profile/.test(label)) await box.check();
        else await box.uncheck();
      }
      await bar.getByRole('button', { name: 'Publish now' }).click();
      await expect.poll(async () => (await supaGet('social_schedule_v2', `id=eq.${d.id}&select=state,channels,post_at`))[0], { timeout: 15_000 })
        .toMatchObject({ state: 'pending', channels: ['li_personal'] });

      // The publisher (every 5 minutes) claims it and records a dry run.
      let row: any;
      await expect.poll(async () => {
        [row] = await supaGet('social_schedule_v2', `id=eq.${d.id}&select=state,scheduled_date,display_number`);
        return row?.state;
      }, { timeout: 11 * 60_000, intervals: [15_000] }).toBe('posted');
      const [delivery] = await supaGet('social_schedule_deliveries_v2', `schedule_id=eq.${d.id}&select=channel,status`);
      expect(delivery).toMatchObject({ channel: 'li_personal', status: 'dry_run' });
      await page.goto(`/newsletter/calendar?week=${row.scheduled_date}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(`post-${d.display_number}`)).toContainText('Posted', { timeout: 20_000 });

      // ── The next issue: the post, then slate topic 3 ─────────────────────────────────────
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-issue').click();
      await page.getByTestId(`issue-add-post-${d.display_number}`).click();
      await page.getByTestId('issue-add-topic-3').click();
      await page.getByTestId('issue-save').click();
      await expect(page.getByTestId('issue-item-2')).toContainText(fx.topics[2].title);
      await expect(page.getByTestId('issue-generate')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('issue-generate').click();
      await expect(page).toHaveURL(/\/newsletter\/execution\/[^/]+/, { timeout: 30_000 });
      const execId = decodeURIComponent(page.url().split('/newsletter/execution/')[1] ?? '');

      // The stories gate: exactly the chosen two, in order.
      let gate: any;
      await expect.poll(async () => {
        [gate] = await supaGet('newsletter_approvals_v2', `execution_id=eq.${enc(execId)}&select=token,stage,payload&order=created_at.desc&limit=1`);
        return gate?.stage ?? null;
      }, { timeout: 4 * 60_000, intervals: [5_000] }).toMatch(/stories/);
      const titles = (gate.payload?.top_selected_stories ?? []).map((s: any) => s.title);
      expect(titles).toEqual([revised.title, fx.topics[2].title]);
      const sel = (await supaGet('newsletter_issue_selections_v2', `edition_id=eq.${enc(fx.edition)}&select=status,execution_id`))[0];
      expect(sel).toMatchObject({ status: 'locked', execution_id: execId });
      await page.goto(`/newsletter/approvals/${gate.token}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(fx.topics[2].title).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(revised.title).first()).toBeVisible();

      // ── RSS: the posted post is in the per-item feed ─────────────────────────────────────
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-issue').click();
      const itemsUrl = (await page.getByTestId('feed-items-url').textContent())!.trim();
      const xml = await (await fetch(itemsUrl)).text();
      expect(xml).toContain(topicUrl);
      expect(xml).not.toMatch(/want these every week|comment ['‘’]?newsletter/i);
    } finally {
      await cleanupStudio(fx);
    }
  });
});
