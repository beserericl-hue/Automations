/**
 * Single-delivery probe (item 16): does every engine job execute exactly once across the fleet?
 *
 * Enqueues cheap async jobs — `library` / `list-outlines`, interactive queue, no model calls, no
 * email — with unique run_ids, plus pairs that share one caller run_id, all at once so both runtime
 * replicas compete for them. The verdict is read from the engine's run ledger (`engine_job_runs`):
 * every distinct run must have exactly one row, `complete`, with `attempts = 1`. A run executed
 * twice shows up as `attempts > 1` — the ledger bumps it whenever a second execution claims an
 * in-progress run, which is exactly the overlap the engine's run lease exists to prevent.
 */
export const PROBE_PREFIX = 'sdp-';
export const MAX_PROBE_JOBS = 50;
export const MAX_PROBE_DUPES = 10;

export interface ProbePlan {
  tag: string;
  unique: string[];
  dupes: string[];
}

export function planProbe(jobs: number, dupes: number, now: number = Date.now()): ProbePlan {
  const tag = `${PROBE_PREFIX}${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const n = Math.max(1, Math.min(MAX_PROBE_JOBS, Math.floor(jobs)));
  const d = Math.max(0, Math.min(MAX_PROBE_DUPES, Math.floor(dupes)));
  return {
    tag,
    unique: Array.from({ length: n }, (_, i) => `${tag}-u${i}`),
    dupes: Array.from({ length: d }, (_, i) => `${tag}-d${i}`),
  };
}

/** Every submission the probe makes: each unique run once, each duplicate run twice. */
export function submissions(plan: ProbePlan): string[] {
  return [...plan.unique, ...plan.dupes.flatMap((r) => [r, r])];
}

export interface LedgerRow {
  run_id: string;
  status: string;
  attempts: number;
}

export interface ProbeVerdict {
  tag: string;
  distinct_runs: number;
  ledger_rows: number;
  complete: number;
  max_attempts: number;
  done: boolean;
  problems: string[];
  verdict: 'PASS' | 'FAIL' | 'PENDING';
}

/**
 * Judge the ledger rows for one probe tag. `PENDING` until all `expected` runs have a row and none is
 * still in progress. `expected` is the number of distinct runs the probe enqueued (the POST returns
 * it); without it, "done" only means "nothing seen is still running".
 */
export function judge(tag: string, rows: LedgerRow[], expected?: number): ProbeVerdict {
  const mine = rows.filter((r) => r.run_id.startsWith(`${tag}-`));
  const unique = [...new Set(mine.map((r) => r.run_id))];
  const complete = mine.filter((r) => r.status === 'complete').length;
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const r of mine) counts.set(r.run_id, (counts.get(r.run_id) ?? 0) + 1);
  for (const [id, c] of counts) if (c > 1) problems.push(`${id}: ${c} ledger rows`);
  for (const r of mine) {
    if (Number(r.attempts) > 1) problems.push(`${r.run_id}: executed ${r.attempts} times`);
    if (r.status === 'error') problems.push(`${r.run_id}: errored`);
  }
  const done = unique.length >= (expected ?? 1) && mine.every((r) => r.status !== 'in_progress');
  return {
    tag,
    distinct_runs: unique.length,
    ledger_rows: mine.length,
    complete,
    max_attempts: mine.reduce((m, r) => Math.max(m, Number(r.attempts) || 0), 0),
    done,
    problems,
    verdict: problems.length ? 'FAIL' : done ? 'PASS' : 'PENDING',
  };
}

export function isProbeTag(tag: string): boolean {
  return /^sdp-[a-z0-9]{4,24}$/.test(tag);
}
