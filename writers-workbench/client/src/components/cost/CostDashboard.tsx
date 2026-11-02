import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUser } from '../../contexts/UserContext';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import type { CostBreakdown, CostGroup } from '../../types/database';
import { rowLabel, testIdFor } from './costLabels';

/**
 * Cost of every paid provider call, broken down by operation, provider, model, project or day.
 *
 * All sums come from the server (GET /api/costs/breakdown → token_usage_breakdown in Postgres). The
 * browser never adds up raw rows: PostgREST caps a select at 1000 rows, and summing a capped select
 * is how the old version of this page silently under-reported.
 */

type RangePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

// Recording began well after this; the server caps a range at 10 years.
const ALL_TIME_FROM = '2025-01-01T00:00:00.000Z';

const GROUPS: { value: CostGroup; label: string; adminOnly?: boolean }[] = [
  { value: 'operation', label: 'Operation' },
  { value: 'operation_model', label: 'Operation × model' },
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
  { value: 'day', label: 'Day' },
  { value: 'user', label: 'User', adminOnly: true },
];

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
};
const usd = (v: number | string | null | undefined, digits = 4): string => `$${num(v).toFixed(digits)}`;
const int = (v: number | string | null | undefined): string => Math.round(num(v)).toLocaleString();

function rangeDates(preset: RangePreset, customFrom: string, customTo: string): { from: string; to: string } | null {
  if (preset === 'custom') {
    if (!customFrom || !customTo) return null;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T00:00:00`);
    to.setDate(to.getDate() + 1); // inclusive end day
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const to = new Date();
  if (preset === 'all') return { from: ALL_TIME_FROM, to: to.toISOString() };
  const days = parseInt(preset, 10);
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface CostDashboardProps {
  projectId?: string; // Optional: filter by project (for project workspace Cost tab)
}

export default function CostDashboard({ projectId }: CostDashboardProps) {
  const { profile, isImpersonating } = useUser();
  const userId = profile?.user_id;
  const canSeeAll = !!profile?.isAdmin && !isImpersonating;
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [group, setGroup] = useState<CostGroup>('operation');
  const [allUsers, setAllUsers] = useState(false);

  const scopeAll = canSeeAll && allUsers;
  const effectiveGroup: CostGroup = group === 'user' && !scopeAll ? 'operation' : group;
  const range = rangeDates(preset, customFrom, customTo);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cost-breakdown', userId, scopeAll, effectiveGroup, range?.from.slice(0, 13), range?.to.slice(0, 13), projectId, isImpersonating],
    queryFn: async () => {
      const qs = new URLSearchParams({ group: effectiveGroup, from: range!.from, to: range!.to });
      if (projectId) qs.set('project_id', projectId);
      const base = scopeAll ? '/api/admin/costs/breakdown' : '/api/costs/breakdown';
      const res = await apiFetch<ApiEnvelope<CostBreakdown>>(`${base}?${qs.toString()}`);
      return res.data ?? null;
    },
    enabled: !!userId && !!range,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const maxCost = rows.reduce((m, r) => Math.max(m, num(r.cost_usd)), 0);

  return (
    <div className="space-y-6" data-testid="cost-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {projectId ? 'Project Cost' : 'Usage & Cost'}
        </h2>
        <p className="w-full text-xs text-gray-500 dark:text-gray-400 sm:order-last">
          Cost tracking: every paid provider call (Claude, Gemini, Perplexity, OpenAI, KIE, StealthGPT, ScraperAPI),
          labelled by the operation that made it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canSeeAll && (
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                data-testid="cost-all-users"
                checked={allUsers}
                onChange={(e) => setAllUsers(e.target.checked)}
              />
              All users
            </label>
          )}
          <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
            {(['7d', '30d', '90d', 'all', 'custom'] as RangePreset[]).map((r) => (
              <button
                key={r}
                data-testid={`cost-range-${r}`}
                onClick={() => setPreset(r)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  preset === r
                    ? 'bg-brand-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {r === 'custom' ? 'Custom' : r === 'all' ? 'All Time' : r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <label>From <input type="date" data-testid="cost-from" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" /></label>
          <label>To <input type="date" data-testid="cost-to" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" /></label>
          {!range && <span>Pick a start and an end date.</span>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Total Cost" value={usd(totals?.cost_usd)} testId="cost-total" raw={String(num(totals?.cost_usd))} />
        <SummaryCard label="API Calls" value={int(totals?.calls)} testId="cost-calls" />
        <SummaryCard label="Avg Cost / Call" value={usd(totals?.avg_cost_per_call, 5)} testId="cost-avg-call" />
        <SummaryCard
          label="Tokens (in / out)"
          value={`${int(totals?.input_tokens)} / ${int(totals?.output_tokens)}`}
          testId="cost-tokens"
        />
      </div>

      {totals && (num(totals.estimated_calls) > 0 || num(totals.unpriced_calls) > 0) && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="cost-flags">
          {num(totals.provider_reported_calls)} calls priced by the provider itself;{' '}
          {num(totals.estimated_calls)} estimated; {num(totals.unpriced_calls)} unpriced (model missing from the price
          table, recorded at $0).
        </p>
      )}

      <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Breakdown</h3>
          <select
            data-testid="cost-group-select"
            value={effectiveGroup}
            onChange={(e) => setGroup(e.target.value as CostGroup)}
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            {GROUPS.filter((g) => !g.adminOnly || scopeAll).map((g) => (
              <option key={g.value} value={g.value}>By {g.label.toLowerCase()}</option>
            ))}
          </select>
        </div>

        {isLoading && <div className="py-6 text-center text-sm text-gray-500">Loading cost data...</div>}
        {error && (
          <div className="py-6 text-center text-sm text-red-600" data-testid="cost-error">
            Could not load costs: {(error as Error).message}
          </div>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div className="py-6 text-center text-sm text-gray-500" data-testid="cost-empty">
            No usage in this period.
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="cost-table">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-700">
                  <th className="py-1 pr-3 font-medium">{GROUPS.find((g) => g.value === effectiveGroup)?.label}</th>
                  <th className="py-1 pr-3 text-right font-medium">Calls</th>
                  <th className="py-1 pr-3 text-right font-medium">Runs</th>
                  <th className="py-1 pr-3 text-right font-medium">Units</th>
                  <th className="py-1 pr-3 text-right font-medium">In</th>
                  <th className="py-1 pr-3 text-right font-medium">Out</th>
                  <th className="py-1 pr-3 text-right font-medium">Cache r/w</th>
                  <th className="py-1 pr-3 text-right font-medium">Cost</th>
                  <th className="py-1 pr-3 text-right font-medium">Avg / call</th>
                  <th className="py-1 pr-3 text-right font-medium">Avg / run</th>
                  <th className="py-1 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const label = rowLabel(r, effectiveGroup);
                  const share = maxCost > 0 ? (num(r.cost_usd) / maxCost) * 100 : 0;
                  return (
                    <tr key={label} data-testid={testIdFor(label)} className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-1 pr-3">
                        <div className="font-mono text-gray-700 dark:text-gray-300">{label}</div>
                        {effectiveGroup === 'operation_model' && r.provider && (
                          <div className="text-[10px] text-gray-400">{r.provider}</div>
                        )}
                        <div className="mt-0.5 h-1 rounded bg-brand-500" style={{ width: `${share}%` }} />
                      </td>
                      <td className="py-1 pr-3 text-right">{int(r.calls)}</td>
                      <td className="py-1 pr-3 text-right">{int(r.runs)}</td>
                      <td className="py-1 pr-3 text-right" title={r.unit_types ?? ''}>
                        {num(r.units) > 0 ? `${int(r.units)} ${r.unit_types ?? ''}` : '—'}
                      </td>
                      <td className="py-1 pr-3 text-right">{int(r.input_tokens)}</td>
                      <td className="py-1 pr-3 text-right">{int(r.output_tokens)}</td>
                      <td className="py-1 pr-3 text-right">{int(r.cache_read_tokens)} / {int(r.cache_write_tokens)}</td>
                      <td className="py-1 pr-3 text-right font-medium text-gray-900 dark:text-white" data-testid="cost-row-cost">{usd(r.cost_usd)}</td>
                      <td className="py-1 pr-3 text-right">{usd(r.avg_cost_per_call, 5)}</td>
                      <td className="py-1 pr-3 text-right">{r.avg_cost_per_run == null ? '—' : usd(r.avg_cost_per_run, 5)}</td>
                      <td className="py-1 text-[10px] text-gray-500">
                        {num(r.provider_reported_calls) > 0 && <span className="mr-1">{int(r.provider_reported_calls)} reported</span>}
                        {num(r.estimated_calls) > 0 && <span className="mr-1 text-amber-600">{int(r.estimated_calls)} est.</span>}
                        {num(r.unpriced_calls) > 0 && <span className="text-red-600">{int(r.unpriced_calls)} unpriced</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, testId, raw }: { label: string; value: string; testId?: string; raw?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-white" data-testid={testId} data-value={raw}>
        {value}
      </p>
    </div>
  );
}
