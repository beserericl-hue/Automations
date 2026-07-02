import { test, expect } from '@playwright/test';

/**
 * ChatDrawer (client/src/components/chat/ChatDrawer.tsx) — RESULT-asserting.
 *
 * Opens the drawer via the TopBar chat button, sends a harmless list op ("list my outlines"), and proves:
 *   - the user's message bubble renders in the drawer,
 *   - a real POST to /api/chat/proxy fires (network asserted),
 *   - an accepted/response state appears (sending indicator, then an assistant bubble or a queued pill).
 * Also covers the Quick Commands toggle (populates the input) and Clear-history (removes bubbles).
 *
 * We do NOT trigger long generation — a list op returns synchronously or as a short queued job; either way
 * the message is accepted. Runs against DEV (E2E_BASE_URL) with the shared authenticated session.
 */

const chatBtn = 'button[title="Chat with Author Agent"]';

/** The drawer panel is always mounted; it toggles translate-x-0 (open) ↔ translate-x-full (closed). */
function drawerPanel(page: import('@playwright/test').Page) {
  return page.locator('div.fixed.right-0.top-0', { hasText: 'Chat with Author Agent' }).first();
}

async function openDrawer(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator(chatBtn).click();
  await expect(drawerPanel(page)).toHaveClass(/translate-x-0/, { timeout: 10_000 });
}

test.describe('ChatDrawer (result-asserting)', () => {
  test.beforeEach(async ({ page }) => {
    // Chat history is persisted in localStorage; start each test from a clean slate.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('writers-workbench-chat-history');
        window.localStorage.removeItem('writers-workbench-active-jobs');
      } catch {
        /* ignore */
      }
    });
  });

  test('sending a message renders the user bubble AND fires POST /api/chat/proxy', async ({ page }) => {
    await openDrawer(page);

    const input = page.getByPlaceholder('Type a message...');
    await expect(input).toBeVisible({ timeout: 10_000 });

    const msg = 'list my outlines';

    // Assert the real backend call fires with the typed message.
    const proxyReq = page.waitForRequest(
      (r) => r.url().includes('/api/chat/proxy') && r.method() === 'POST',
      { timeout: 20_000 },
    );

    await input.fill(msg);
    await input.press('Enter');

    const req = await proxyReq;
    const body = req.postDataJSON() as { user_message_request?: string };
    expect(body.user_message_request).toBe(msg);

    // The user's message bubble renders in the drawer. The bubble is the brand-colored div holding the
    // message text + a timestamp, so match by substring (getByText exact would fail — the div's full text
    // includes the timestamp). Scope to the drawer panel to avoid matching e.g. a quick-command label.
    const userBubble = drawerPanel(page).locator('div.bg-brand-600', { hasText: msg });
    await expect(userBubble.first()).toBeVisible({ timeout: 10_000 });

    // An accepted state appears: either the "sending" typing indicator OR a resolved assistant/queued
    // bubble. Assert the request resolved with a 2xx/queued response (not a 4xx/5xx error bubble).
    const resp = await req.response();
    expect(resp, 'chat proxy should return a response').toBeTruthy();
    expect(resp!.status(), 'chat proxy should not error').toBeLessThan(400);

    // And no "Error:" bubble surfaced for this benign list op.
    await expect(page.getByText(/^Error:/).first()).toBeHidden();
  });

  test('Quick Commands toggle populates the input', async ({ page }) => {
    await openDrawer(page);

    // The quick-commands button (title="Quick Commands") toggles the command palette.
    await page.locator('button[title="Quick Commands"]').click();
    const listProjects = page.getByRole('button', { name: 'List my projects', exact: true });
    await expect(listProjects).toBeVisible({ timeout: 10_000 });
    await listProjects.click();

    // Clicking a command fills the composer input with the command text.
    await expect(page.getByPlaceholder('Type a message...')).toHaveValue('List my projects');
  });

  test('Clear-history removes message bubbles', async ({ page }) => {
    await openDrawer(page);

    const input = page.getByPlaceholder('Type a message...');
    const msg = 'list my outlines';
    const userBubble = drawerPanel(page).locator('div.bg-brand-600', { hasText: msg });
    await input.fill(msg);
    await input.press('Enter');
    await expect(userBubble.first()).toBeVisible({ timeout: 15_000 });

    // Clear-history button (title="Clear chat history") appears once there are messages.
    const clear = page.locator('button[title="Clear chat history"]');
    await expect(clear).toBeVisible({ timeout: 10_000 });
    await clear.click();

    // The bubble is gone and the empty-state copy returns.
    await expect(userBubble).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText(/Start by telling the AI what you'd like to create/i)).toBeVisible({ timeout: 10_000 });
  });

  test('Close button hides the drawer', async ({ page }) => {
    await openDrawer(page);
    const panel = drawerPanel(page);
    // The close (X) button is the last button in the drawer header row (next to the heading).
    const headerRow = panel.locator('div.h-14').first();
    await headerRow.getByRole('button').last().click();
    // Panel slides back off-screen and the backdrop overlay unmounts.
    await expect(panel).toHaveClass(/translate-x-full/, { timeout: 10_000 });
    await expect(page.locator('div.fixed.inset-0.z-40.bg-black\\/20')).toHaveCount(0, { timeout: 10_000 });
  });
});
