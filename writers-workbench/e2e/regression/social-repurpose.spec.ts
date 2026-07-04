import { test, expect } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Social repurpose FULL data path: the Social panel's empty state tells users to repurpose via chat
 * ("Repurpose [title] for social media"). This drives that real path — chat command → engine hub
 * routes to media.social-posts → social_posts_v2 rows created for the project → DISPLAYED in the
 * project's Social tab.
 *
 * PASS: new social_posts_v2 rows for the project are created after the chat command AND at least one
 *       post's text renders in the Social tab.
 * FAIL: no rows created (routing/generation failed) or none displayed.
 *
 * HEAVY (engine social generation) — Pass B (workers=1). Uses The Last Signal.
 */
const PROJECT_ID = 'dd10c1c3-e025-4cd7-854d-21db32a2e4da';
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const chatBtn = 'button[title="Chat with Author Agent"]';

test.describe('Social repurpose (data path)', () => {
  test.skip(!HAS_KEY, 'requires service key');
  test.setTimeout(6 * 60_000);

  test('chat "Repurpose … for social media" → posts created and displayed in the Social tab', async ({ page }) => {
    const startIso = new Date(Date.now() - 5_000).toISOString();
    const before = (await supaGet<{ id: string }>(
      'social_posts_v2', `project_id=eq.${PROJECT_ID}&select=id`,
    ).catch(() => [])).length;

    // Start clean, open the chat drawer from the TopBar.
    await page.addInitScript(() => {
      try { window.localStorage.removeItem('writers-workbench-chat-history'); } catch { /* ignore */ }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(chatBtn).click();

    const input = page.getByPlaceholder('Type a message...');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('Repurpose The Last Signal for social media');
    await input.press('Enter');

    // DATA CREATED: new social_posts_v2 rows for the project (engine job is async).
    await expect
      .poll(async () => (await supaGet<{ id: string }>(
        'social_posts_v2',
        `project_id=eq.${PROJECT_ID}&created_at=gte.${encodeURIComponent(startIso)}&select=id`,
      ).catch(() => [])).length, { timeout: 5 * 60_000, message: 'no social_posts_v2 rows created after the chat repurpose command' })
      .toBeGreaterThan(0);

    // DATA DISPLAYED: the project's Social tab shows posts (count grew and text renders).
    await page.goto(`/projects/${PROJECT_ID}?tab=social`, { waitUntil: 'domcontentloaded' });
    // A post card shows a Copy control per post; at least one must be present now.
    await expect(page.getByRole('button', { name: /Copy/i }).first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await supaGet<{ id: string }>(
        'social_posts_v2', `project_id=eq.${PROJECT_ID}&select=id`,
      ).catch(() => [])).length, { timeout: 10_000 })
      .toBeGreaterThan(before);
  });
});
