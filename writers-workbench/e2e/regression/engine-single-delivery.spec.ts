import { test, expect } from '@playwright/test';
import { apiClient } from '../pages/api';

/**
 * Engine single delivery (item 16) — RESULT-asserting. DEV runs two runtime replicas, each with an
 * arq worker per queue. This enqueues a burst of cheap jobs (library list-outlines: no model calls,
 * no email) with unique run_ids plus pairs that share one run_id, then reads the engine's run ledger:
 * every distinct run must have exactly one row, complete, executed once (attempts = 1).
 *
 * Before the run lease (2026-11-02) a duplicate pair could execute on both replicas — the ledger
 * showed attempts = 2 — and a deploy-time retry overlapped the cancelled attempt's still-running step.
 */
test.describe('Engine single delivery (result-asserting)', () => {
  test('a burst of jobs across the fleet executes each run exactly once', async () => {
    test.setTimeout(180_000);
    const api = await apiClient();
    const start = await api.post('/api/admin/engine-single-delivery-probe', { data: { jobs: 30, dupes: 8 } });
    expect(start.status(), await start.text()).toBe(200);
    const { tag, expected_runs, submitted } = (await start.json()).data;
    expect(submitted).toBe(30 + 2 * 8);

    let verdict: any = null;
    await expect
      .poll(
        async () => {
          const r = await api.get(`/api/admin/engine-single-delivery-probe/${tag}?expected=${expected_runs}`);
          verdict = (await r.json()).data;
          return verdict.verdict;
        },
        { timeout: 150_000, intervals: [3_000] },
      )
      .not.toBe('PENDING');

    expect(verdict.problems, JSON.stringify(verdict)).toEqual([]);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.distinct_runs).toBe(expected_runs);
    expect(verdict.ledger_rows).toBe(expected_runs);
    expect(verdict.max_attempts).toBe(1);
    await api.dispose();
  });

  test('the probe refuses a tag that is not its own', async () => {
    const api = await apiClient();
    const r = await api.get('/api/admin/engine-single-delivery-probe/not-a-probe');
    expect(r.status()).toBe(400);
    await api.dispose();
  });
});
