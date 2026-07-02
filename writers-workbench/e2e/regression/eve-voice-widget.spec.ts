import { test, expect } from '@playwright/test';

/**
 * Eve voice-agent UI (the ElevenLabs ConvAI web widget embedded in the Workbench).
 * Verified against components/eve/{EveOrb,EveWidget}.tsx: the sidebar "Talk to Eve" button lazy-mounts
 * EveWidget, which injects <elevenlabs-convai agent-id={VITE_ELEVENLABS_AGENT_ID}> and passes the
 * signed-in user via a `dynamic-variables` JSON attribute.
 *
 * We can't drive the live WebRTC voice turn headlessly, so this asserts the UI wiring that makes it work:
 * the widget mounts, targets the configured agent, carries the user_id dynamic variable, and closes.
 * The agent→engine round-trip itself is proven separately against /internal/hub/voice.
 */
test.describe('Eve voice widget (Workbench UI)', () => {
  test('sidebar "Talk to Eve" mounts the ConvAI widget for the configured agent + demo user', async ({ page }) => {
    await page.goto('/');
    await page.locator('aside').first().waitFor({ state: 'visible', timeout: 20_000 });

    const talk = page.getByRole('button', { name: 'Talk to Eve' }).or(page.locator('button[title="Talk to Eve"]')).first();
    await expect(talk).toBeVisible({ timeout: 15_000 });
    await talk.click();

    // The widget dialog renders (EveWidget: role="dialog" aria-label="Eve voice assistant").
    const dialog = page.getByRole('dialog', { name: /Eve voice assistant/i });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // The ElevenLabs custom element mounts with a real agent-id.
    const convai = page.locator('elevenlabs-convai');
    await expect(convai).toHaveCount(1, { timeout: 15_000 });
    const agentId = await convai.getAttribute('agent-id');
    expect(agentId, 'widget must target a configured ElevenLabs agent').toBeTruthy();
    expect(agentId!.startsWith('agent_')).toBeTruthy();

    // The signed-in demo user is threaded into the widget so the agent's tool resolves the account.
    const dynVars = await convai.getAttribute('dynamic-variables');
    expect(dynVars, 'widget must pass dynamic-variables with the user').toBeTruthy();
    const parsed = JSON.parse(dynVars!);
    expect(parsed.user_id, 'dynamic-variables must carry user_id').toBeTruthy();
    expect(parsed.source).toBe('web_widget');

    // Close the widget.
    await dialog.getByRole('button', { name: /Close Eve voice widget/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });
});
