/**
 * drift-apply — E2E for the Review Annotations (character-drift) screen, which had
 * never been driven end-to-end. It:
 *   1. SETUP: injects a real drift into a chapter (one "Mara" → "Meara") and clears
 *      any prior dismissal, so the drift finding is genuinely active.
 *   2. Loads the chapter page and asserts the drift annotation is shown.
 *   3. Clicks "Apply Fix" on the actual screen.
 *   4. Proves cleanup: the annotation disappears from the panel AND the chapter text
 *      no longer contains the drifted spelling ("Meara" → "Mara").
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (setup writes) and runs against
 * whatever E2E_BASE_URL points at (DEV). The chapter is Ch3 of "The Last Signal".
 */
import { test, expect } from '@playwright/test';

const CHAPTER_ID = 'd681e643-2984-4ebc-83c1-f125a1c6fade';
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function rest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SVC,
      authorization: `Bearer ${SVC}`,
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

async function chapterText(): Promise<string> {
  const rows = (await (await rest(`published_content_v2?id=eq.${CHAPTER_ID}&select=content_text`)).json()) as Array<{ content_text: string }>;
  return rows[0]?.content_text ?? '';
}

test.describe('Character drift — detect, apply, verify cleaned', () => {
  test.skip(!SVC, 'requires SUPABASE_SERVICE_ROLE_KEY for drift-injection setup');

  test.beforeAll(async () => {
    // Fetch current state, inject one drift occurrence, and clear dismissals so the
    // finding is active. Idempotent: only injects if "Meara" isn't already present.
    const rows = (await (await rest(`published_content_v2?id=eq.${CHAPTER_ID}&select=content_text,metadata`)).json()) as Array<{ content_text: string; metadata: Record<string, unknown> | null }>;
    const ch = rows[0];
    let text = ch.content_text || '';
    if (!text.includes('Meara')) {
      text = text.replace(/\bMara\b/, 'Meara'); // one realistic misspelling of the canonical "Mara"
    }
    const meta = { ...(ch.metadata || {}), dismissed_annotations: [] as string[] };
    const patch = await rest(`published_content_v2?id=eq.${CHAPTER_ID}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ content_text: text, metadata: meta }),
    });
    expect(patch.ok, 'drift injection PATCH should succeed').toBeTruthy();
  });

  test('drift finding is shown, Apply Fix cleans it, annotation disappears', async ({ page }) => {
    // Pre-condition: the injected drift is present in the stored text.
    expect(await chapterText()).toContain('Meara');

    await page.goto(`/content/${CHAPTER_ID}`, { waitUntil: 'domcontentloaded' });

    // 1) The Review Annotations panel surfaces the drift finding with an Apply Fix.
    const driftRow = page.getByText(/Character drift:\s*"Meara"/i);
    await expect(driftRow).toBeVisible({ timeout: 20_000 });
    const applyBtn = page.getByRole('button', { name: /^Apply Fix$/i }).first();
    await expect(applyBtn).toBeVisible();

    // 2) Apply the fix from the actual screen.
    await applyBtn.click();

    // 3) The annotation disappears from the panel (dismissed + no longer matches text).
    await expect(driftRow).toHaveCount(0, { timeout: 20_000 });

    // 4) Server-side proof: the drifted spelling is gone, canonical remains.
    await expect
      .poll(async () => (await chapterText()).includes('Meara'), { timeout: 20_000 })
      .toBe(false);
    expect(await chapterText()).toContain('Mara');
  });
});
