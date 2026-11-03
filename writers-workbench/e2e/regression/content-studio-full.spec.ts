import { test, expect, type Page } from '@playwright/test';
import { supaGet } from '../pages/api';
import { cleanupStudio, nextThursdayEt, seedStudio, seedStudioPost, STUDIO_EDITION, type StudioFixture } from '../pages/studio';

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

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Paths verified live on DEV 2026-11-03 and kept covered here (live-verification PR).
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  const CTA = 'techahir.com/3day-minimum-viable-product-mvp';
  const TEXT_FIELDS = ['title', 'body_md', 'linkedin_content', 'seo_title', 'meta_description', 'category'] as const;

  /** A Trend Radar post: the blog fields, the CTA + Sources line, and a LinkedIn article under the cap. */
  function expectBlog(p: any, sourceUrl: string): void {
    expect(p.seo_title.length, 'SEO title').toBeGreaterThan(10);
    expect(p.seo_title.length).toBeLessThanOrEqual(120);
    expect(p.meta_description.length, 'meta').toBeGreaterThan(40);
    expect(p.meta_description.length).toBeLessThanOrEqual(300);
    expect(p.category, 'category').toMatch(/^[A-Z0-9 &/-]{2,60}$/);
    expect(p.body_md.length, 'blog markdown').toBeGreaterThan(1500);
    expect(p.body_md, 'CTA link on the blog').toContain(CTA);
    expect(p.body_md, 'Sources line').toMatch(/^[*_]*sources?[*_]*:.*$/im);
    expect(p.body_md, 'the primary source is cited').toContain(sourceUrl);
    expect(p.linkedin_content.length, 'LinkedIn text').toBeGreaterThan(300);
    expect(p.linkedin_content.length).toBeLessThanOrEqual(3000);
    expect(p.linkedin_content, 'CTA link on LinkedIn').toContain(CTA);
    expect(`${p.body_md}\n${p.linkedin_content}`, 'no format delimiters leak').not.toMatch(/===|^SEO_TITLE:|^META:/m);
  }

  async function openDraft(page: Page, fx: StudioFixture, n: number) {
    await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('studio-tab-review').click();
    const card = page.getByTestId(`draft-${n}`);
    await card.getByTestId(`draft-${n}-open`).click();
    return card;
  }

  const row = async (id: string) => (await supaGet('social_schedule_v2', `id=eq.${id}&select=*`))[0];
  const revisions = async (id: string) => ((await row(id))?.studio?.revisions ?? []).length;

  test('Trend Radar draft: generate → revise → regenerate → undo keep the blog fields and the LinkedIn text', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-trend`, { radar: 'trend' });
      const source = fx.topics[0].url;
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('slate-topic-1')).toContainText(fx.topics[0].title, { timeout: 30_000 });
      await page.getByTestId('slate-range').fill('1');
      await page.getByTestId('slate-range-apply').click();
      await page.getByTestId('slate-generate').click();
      let v0: any;
      await expect.poll(async () => {
        [v0] = await supaGet('social_schedule_v2', `edition_id=eq.${enc(fx!.edition)}&select=*`);
        return v0?.state ?? null;
      }, { timeout: 8 * 60_000, intervals: [10_000] }).toBe('draft');
      expect(v0).toMatchObject({ source: 'studio', include_image: true, scheduled_date: null, radar_topic_id: fx.topics[0].id });
      expectBlog(v0, source);
      const n = v0.display_number;

      // ── Revise with AI ──────────────────────────────────────────────────────────────────
      let card = await openDraft(page, fx, n);
      await expect(card.getByTestId(`draft-${n}-blog`)).toContainText(/\S/);
      await card.getByTestId(`draft-${n}-instruction`).fill('Change the category to DEVELOPER TOOLS and make the opening hook punchier. Keep the CTA link and the Sources line exactly.');
      await card.getByTestId(`draft-${n}-revise`).click();
      await expect.poll(() => revisions(v0.id), { timeout: 5 * 60_000, intervals: [5_000] }).toBe(1);
      const v1 = await row(v0.id);
      expect(v1.category).toBe('DEVELOPER TOOLS');
      expectBlog(v1, source);
      for (const k of TEXT_FIELDS) expect(v1.studio.previous[k], `previous.${k}`).toBe(v0[k]);
      expect(v1.humanize, 'a revision is not humanized text').toBeNull();
      expect(v1.studio.previous.humanize).toEqual(v0.humanize);

      // ── Regenerate from the topic ───────────────────────────────────────────────────────
      card = await openDraft(page, fx, n);
      await card.getByRole('button', { name: 'Regenerate' }).click();
      await expect.poll(() => revisions(v0.id), { timeout: 8 * 60_000, intervals: [10_000] }).toBe(2);
      const v2 = await row(v0.id);
      expectBlog(v2, source);
      for (const k of TEXT_FIELDS) expect(v2.studio.previous[k], `previous.${k}`).toBe(v1[k]);

      // ── Undo: back to the revised version, text AND humanizer record ────────────────────
      card = await openDraft(page, fx, n);
      await card.getByRole('button', { name: 'Undo last change' }).click();
      await expect.poll(() => revisions(v0.id), { timeout: 15_000 }).toBe(3);
      const v3 = await row(v0.id);
      for (const k of TEXT_FIELDS) expect(v3[k], `undo restored ${k}`).toBe(v1[k]);
      expect(v3.humanize).toEqual(v1.humanize);
      card = await openDraft(page, fx, n);
      await expect(card.getByTestId(`draft-${n}-title`)).toHaveText(v1.title);
      await expect(card.getByText(`Category: ${v1.category}`)).toBeVisible();
      await expect(card.getByTestId(`draft-${n}-count`)).toContainText(`${v1.linkedin_content.length} /`);
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('a chosen https image: the dry-run deliveries record it in the blog and LinkedIn requests', async ({ page }) => {
    let fx: StudioFixture | null = null;
    const img = 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-img`);
      const p = await seedStudioPost(fx, { title: `E2E ${fx.edition} chosen image`, state: 'approved', imageUrl: img, channels: ['website', 'li_personal'] });
      const card = await openDraft(page, fx, p.display_number);
      await expect(card.getByRole('link', { name: img })).toBeVisible();
      for (const box of await card.getByRole('checkbox', { name: /^Channel / }).all()) {
        const label = (await box.getAttribute('aria-label')) ?? '';
        if (/Personal LinkedIn profile|TechAhir website/.test(label)) await box.check();
        else await box.uncheck();
      }
      await card.getByRole('button', { name: 'Publish now' }).click();
      await expect.poll(async () => (await row(p.id))?.state, { timeout: 11 * 60_000, intervals: [15_000] }).toBe('posted');
      const deliveries = await supaGet('social_schedule_deliveries_v2', `schedule_id=eq.${p.id}&select=channel,status,detail,request`);
      const by = Object.fromEntries(deliveries.map((d: any) => [d.channel, d]));
      expect(by.website.status).toBe('dry_run');
      expect(by.website.request.coverImage).toEqual({ sourceUrl: img, fetchedWhenLive: true });
      expect(by.li_personal.status).toBe('dry_run');
      expect(by.li_personal.request.post.content.mediaUrls).toEqual([img]);
      for (const d of deliveries) expect(d.detail).toContain(`would use the chosen image ${img}`);
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('assistant: a free-form compound message acts on the right post, with studio ops only, and charges as expected', async ({ page }) => {
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-ast`);
      const a = await seedStudioPost(fx, { title: `E2E ${fx.edition} first`, state: 'draft' });
      const b = await seedStudioPost(fx, { title: `E2E ${fx.edition} second`, state: 'draft' });
      const c = await seedStudioPost(fx, { title: `E2E ${fx.edition} third`, state: 'draft' });
      // The Review tab lists newest first: c, b, a — so "the second draft" is b.
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-review').click();
      const cards = page.locator('[data-testid^="draft-"][data-testid$="-title"]');
      await expect(cards.nth(1)).toHaveText(`E2E ${fx.edition} second`);
      const [{ role }] = await supaGet('users_v2', `user_id=eq.${enc('+14105914612')}&select=role`);
      const answered = page.waitForResponse((r) => r.url().includes(`/api/studio/${enc(fx!.edition)}/assistant`));
      await page.getByTestId('assistant-input').fill('make the second draft punchier and schedule it for Thursday afternoon');
      await page.getByTestId('assistant-send').click();
      const data = (await (await answered).json()).data;
      expect(data.op, 'one studio op: the batch').toBe('batch');
      expect(data.kind).toBe('queued');
      // The batch is charged for its one revise (scheduling is free); an admin/superuser is never charged.
      if (['admin', 'superuser'].includes(role)) expect(data.creditsCharged).toBe(0);
      else expect(data.creditsCharged).toBeGreaterThan(0);
      await expect(page.getByTestId('assistant-reply').last()).not.toContainText(/one (action )?at a time/i);
      await expect.poll(async () => {
        const r = await row(b.id);
        return [r.state, r.scheduled_date, r.slot, (r.studio?.revisions ?? []).some((x: any) => String(x.what).startsWith('revise:'))];
      }, { timeout: 5 * 60_000, intervals: [5_000] }).toEqual(['pending', nextThursdayEt(), 'afternoon', true]);
      expect((await row(b.id)).linkedin_content).toContain('https://example.com/e2e'); // the link survived the rewrite
      for (const other of [a, c]) {
        const r = await row(other.id);
        expect([r.state, (r.studio?.revisions ?? []).length], `#${other.display_number} untouched`).toEqual(['draft', 0]);
      }
    } finally {
      await cleanupStudio(fx);
    }
  });

  // Sends two real emails to the demo user's own address (Postal): opt-in.
  test('email me a draft (with its chosen image) and the week\'s slate', async ({ page }) => {
    test.skip(process.env.E2E_STUDIO_EMAIL !== '1', 'set E2E_STUDIO_EMAIL=1 to send the two preview emails');
    let fx: StudioFixture | null = null;
    const img = 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-mail`);
      const p = await seedStudioPost(fx, { title: `E2E ${fx.edition} emailed`, state: 'draft', imageUrl: img });
      const card = await openDraft(page, fx, p.display_number);
      await card.getByRole('button', { name: 'Email me' }).click();
      await expect(page.getByTestId('studio-activity')).toContainText(`Emailed #${p.display_number} to`, { timeout: 30_000 });
      const sent = (await row(p.id)).studio.emails;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ subject: `Draft #${p.display_number}: E2E ${fx.edition} emailed`, image_url: img });
      expect(sent[0].message_id).toBeTruthy();
      await page.getByTestId('studio-tab-issue').click();
      await page.getByRole('button', { name: /Email me the week.s slate/ }).click();
      await expect(page.getByTestId('studio-activity')).toContainText("Emailed the week's slate to", { timeout: 30_000 });
    } finally {
      await cleanupStudio(fx);
    }
  });

  test('a studio-chosen issue: stories → subject → images → the final email has exactly the chosen stories, in order (no subscribers)', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    let fx: StudioFixture | null = null;
    try {
      fx = await seedStudio(`${STUDIO_EDITION}-issue`, { viaApi: true });
      expect(await supaGet('newsletter_subscribers_v2', `edition_id=eq.${enc(fx.edition)}&select=email`)).toEqual([]);
      const alpha = await seedStudioPost(fx, { title: `E2E ${fx.edition} Alpha`, state: 'approved' });
      const bravo = await seedStudioPost(fx, { title: `E2E ${fx.edition} Bravo`, state: 'approved' });
      const chosen = [`E2E ${fx.edition} Bravo`, fx.topics[2].title, `E2E ${fx.edition} Alpha`];
      await page.goto(`/newsletter/studio/${enc(fx.edition)}?week=${fx.week}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-tab-issue').click();
      await page.getByTestId(`issue-add-post-${bravo.display_number}`).click();
      await page.getByTestId('issue-add-topic-3').click();
      await page.getByTestId(`issue-add-post-${alpha.display_number}`).click();
      await page.getByTestId('issue-save').click();
      for (const [i, t] of chosen.entries()) await expect(page.getByTestId(`issue-item-${i + 1}`)).toContainText(t);
      // A send date of the fixture's own (1990s) week, so the run never meets a real issue's date.
      await page.getByLabel('Send date').fill(fx.week);
      await expect(page.getByTestId('issue-generate')).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId('issue-generate').click();
      await expect(page).toHaveURL(/\/newsletter\/execution\/[^/]+/, { timeout: 30_000 });
      const execId = decodeURIComponent(page.url().split('/newsletter/execution/')[1] ?? '');

      for (const [stage, timeout] of [['stories', 4 * 60_000], ['subject_line', 4 * 60_000], ['image', 12 * 60_000]] as const) {
        let gate: any;
        await expect.poll(async () => {
          [gate] = await supaGet('newsletter_approvals_v2', `execution_id=eq.${enc(execId)}&stage=eq.${stage}&select=token,payload`);
          return gate?.token ?? null;
        }, { timeout, intervals: [5_000] }).not.toBeNull();
        if (stage === 'stories') expect(gate.payload.top_selected_stories.map((s: any) => s.title)).toEqual(chosen);
        await page.goto(`/newsletter/approvals/${gate.token}`, { waitUntil: 'domcontentloaded' });
        // Every gate's email preview shows the chosen stories — the image gate is the last look before it goes out.
        const preview = page.frameLocator('iframe[title="Approval email preview"]');
        await expect(preview.getByText('3 stories this issue')).toBeVisible({ timeout: 30_000 });
        for (const t of chosen) await expect(preview.getByText(t).first()).toBeVisible();
        await page.getByRole('button', { name: /^Approve/i }).click();
        await expect.poll(async () => (await supaGet('newsletter_approvals_v2', `token=eq.${gate.token}&select=decision`))[0]?.decision, { timeout: 30_000 }).toBe('approve');
      }

      let send: any;
      await expect.poll(async () => {
        [send] = await supaGet('newsletter_sends_v2', `edition_id=eq.${enc(fx!.edition)}&select=status,html_body,recipient_count`);
        return send?.status ?? null;
      }, { timeout: 10 * 60_000, intervals: [10_000] }).toBe('sent');
      expect(send.recipient_count).toBe(0);
      const html: string = send.html_body;
      const at = chosen.map((t) => html.indexOf(t));
      expect(at.every((i) => i >= 0), `every chosen story is in the email: ${at}`).toBe(true);
      expect([...at].sort((x, y) => x - y)).toEqual(at);
      expect(html).not.toMatch(/What I Need to Proceed|cannot complete this task/i);
      expect(html).not.toContain('{{');
    } finally {
      await cleanupStudio(fx);
    }
  });
});
