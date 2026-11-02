import { test, expect } from '@playwright/test';
import { apiClient, seedProject, deleteProject, supaGet, RUN_TAG } from '../pages/api';

/**
 * Chat → engine hub: conversation memory and story-bible writes. RESULT-asserting against DEV.
 *
 * 1. Memory. The hub router always read `context.last_list` for "pick #3", but nothing wrote it, so a
 *    numbered follow-up never resolved. The engine now remembers the last list per (user, chat
 *    conversation). Drives the real server route (/api/chat/proxy → engine /internal/hub): list the
 *    outlines, then "pick #3" in the SAME conversation must open the third one — and the same words
 *    in a NEW conversation must not.
 *
 * 2. Story bible from chat. "Add … to the story bible" and "Update … in the story bible" had no hub
 *    route. Typed into the real chat drawer on a disposable project's page (so the page's project is
 *    what the hub acts on), then read back from story_bible_v2 AND from the Story Bible tab.
 *
 * Both are DB writes or reads only — no LLM generation, nothing queued — so this is a light spec.
 * Teardown hard-deletes the disposable project and its bible rows.
 */
const HAS_KEY = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.E2E_SUPA_SERVICE_KEY);
const chatBtn = 'button[title="Chat with Author Agent"]';

type ProxyResponse = {
  mode?: string;
  tool?: string;
  op?: string;
  conversationId?: string;
  assistantMessage?: string;
  data?: { payload?: { result?: { items?: Array<{ id?: string; title?: string }> } } };
};

test.describe('Chat hub memory + story-bible writes (engine hub)', () => {
  test.skip(!HAS_KEY, 'requires service key');

  test('"pick #3" opens the third item of the list this conversation just showed', async () => {
    const api = await apiClient();
    const conversation = `e2e-memory-${RUN_TAG}`;
    const ask = async (message: string, conversationId: string): Promise<ProxyResponse> => {
      const res = await api.post('/api/chat/proxy', {
        data: { user_message_request: message, user_id: process.env.E2E_USER_ID || '+14105914612', conversation_id: conversationId },
      });
      expect(res.status(), `${message} → HTTP ${res.status()}`).toBe(200);
      return (await res.json()) as ProxyResponse;
    };

    const listed = await ask('List all my outlines', conversation);
    expect(listed.conversationId).toBe(conversation);
    const items = listed.data?.payload?.result?.items ?? [];
    expect(items.length, 'the demo user needs at least 3 outlines on DEV').toBeGreaterThanOrEqual(3);
    const third = items[2];

    const picked = await ask('pick #3', conversation);
    expect(picked.tool).toBe('library');
    expect(picked.op).toBe('retrieve');
    const got = picked.data?.payload?.result?.items ?? [];
    expect(got.length).toBe(1);
    expect(got[0].id).toBe(third.id);
    expect(got[0].title).toBe(third.title);

    // A different conversation never saw that list: "pick #3" there cannot land on the same item.
    const other = await ask('pick #3', `${conversation}-other`);
    const otherItems = other.data?.payload?.result?.items ?? [];
    expect(otherItems.length === 1 && otherItems[0].id === third.id).toBe(false);
    await api.dispose();
  });

  test.describe('story bible from the chat drawer', () => {
    let projectId = '';
    const NAME = `E2E Mara ${RUN_TAG}`;
    const FIRST = 'a salvage pilot with a prosthetic arm';
    const SECOND = 'captain of the Wren after the Ceres mutiny';
    test.beforeAll(async () => { projectId = await seedProject({ title: `E2E Hub Bible ${RUN_TAG}` }); });
    test.afterAll(async () => { if (projectId) await deleteProject(projectId); });

    const liveRows = () => supaGet<{ name: string; entry_type: string; description: string; deleted_at: string | null }>(
      'story_bible_v2',
      `project_id=eq.${projectId}&name=eq.${encodeURIComponent(NAME)}&deleted_at=is.null&select=name,entry_type,description,deleted_at`,
    );

    test('add then update an entry by chat; the Story Bible tab shows the update', async ({ page }) => {
      await page.addInitScript(() => {
        try {
          window.localStorage.removeItem('writers-workbench-chat-history');
          window.localStorage.removeItem('writers-workbench-chat-conversation');
        } catch { /* ignore */ }
      });
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await page.locator('header').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator(chatBtn).click();
      const input = page.getByPlaceholder('Type a message...');
      await expect(input).toBeVisible({ timeout: 10_000 });

      // The request must carry the drawer's conversation and this page's project.
      const addReq = page.waitForRequest((r) => r.url().includes('/api/chat/proxy') && r.method() === 'POST');
      await input.fill(`Add a character named ${NAME} to the story bible: ${FIRST}`);
      await input.press('Enter');
      const sent = (await addReq).postDataJSON() as Record<string, unknown>;
      expect(sent.project_id).toBe(projectId);
      expect(String(sent.conversation_id || '')).toMatch(/^drawer-/);

      await expect(page.getByText(`Added ${NAME} (character)`, { exact: false }).first()).toBeVisible({ timeout: 45_000 });
      await expect
        .poll(async () => (await liveRows()).map((r) => `${r.entry_type}|${r.description}`).join(','), {
          timeout: 20_000, message: 'chat add did not write story_bible_v2',
        })
        .toBe(`character|${FIRST}`);

      await input.fill(`Update ${NAME} in the story bible: ${SECOND}`);
      await input.press('Enter');
      await expect(page.getByText(`Updated ${NAME} (character)`, { exact: false }).first()).toBeVisible({ timeout: 45_000 });
      await expect
        .poll(async () => (await liveRows()).map((r) => r.description).join(','), {
          timeout: 20_000, message: 'chat update did not change the entry',
        })
        .toBe(SECOND);
      // Updated in place: still exactly one live row, no duplicate.
      expect((await liveRows()).length).toBe(1);

      // Displayed: the Story Bible tab shows the entry with its UPDATED description.
      await page.goto(`/projects/${projectId}/bible`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(SECOND, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    });
  });
});
