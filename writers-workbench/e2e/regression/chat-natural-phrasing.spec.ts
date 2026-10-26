/**
 * chat-natural-phrasing — drives the REAL chat UI with the kind of prose a person actually types
 * (not the canonical "repurpose X for social" command form) and asserts the router/classifier parsed
 * the intent correctly. This is the class of gap that shipped the orphaned "(fixture)" social post
 * (bug 2026-07-05): the parser only understood the documented phrasing.
 *
 * It asserts the jobType badge the ChatDrawer renders (the server's classification). Every request
 * goes through the real UI and the real server classifier with `dry_run` added, so nothing is
 * started: before, every E2E run started two social posts, two cover arts, a full newsletter run and
 * a humanized blog post, and left their drafts and approvals behind on DEV.
 *
 * PASS: each natural prompt shows the correct jobType badge. FAIL: wrong/missing jobType (a parse gap).
 */
import { test, expect } from '@playwright/test';

const chatBtn = 'button[title="Chat with Author Agent"]';

// [natural prompt a real user types, expected jobType]. Each deliberately AVOIDS the canonical command.
const CASES: Array<[string, string]> = [
  // The exact class that broke: a social ask whose TOPIC mentions "newsletter".
  ['write a social media post for The Last Signal introducing our newsletter', 'repurpose_social'],
  ['create a linkedin post for The Last Signal', 'repurpose_social'],
  // Natural cover-art phrasings (not "generate cover art").
  ['make a book cover for The Last Signal', 'cover_art'],
  ['design a cover for The Last Signal', 'cover_art'],
  // Newsletter WRITE still classifies (action verb), and a topic-mention above did NOT steal it.
  ["put together this week's newsletter for The Wasteland Wire", 'write_newsletter'],
  // Natural blog phrasing.
  ['write a blog post about ancient Egyptian bread makers', 'write_blog'],
];

test.describe('Chat natural phrasing → correct router classification', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.removeItem('writers-workbench-chat-history'); } catch { /* ignore */ }
    });
    // Classify, start nothing.
    await page.route('**/api/chat/proxy', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...body, dry_run: true }) });
    });
  });

  for (const [prompt, expectedJobType] of CASES) {
    test(`"${prompt.slice(0, 48)}…" → ${expectedJobType}`, async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator(chatBtn).click();

      const input = page.getByPlaceholder('Type a message...');
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill(prompt);
      await input.press('Enter');

      // The queued assistant message renders a jobType badge = the server classification. Assert the
      // parser understood the natural phrasing. (We do NOT wait for the heavy job to finish.)
      await expect(page.getByText(expectedJobType, { exact: true }).first())
        .toBeVisible({ timeout: 30_000 });
      // And it must NOT have fallen through to the generic catch-all.
      await expect(page.getByText('chat_generic', { exact: true })).toHaveCount(0);
      // And nothing was started.
      await expect(page.getByText('Dry run: nothing was started.', { exact: false })).toBeVisible();
    });
  }
});
