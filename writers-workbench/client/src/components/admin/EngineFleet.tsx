import { useQuery } from '@tanstack/react-query';

/**
 * Engine fleet (CR-010 C1/C4): which gateway and runtime replicas are alive, how loaded the engine's
 * queues are across all of them, what the capacity verdict says, and what the autoscaler last did.
 */

export interface FleetInstance {
  service: string;
  instance: string;
  region?: string;
  commit?: string;
  started_at?: number;
  last_seen?: number;
  draining?: boolean;
  running?: Record<string, number | null>;
  requests_served?: number;
}

export interface FleetQueue {
  queue: string;
  depth: number;
  running: number | null;
  waiting: number | null;
  max_jobs: number;
  saturation: number | null;
  oldest_wait_s: number | null;
  instances?: number;
  error?: string;
}

export interface EngineFleetData {
  served_by?: string;
  gateway_served_by?: string | null;
  server_sees_gateway_addresses?: number;
  gateway_sees_runtime_addresses?: number;
  instances: FleetInstance[];
  instance_counts?: Record<string, number>;
  verdict: string;
  reason: string;
  queues: FleetQueue[];
  budget_stalls_last_minute?: number;
  autoscale?: {
    refusal: string | null;
    config: { enabled: boolean; min_replicas: number; max_replicas: number; cooldown_s: number; environment_name: string };
    state?: {
      last_action?: string;
      last_reason?: string;
      last_current?: number | null;
      last_target?: number | null;
      last_tick_at?: number | null;
      last_change_at?: number | null;
    };
  };
}

const VERDICT_TEXT: Record<string, string> = {
  scale_out: 'Interactive work is queueing. Another runtime replica helps.',
  backlog: 'Heavy work is deeper than its slots, and nothing is waiting on tokens. More replicas help.',
  tpm_bound: 'Throughput is capped by the Anthropic token budget. More replicas will not help.',
  scale_in: 'Every queue is idle with slots to spare.',
  hold: 'Within capacity.',
  unknown: 'No worker heartbeat could be read.',
};

function ago(epochSeconds?: number | null): string {
  if (!epochSeconds) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function EngineFleet({ load }: { load: () => Promise<EngineFleetData> }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-engine-fleet'],
    queryFn: load,
    refetchInterval: 15_000,
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading engine fleet...</div>;
  if (error) return <div className="text-sm text-red-500">Failed to load the engine fleet: {(error as Error).message}</div>;
  if (!data) return <div className="text-sm text-gray-500">No data.</div>;

  const counts = data.instance_counts ?? {};
  const auto = data.autoscale;
  const state = auto?.state;

  return (
    <div className="space-y-6" data-testid="engine-fleet">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Runtime replicas" value={String(counts.orchestrator ?? 0)} testId="fleet-runtime-count" />
        <Tile label="Gateway replicas" value={String(counts.gateway ?? 0)} testId="fleet-gateway-count" />
        <Tile label="Capacity verdict" value={data.verdict} testId="fleet-verdict" />
        <Tile label="Token stalls (1 min)" value={String(data.budget_stalls_last_minute ?? 0)} />
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">
        {VERDICT_TEXT[data.verdict] ?? data.verdict}
        {data.reason && data.reason !== 'within capacity' ? <span className="text-gray-500"> {data.reason}</span> : null}
      </p>

      <p className="text-xs text-gray-500" data-testid="fleet-spread">
        Calls are spread across {data.server_sees_gateway_addresses ?? '?'} gateway address(es) and{' '}
        {data.gateway_sees_runtime_addresses ?? '?'} runtime address(es) on the private network. A count of 1 means
        every call goes to one replica.
      </p>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Autoscaler</h3>
        {auto?.refusal ? (
          <p className="text-sm text-gray-500" data-testid="fleet-autoscale-off">
            Off: {auto.refusal}.
          </p>
        ) : (
          <div className="space-y-1 text-sm text-gray-700 dark:text-gray-200" data-testid="fleet-autoscale-on">
            <p>
              On in <strong>{auto?.config.environment_name || 'this environment'}</strong>: {auto?.config.min_replicas} to{' '}
              {auto?.config.max_replicas} runtime replicas, at most one change every {auto?.config.cooldown_s}s.
            </p>
            <p>
              Last decision: <strong>{state?.last_action || 'none yet'}</strong>
              {state?.last_current != null ? ` (${state.last_current} → ${state.last_target})` : ''}, {ago(state?.last_tick_at)}.
              {state?.last_reason ? <span className="text-gray-500"> {state.last_reason}</span> : null}
            </p>
            <p className="text-gray-500">Last change: {ago(state?.last_change_at)}</p>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.queues.map((q) => (
          <div key={q.queue} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{q.queue}</h3>
              <span className="text-xs text-gray-500">
                {q.instances ?? 0} worker(s) · {q.max_jobs} slots
              </span>
            </div>
            {q.error ? (
              <p className="text-sm text-red-500">{q.error}</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 text-center text-sm">
                <Cell label="Running" value={q.running ?? '—'} />
                <Cell label="Waiting" value={q.waiting ?? '—'} />
                <Cell label="Busy" value={q.saturation == null ? '—' : `${Math.round(q.saturation * 100)}%`} />
                <Cell label="Oldest wait" value={q.oldest_wait_s == null ? '—' : `${Math.round(q.oldest_wait_s)}s`} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full text-sm" data-testid="fleet-instances">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-800">
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2">Instance</th>
              <th className="px-4 py-2">Commit</th>
              <th className="px-4 py-2">Up since</th>
              <th className="px-4 py-2">Seen</th>
              <th className="px-4 py-2">Load</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.instances.map((i) => (
              <tr key={`${i.service}:${i.instance}`}>
                <td className="px-4 py-2 text-gray-900 dark:text-white">{i.service === 'orchestrator' ? 'runtime' : i.service}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
                  {i.instance.slice(0, 12)}
                  {i.draining ? <span className="ml-2 rounded bg-yellow-100 px-1 text-yellow-800">draining</span> : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-500">{i.commit || '—'}</td>
                <td className="px-4 py-2 text-gray-500">{ago(i.started_at)}</td>
                <td className="px-4 py-2 text-gray-500">{ago(i.last_seen)}</td>
                <td className="px-4 py-2 text-gray-500">
                  {i.running
                    ? Object.entries(i.running)
                        .map(([q, n]) => `${q.replace('engine-', '')} ${n ?? '—'}`)
                        .join(' · ')
                    : i.requests_served != null
                      ? `${i.requests_served} requests`
                      : '—'}
                </td>
              </tr>
            ))}
            {data.instances.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  No engine instance has reported in the last 90 seconds.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">
        Queue counts are the fleet totals: they cover every replica. Answered by gateway {data.gateway_served_by?.slice(0, 12) ?? '—'} and
        runtime {data.served_by?.slice(0, 12) ?? '—'}. Refreshes every 15s.
      </p>
    </div>
  );
}

function Tile({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="text-xl font-semibold text-gray-900 dark:text-white" data-testid={testId}>
        {value}
      </div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-gray-100 px-2 py-2 dark:border-gray-800">
      <div className="font-semibold text-gray-800 dark:text-gray-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
