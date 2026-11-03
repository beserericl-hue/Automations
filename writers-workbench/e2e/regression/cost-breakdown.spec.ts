import { test, expect } from '@playwright/test';
import { apiClient, seedProject, deleteProject, seedCostRow, supaDelete, supaGet } from '../pages/api';

/**
 * Per-operation cost view (migration 044 + GET /api/costs/breakdown) — RESULT-asserting.
 *
 * A disposable project gets three labelled cost rows (two operations, two providers, two runs). The
 * project's Cost tab must show exactly the total the API computes in Postgres, one row per operation,
 * and — after regrouping — one row per provider. The /cost page must render the same dashboard and
 * agree with the API for the same window.
 */
const STAMP = Date.now();
const OP_WRITE = `e2e.write-${STAMP}`;
const OP_QA = `e2e.qa-${STAMP}`;

let projectId = '';
const rowIds: string[] = [];

const testId = (label: string) => `cost-row-${label.replace(/[^A-Za-z0-9._-]+/g, '_')}`;

test.describe('Cost breakdown (result-asserting)', () => {
  test.beforeAll(async () => {
    projectId = await seedProject({ title: `E2E Cost ${STAMP}`, genre_slug: 'post-apocalyptic' });
    rowIds.push(await seedCostRow({ projectId, operation: OP_WRITE, provider: 'anthropic', model: 'claude-sonnet-4-6', costUsd: 0.0123, runId: `run-a-${STAMP}` }));
    rowIds.push(await seedCostRow({ projectId, operation: OP_WRITE, provider: 'anthropic', model: 'claude-sonnet-4-6', costUsd: 0.0077, runId: `run-a-${STAMP}` }));
    rowIds.push(await seedCostRow({ projectId, operation: OP_QA, provider: 'perplexity', model: 'sonar-pro', costUsd: 0.0042, runId: `run-b-${STAMP}` }));
  });

  test.afterAll(async () => {
    for (const id of rowIds) await supaDelete('token_usage_v2', `id=eq.${id}`).catch(() => undefined);
    if (projectId) await deleteProject(projectId).catch(() => undefined);
  });

  test('API aggregates per operation in the database', async () => {
    const api = await apiClient();
    const r = await api.get(`/api/costs/breakdown?group=operation&project_id=${projectId}`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(Number(j.data.totals.cost_usd)).toBeCloseTo(0.0242, 6);
    const write = j.data.rows.find((x: { operation: string }) => x.operation === OP_WRITE);
    expect(Number(write.calls)).toBe(2);
    expect(Number(write.runs)).toBe(1);
    expect(Number(write.avg_cost_per_call)).toBeCloseTo(0.01, 6);
    expect(Number(write.avg_cost_per_run)).toBeCloseTo(0.02, 6);
    const bad = await api.get('/api/costs/breakdown?group=nonsense');
    expect(bad.status()).toBe(400);
  });

  test('project Cost tab shows the API total, per operation and per provider', async ({ page }) => {
    const api = await apiClient();
    const totals = (await (await api.get(`/api/costs/breakdown?group=operation&project_id=${projectId}`)).json()).data.totals;

    await page.goto(`/projects/${projectId}?tab=cost`);
    await expect(page.getByTestId('cost-dashboard')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('cost-total')).toHaveText(`$${Number(totals.cost_usd).toFixed(4)}`, { timeout: 20_000 });
    await expect(page.getByTestId(testId(OP_WRITE))).toBeVisible();
    await expect(page.getByTestId(testId(OP_QA))).toBeVisible();

    await page.getByTestId('cost-group-select').selectOption('provider');
    await expect(page.getByTestId(testId('anthropic'))).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(testId('perplexity'))).toBeVisible();
    await expect(page.getByTestId(testId('anthropic')).getByTestId('cost-row-cost')).toHaveText('$0.0200');

    await page.getByTestId('cost-group-select').selectOption('operation');
    await expect(page.getByTestId(testId(OP_WRITE)).getByTestId('cost-row-cost')).toHaveText('$0.0200', { timeout: 20_000 });
  });

  test('/cost renders the dashboard and its per-operation table matches the API', async ({ page }) => {
    const api = await apiClient();
    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cost-range-30d').click();
    await page.getByTestId('cost-group-select').selectOption('operation');
    // The seeded operation is in this user's last 30 days, so the table cannot be empty.
    await expect(page.getByTestId(testId(OP_WRITE))).toBeVisible({ timeout: 20_000 });
    const j = (await (await api.get('/api/costs/breakdown?group=operation')).json()).data;
    expect(j.rows.length).toBeGreaterThan(0);
    // Live DEV can record new costs between the two reads, so compare the seeded row (stable), not the total.
    const write = j.rows.find((x: { operation: string }) => x.operation === OP_WRITE);
    await expect(page.getByTestId(testId(OP_WRITE)).getByTestId('cost-row-cost')).toHaveText(`$${Number(write.cost_usd).toFixed(4)}`);
  });
});

/**
 * Migration 049: n8n workflows still write token_usage_v2 directly and name Gemini "google". The
 * insert trigger stores it as gemini, so the provider view shows ONE Gemini row, not two. Its own
 * project, because the suite runs fully parallel and the block above asserts exact totals.
 */
test.describe('Provider names (result-asserting)', () => {
  let gProject = '';
  let gRow = '';

  test.beforeAll(async () => {
    gProject = await seedProject({ title: `E2E Cost Provider ${STAMP}`, genre_slug: 'post-apocalyptic' });
    gRow = await seedCostRow({
      projectId: gProject, operation: `e2e.hub-${STAMP}`, provider: 'google', model: 'gemini-2.5-pro', costUsd: 0.0011,
    });
  });

  test.afterAll(async () => {
    if (gRow) await supaDelete('token_usage_v2', `id=eq.${gRow}`).catch(() => undefined);
    if (gProject) await deleteProject(gProject).catch(() => undefined);
  });

  test('a row written as provider "google" is stored, served and shown as gemini', async ({ page }) => {
    const [stored] = await supaGet<{ provider: string; metadata: Record<string, unknown> }>(
      'token_usage_v2', `id=eq.${gRow}&select=provider,metadata`,
    );
    expect(stored.provider).toBe('gemini');
    expect(stored.metadata.provider_from).toBe('google');

    const api = await apiClient();
    const j = (await (await api.get(`/api/costs/breakdown?group=provider&project_id=${gProject}`)).json()).data;
    expect(j.rows.map((x: { provider: string }) => x.provider)).toEqual(['gemini']);

    await page.goto(`/projects/${gProject}?tab=cost`);
    await expect(page.getByTestId('cost-dashboard')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cost-group-select').selectOption('provider');
    await expect(page.getByTestId(testId('gemini')).getByTestId('cost-row-cost')).toHaveText('$0.0011', { timeout: 20_000 });
    await expect(page.getByTestId(testId('google'))).toHaveCount(0);
  });
});
