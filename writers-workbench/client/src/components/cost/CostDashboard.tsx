import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { TokenUsage } from '../../types/database';

type DateRange = '7d' | '30d' | '90d' | 'all';

interface CostSummary {
  totalCost: number;
  totalTokens: number;
  callCount: number;
  byModel: Record<string, { cost: number; tokens: number; calls: number }>;
  byWorkflow: Record<string, { cost: number; tokens: number; calls: number }>;
  byDay: { date: string; cost: number; tokens: number }[];
}

function getDateCutoff(range: DateRange): string | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function summarize(records: TokenUsage[]): CostSummary {
  const byModel: CostSummary['byModel'] = {};
  const byWorkflow: CostSummary['byWorkflow'] = {};
  const dayMap: Record<string, { cost: number; tokens: number }> = {};
  let totalCost = 0;
  let totalTokens = 0;

  for (const r of records) {
    totalCost += r.cost_usd;
    totalTokens += r.total_tokens;

    const model = r.model || 'unknown';
    if (!byModel[model]) byModel[model] = { cost: 0, tokens: 0, calls: 0 };
    byModel[model].cost += r.cost_usd;
    byModel[model].tokens += r.total_tokens;
    byModel[model].calls++;

    const wf = r.workflow_name;
    if (!byWorkflow[wf]) byWorkflow[wf] = { cost: 0, tokens: 0, calls: 0 };
    byWorkflow[wf].cost += r.cost_usd;
    byWorkflow[wf].tokens += r.total_tokens;
    byWorkflow[wf].calls++;

    const day = r.created_at.slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { cost: 0, tokens: 0 };
    dayMap[day].cost += r.cost_usd;
    dayMap[day].tokens += r.total_tokens;
  }

  const byDay = Object.entries(dayMap)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { totalCost, totalTokens, callCount: records.length, byModel, byWorkflow, byDay };
}

interface CostDashboardProps {
  projectId?: string; // Optional: filter by project (for project workspace Cost tab)
}

export default function CostDashboard({ projectId }: CostDashboardProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [range, setRange] = useState<DateRange>('30d');

  const { data: records, isLoading } = useQuery({
    queryKey: ['token-usage', userId, range, projectId],
    queryFn: async () => {
      let query = supabase
        .from('token_usage_v2')
        .select('*')
        .eq('user_id', userId!)
        .order('created_at', { ascending: false });

      const cutoff = getDateCutoff(range);
      if (cutoff) {
        query = query.gte('created_at', cutoff);
      }
      if (projectId) {
        query = query.eq('metadata->>project_id', projectId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as TokenUsage[];
    },
    enabled: !!userId,
  });

  const summary = useMemo(() => summarize(records || []), [records]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-32 text-sm text-gray-500">Loading cost data...</div>;
  }

  if (!records?.length) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center">
        <svg className="h-12 w-12 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm text-gray-500">No usage data yet</p>
        <p className="text-xs text-gray-400 mt-1">Cost tracking begins when content is created via Eve or Chat</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Date range selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {projectId ? 'Project Cost' : 'Usage & Cost'}
        </h2>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
          {(['7d', '30d', '90d', 'all'] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                range === r
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {r === 'all' ? 'All Time' : r}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total Cost" value={`$${summary.totalCost.toFixed(4)}`} />
        <SummaryCard label="Total Tokens" value={summary.totalTokens.toLocaleString()} />
        <SummaryCard label="API Calls" value={summary.callCount.toLocaleString()} />
      </div>

      {/* Cost by day — simple bar chart */}
      {summary.byDay.length > 1 && (
        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Daily Cost</h3>
          <div className="flex items-end gap-1 h-32">
            {(() => {
              const maxCost = Math.max(...summary.byDay.map((d) => d.cost));
              return summary.byDay.map((d) => (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: $${d.cost.toFixed(4)}`}>
                  <div
                    className="w-full rounded-t bg-brand-500 min-h-[2px] transition-all"
                    style={{ height: `${maxCost > 0 ? (d.cost / maxCost) * 100 : 0}%` }}
                  />
                  {summary.byDay.length <= 14 && (
                    <span className="text-[9px] text-gray-400 -rotate-45 origin-top-left whitespace-nowrap">
                      {d.date.slice(5)}
                    </span>
                  )}
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* Cost by model */}
      <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">By Model</h3>
        <div className="space-y-2">
          {Object.entries(summary.byModel)
            .sort(([, a], [, b]) => b.cost - a.cost)
            .map(([model, stats]) => (
              <div key={model} className="flex items-center justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400 font-mono text-xs">{model}</span>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-400">{stats.calls} calls</span>
                  <span className="text-xs text-gray-400">{stats.tokens.toLocaleString()} tokens</span>
                  <span className="font-medium text-gray-900 dark:text-white">${stats.cost.toFixed(4)}</span>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* Cost by workflow */}
      <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">By Workflow</h3>
        <div className="space-y-2">
          {Object.entries(summary.byWorkflow)
            .sort(([, a], [, b]) => b.cost - a.cost)
            .map(([wf, stats]) => (
              <div key={wf} className="flex items-center justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400 truncate max-w-[200px]">{wf}</span>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-400">{stats.calls} calls</span>
                  <span className="font-medium text-gray-900 dark:text-white">${stats.cost.toFixed(4)}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}
