import { useQuery } from '@tanstack/react-query';

/**
 * Engine scheduler (cron) health. The engine runs its own clock (writer_engine.scheduler): ingestion,
 * the newsletter cadence, scheduled publishing, the radar, the autoscaler and so on. A scheduler that
 * silently stopped looks exactly like one with nothing to do, so this lists every job with its last
 * run, its last error and when it is next due, and flags the ones that are failing or overdue.
 *
 * The server reads every runtime replica with the engine admin token and merges them; the token
 * never reaches the browser.
 */

export type SchedulerHealth = 'ok' | 'failing' | 'overdue' | 'waiting' | 'pending';

export interface SchedulerJobRow {
  name: string;
  interval_s: number;
  singleton: boolean;
  ticks: number;
  skipped: number;
  last_run: string | null;
  last_error: string | null;
  /** The latest run's own summary; `skipped` means it deliberately did nothing (e.g. unconfigured). */
  last_result?: Record<string, unknown> | null;
  next_run: string | null;
  health: SchedulerHealth;
  replicas: Array<{ instance: string; ticks: number; skipped: number; last_run: string | null; last_error: string | null }>;
}

export interface EngineSchedulerData {
  running: boolean;
  replicas: Array<{ instance: string; address: string; ok: boolean; running?: boolean; error?: string }>;
  jobs: SchedulerJobRow[];
  checked_at: string;
}

const HEALTH: Record<SchedulerHealth, { label: string; cls: string; hint: string }> = {
  ok: { label: 'OK', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', hint: 'Ran on time and succeeded.' },
  failing: { label: 'Failing', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', hint: 'The latest run threw an error.' },
  overdue: { label: 'Overdue', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', hint: 'No run for more than two intervals.' },
  waiting: {
    label: 'Waiting',
    cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    hint: 'Not run since the replicas started: another holder had its lock (usually the run just before a deploy).',
  },
  pending: { label: 'Pending', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', hint: 'Not run yet; the first tick comes shortly after start-up.' },
};

export function formatInterval(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** A run's returned summary as one short line: "skipped: not configured · deleted: 2". */
export function resultSummary(r: Record<string, unknown> | null | undefined): string {
  if (!r) return '';
  const text = Object.entries(r)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function relative(iso: string | null, now: number): string {
  if (!iso) return '—';
  const diff = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(diff);
  const text = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return diff <= 0 ? `${text} ago` : `in ${text}`;
}

export default function EngineScheduler({ load }: { load: () => Promise<EngineSchedulerData> }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-engine-scheduler'],
    queryFn: load,
    refetchInterval: 30_000,
  });

  return (
    <section data-testid="engine-scheduler" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Scheduled jobs (cron)</h2>
        {data && (
          <span className="text-xs text-gray-500" data-testid="scheduler-summary">
            {data.jobs.length} jobs · {data.replicas.filter((r) => r.ok).length} of {data.replicas.length} runtime replica(s) answered
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="text-sm text-gray-500">Loading the scheduler...</div>
      ) : error ? (
        <div className="text-sm text-red-500" data-testid="scheduler-error">
          Failed to load the scheduler: {(error as Error).message}
        </div>
      ) : !data ? (
        <div className="text-sm text-gray-500">No data.</div>
      ) : (
        <SchedulerBody data={data} />
      )}
    </section>
  );
}

function SchedulerBody({ data }: { data: EngineSchedulerData }) {
  const now = Date.now();
  const failing = data.jobs.filter((j) => j.health === 'failing');
  const overdue = data.jobs.filter((j) => j.health === 'overdue');
  const unreachable = data.replicas.filter((r) => !r.ok);

  return (
    <>
      {!data.running && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" data-testid="scheduler-stopped">
          The scheduler is not running on at least one runtime replica: no scheduled job is enabled there.
        </p>
      )}
      {failing.length + overdue.length > 0 ? (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" data-testid="scheduler-alert">
          Needs attention: {[...failing, ...overdue].map((j) => `${j.name} (${HEALTH[j.health].label.toLowerCase()})`).join(', ')}.
        </p>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="scheduler-allclear">
          No job is failing or overdue.
        </p>
      )}
      {unreachable.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="scheduler-unreachable">
          Did not answer: {unreachable.map((r) => `${r.address} (${r.error ?? 'error'})`).join(', ')}. Its runs are missing below.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full text-sm" data-testid="scheduler-jobs">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-800">
              <th className="px-4 py-2">Job</th>
              <th className="px-4 py-2">Every</th>
              <th className="px-4 py-2">Last run</th>
              <th className="px-4 py-2">Last result</th>
              <th className="px-4 py-2">Next run</th>
              <th className="px-4 py-2">Health</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.jobs.map((j) => (
              <tr key={j.name} data-testid={`scheduler-job-${j.name}`} data-health={j.health}>
                <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-white">
                  {j.name}
                  {!j.singleton && <span className="ml-1 text-[10px] text-gray-400" title="Runs on every replica">(per replica)</span>}
                </td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{formatInterval(j.interval_s)}</td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-300" title={j.last_run ?? undefined}>
                  {relative(j.last_run, now)}
                </td>
                <td className="px-4 py-2 text-xs">
                  {j.last_error ? (
                    <span className="text-red-600 dark:text-red-400" data-testid="scheduler-last-error">{j.last_error}</span>
                  ) : j.last_run && typeof j.last_result?.skipped === 'string' ? (
                    <span className="text-gray-500 dark:text-gray-400" data-testid="scheduler-last-skipped">
                      Skipped: {j.last_result.skipped}
                    </span>
                  ) : j.last_run ? (
                    <span className="text-gray-600 dark:text-gray-300">
                      OK
                      {resultSummary(j.last_result) && (
                        <span className="ml-1 text-gray-500" data-testid="scheduler-last-result">
                          · {resultSummary(j.last_result)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                  <div className="text-[10px] text-gray-400">
                    {j.ticks} run(s){j.skipped ? `, ${j.skipped} left to another replica` : ''}
                  </div>
                </td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-300" title={j.next_run ?? undefined}>
                  {j.next_run ? relative(j.next_run, now) : '—'}
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${HEALTH[j.health].cls}`} title={HEALTH[j.health].hint}>
                    {HEALTH[j.health].label}
                  </span>
                </td>
              </tr>
            ))}
            {data.jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400" data-testid="scheduler-empty">
                  No scheduled job is enabled on the engine.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">
        Runs are merged across every runtime replica: a job runs on whichever replica takes its lock first. Next run is the
        last run plus the interval. Refreshes every 30s; checked {relative(data.checked_at, now)}.
      </p>
    </>
  );
}
