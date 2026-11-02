/**
 * CostDashboard reads server-side aggregates (GET /api/costs/breakdown) instead of summing a capped
 * select in the browser, shows the server's total, and re-queries when the grouping changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';
import CostDashboard from '../components/cost/CostDashboard';
import { rowLabel, testIdFor } from '../components/cost/costLabels';
import type { CostBreakdownRow } from '../types/database';

const { calls, userRef } = vi.hoisted(() => ({
  calls: [] as string[],
  userRef: { current: { profile: { user_id: 'u1', isAdmin: false }, isImpersonating: false } },
}));

vi.mock('../contexts/UserContext', () => ({
  useUser: () => userRef.current,
  UserProvider: ({ children }: { children: unknown }) => children,
}));

const row = (over: Partial<CostBreakdownRow>): CostBreakdownRow => ({
  operation: null, provider: null, model: null, project_id: null, user_id: null, day: null,
  calls: 2, runs: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0,
  units: 0, unit_types: null, cost_usd: 0.5, avg_cost_per_call: 0.25, avg_cost_per_run: 0.5,
  provider_reported_calls: 0, estimated_calls: 0, unpriced_calls: 0, ...over,
});

vi.mock('../lib/api', () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    const group = new URL(path, 'http://x').searchParams.get('group');
    const rows = group === 'provider'
      ? [row({ provider: 'anthropic', cost_usd: 1.2 }), row({ provider: 'perplexity', cost_usd: 0.03, provider_reported_calls: 2 })]
      : [row({ operation: 'chapter.write', cost_usd: 1.0 }), row({ operation: 'research.run', cost_usd: 0.23 })];
    return { success: true, data: { group, from: '', to: '', rows, totals: row({ cost_usd: 1.23, calls: 4 }) } };
  },
  ApiError: class extends Error {},
  getActiveImpersonation: () => null,
  setActiveImpersonation: () => undefined,
}));

beforeEach(() => {
  calls.length = 0;
  userRef.current = { profile: { user_id: 'u1', isAdmin: false }, isImpersonating: false };
});

describe('CostDashboard', () => {
  it('shows the server total and one row per operation', async () => {
    renderWithProviders(<CostDashboard projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('cost-total').textContent).toBe('$1.2300'));
    expect(screen.getByTestId(testIdFor('chapter.write'))).toBeTruthy();
    expect(screen.getByTestId(testIdFor('research.run'))).toBeTruthy();
    expect(calls[0]).toMatch(/^\/api\/costs\/breakdown\?group=operation&from=.*&project_id=p1$/);
  });

  it('regroups by provider through the server', async () => {
    renderWithProviders(<CostDashboard />);
    await waitFor(() => screen.getByTestId(testIdFor('chapter.write')));
    fireEvent.change(screen.getByTestId('cost-group-select'), { target: { value: 'provider' } });
    await waitFor(() => screen.getByTestId(testIdFor('perplexity')));
    expect(calls.some((c) => c.includes('group=provider'))).toBe(true);
  });

  it('offers admins an all-users view on the admin endpoint', async () => {
    userRef.current = { profile: { user_id: 'u1', isAdmin: true }, isImpersonating: false };
    renderWithProviders(<CostDashboard />);
    fireEvent.click(await screen.findByTestId('cost-all-users'));
    await waitFor(() => expect(calls.some((c) => c.startsWith('/api/admin/costs/breakdown'))).toBe(true));
  });

  it('labels rows by the grouping in use', () => {
    expect(rowLabel(row({ operation: 'chapter.qa', model: 'claude-sonnet-4-6' }), 'operation_model')).toBe('chapter.qa · claude-sonnet-4-6');
    expect(testIdFor('chapter.qa · claude-sonnet-4-6')).toBe('cost-row-chapter.qa_claude-sonnet-4-6');
  });
});
