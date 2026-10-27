import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Engine fleet (CR-010 C1/C4) — RESULT-asserting. DEV runs at least two runtime and two gateway
 * replicas; the admin API must report them from the engine's own registry, and the Engine Fleet tab
 * must show the same counts. A fleet of one here means a replica died or the floor was lost.
 */
async function fleet(): Promise<any> {
  const api = await apiClient();
  const res = await api.get('/api/admin/engine-fleet');
  expect(res.status(), await res.text()).toBe(200);
  const j = await res.json();
  await api.dispose();
  return j.data;
}

test.describe('Engine fleet (result-asserting)', () => {
  test('the API reports two or more of each engine service, and the queues summed across them', async () => {
    const data = await fleet();
    const counts = data.instance_counts ?? {};
    expect(counts.orchestrator ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.gateway ?? 0).toBeGreaterThanOrEqual(2);
    const ids = new Set((data.instances ?? []).map((i: any) => `${i.service}:${i.instance}`));
    expect(ids.size).toBe((data.instances ?? []).length);
    for (const q of data.queues ?? []) {
      // Every runtime replica runs one worker per queue, so the fleet has at least two workers on
      // each. Not "equal to the registered count": this suite starts right after a deploy, when a
      // replaced replica can still be registered for a few seconds.
      expect(q.instances).toBeGreaterThanOrEqual(2);
      expect(q.instances).toBeLessThanOrEqual(counts.orchestrator);
    }
    // Calls on the private network are spread by the callers, which only works if they can see
    // more than one address for each hop.
    expect(data.server_sees_gateway_addresses).toBeGreaterThanOrEqual(2);
    expect(data.gateway_sees_runtime_addresses).toBeGreaterThanOrEqual(2);
    expect(['scale_out', 'backlog', 'tpm_bound', 'hold', 'scale_in', 'unknown']).toContain(data.verdict);
  });

  test('the Engine Fleet tab shows the counts the API reports', async ({ page }) => {
    const data = await fleet();
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Engine Fleet/ }).click();
    await expect(page.getByTestId('engine-fleet')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('fleet-runtime-count')).toHaveText(String(data.instance_counts.orchestrator));
    await expect(page.getByTestId('fleet-gateway-count')).toHaveText(String(data.instance_counts.gateway));
    await expect(page.getByTestId('fleet-instances').locator('tbody tr')).toHaveCount(data.instances.length);
  });
});
