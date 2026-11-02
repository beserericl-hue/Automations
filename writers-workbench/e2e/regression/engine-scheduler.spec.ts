import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Engine scheduler (cron) health — RESULT-asserting, against the live DEV engine.
 *
 * The admin API reads /admin/scheduler from every runtime replica with the engine admin token (held
 * server-side only) and merges them. DEV runs two or more runtime replicas and eight scheduled jobs;
 * every one must be reported, with a health verdict consistent with its own last run, and the Admin →
 * Engine Fleet tab must show the same jobs and verdicts. The browser never sees the admin token: its
 * only request is /api/admin/engine-scheduler with the user's own bearer token.
 */
const EXPECTED_JOBS = [
  'ingestion',
  'newsletter-cadence',
  'publish-scheduled',
  'social-publish',
  'radar',
  'queue-metrics',
  'autoscale',
  'workbench-lifecycle',
];

async function scheduler(): Promise<any> {
  const api = await apiClient();
  const res = await api.get('/api/admin/engine-scheduler');
  expect(res.status(), await res.text()).toBe(200);
  const j = await res.json();
  await api.dispose();
  return j.data;
}

test.describe('Engine scheduler (result-asserting)', () => {
  test('the API reports every scheduled job, merged across the runtime replicas', async () => {
    const data = await scheduler();
    expect(data.running).toBe(true);
    // Every runtime replica was asked, and they all answered.
    expect(data.replicas.length).toBeGreaterThanOrEqual(2);
    expect(data.replicas.every((r: any) => r.ok)).toBe(true);
    expect(data.jobs.map((j: any) => j.name).sort()).toEqual([...EXPECTED_JOBS].sort());

    for (const j of data.jobs) {
      expect(j.interval_s, j.name).toBeGreaterThan(0);
      expect(['ok', 'failing', 'overdue', 'waiting', 'pending'], j.name).toContain(j.health);
      // One entry per replica, and the merged counters are their sums.
      expect(j.replicas.length, j.name).toBe(data.replicas.length);
      expect(j.ticks, j.name).toBe(j.replicas.reduce((n: number, r: any) => n + r.ticks, 0));
      if (j.last_run) {
        // The merged last run is the latest replica's, and the next run is one interval after it.
        const latest = Math.max(...j.replicas.filter((r: any) => r.last_run).map((r: any) => Date.parse(r.last_run)));
        expect(Date.parse(j.last_run), j.name).toBe(latest);
        expect(Date.parse(j.next_run) - Date.parse(j.last_run), j.name).toBe(Math.max(30, j.interval_s) * 1000);
        expect(j.health === 'failing', j.name).toBe(Boolean(j.last_error));
      } else {
        expect(['waiting', 'pending'], j.name).toContain(j.health);
        expect(j.next_run, j.name).toBeNull();
      }
    }
    // A per-replica job runs on every replica (30s interval), so it has run, and is not a singleton.
    const metrics = data.jobs.find((j: any) => j.name === 'queue-metrics');
    expect(metrics.singleton).toBe(false);
    expect(metrics.ticks).toBeGreaterThan(0);
    // Only the merged view comes back — no engine credentials or raw config.
    expect(Object.keys(data).sort()).toEqual(['checked_at', 'jobs', 'replicas', 'running']);
  });

  test('the Engine Fleet tab shows every job with the health the API reports, and the admin token never reaches the browser', async ({ page }) => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    page.on('request', (r) => sent.push({ url: r.url(), headers: r.headers() }));

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Engine Fleet/ }).click();
    const section = page.getByTestId('engine-scheduler');
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('scheduler-jobs')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('scheduler-jobs').locator('tbody tr')).toHaveCount(EXPECTED_JOBS.length);
    await expect(page.getByTestId('scheduler-summary')).toContainText(`${EXPECTED_JOBS.length} jobs`);

    const data = await scheduler();
    for (const j of data.jobs) {
      const row = page.getByTestId(`scheduler-job-${j.name}`);
      await expect(row).toBeVisible();
      // Health can only change between the two reads if a tick lands in between; the UI refetches
      // every 30s, so compare against a fresh read, allowing for that one transition.
      const shown = await row.getAttribute('data-health');
      if (shown !== j.health) expect(['ok', 'waiting', 'pending']).toContain(shown);
      if (j.last_error) await expect(row).toContainText(j.last_error.slice(0, 40));
    }
    // The verdict line matches the jobs.
    const flagged = data.jobs.filter((j: any) => j.health === 'failing' || j.health === 'overdue');
    if (flagged.length) await expect(page.getByTestId('scheduler-alert')).toContainText(flagged[0].name);
    else await expect(page.getByTestId('scheduler-allclear')).toBeVisible();

    // The browser asked the Workbench, never the engine, and sent no admin token.
    expect(sent.some((r) => r.url.includes('/api/admin/engine-scheduler'))).toBe(true);
    expect(sent.some((r) => /writer-engine|railway\.internal|\/admin\/scheduler/.test(r.url))).toBe(false);
    expect(sent.some((r) => 'x-admin-token' in r.headers)).toBe(false);
  });
});
