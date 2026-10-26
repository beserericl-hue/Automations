/**
 * The watch nobody had: Redis, the job queues and the engine, checked every few minutes, with an
 * email when one goes down and another when it comes back.
 *
 * WHY. PROD's Redis died on 2026-05-19 and stayed dead for nine days. /api/health said so the whole
 * time; nothing was asking. Every queued job (chapter writes, newsletters, live updates) failed
 * quietly in that window.
 *
 * It runs inside the web server, so it cannot report the web server itself being down; Railway's
 * own healthcheck restarts that. What it does catch is the case that happened: the app up, a
 * dependency it needs gone.
 *
 *   ALERT_EMAIL               who is told (comma-separated); unset = log only
 *   HEALTH_WATCH_INTERVAL_MS  default 5 minutes
 *   QUEUE_ALERT_DEPTH         waiting jobs on one queue before it counts as backed up; default 50
 */

import { logger } from './logger.js';

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export type Checks = Record<string, CheckResult>;

interface Tracked {
  ok: boolean;
  since: string;
  /** Consecutive failed checks. */
  failures: number;
  /** Set once a "down" alert has gone out for this outage. */
  lastAlertAt?: string;
}

const REALERT_MS = 6 * 3600_000;
/**
 * Two failed checks in a row (about ten minutes) before anyone is told. A deploy restarts the
 * engine for a minute or two, and a single check landing in that window is not an outage.
 */
const FAILURES_BEFORE_ALERT = 2;

/** What changed, and what to say about it. Pure: the tests drive it with fixed checks and times. */
export function transitions(
  state: Record<string, Tracked>,
  checks: Checks,
  now: Date,
): { next: Record<string, Tracked>; down: string[]; recovered: string[] } {
  const next: Record<string, Tracked> = { ...state };
  const down: string[] = [];
  const recovered: string[] = [];
  const iso = now.toISOString();
  for (const [name, r] of Object.entries(checks)) {
    const prev = state[name];
    if (r.ok) {
      // A recovery is news only if the outage was reported.
      if (prev && !prev.ok && prev.lastAlertAt) recovered.push(name);
      next[name] = { ok: true, since: prev?.ok ? prev.since : iso, failures: 0 };
      continue;
    }
    const failures = (prev && !prev.ok ? prev.failures : 0) + 1;
    const since = prev && !prev.ok ? prev.since : iso;
    let lastAlertAt = prev && !prev.ok ? prev.lastAlertAt : undefined;
    const due =
      failures >= FAILURES_BEFORE_ALERT &&
      (!lastAlertAt || now.getTime() - Date.parse(lastAlertAt) >= REALERT_MS);
    if (due) {
      lastAlertAt = iso;
      down.push(name);
    }
    next[name] = { ok: false, since, failures, ...(lastAlertAt ? { lastAlertAt } : {}) };
  }
  return { next, down, recovered };
}

export async function runChecks(): Promise<Checks> {
  const checks: Checks = {};
  if (process.env.REDIS_URL) {
    try {
      const { redisHealthy } = await import('./redis.js');
      checks.redis = (await redisHealthy()) ? { ok: true, detail: 'PONG' } : { ok: false, detail: 'no PONG' };
    } catch (err) {
      checks.redis = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }
    if (checks.redis.ok) {
      const depth = Number(process.env.QUEUE_ALERT_DEPTH || 50);
      try {
        const { getNamedQueue } = await import('./queue.js');
        const { ALL_QUEUE_NAMES } = await import('./jobs/types.js');
        for (const name of ALL_QUEUE_NAMES) {
          const counts = await getNamedQueue(name).getJobCounts('waiting', 'active', 'failed');
          const waiting = Number(counts.waiting ?? 0);
          checks[`queue:${name}`] = {
            ok: waiting <= depth,
            detail: `${waiting} waiting, ${counts.active ?? 0} active, ${counts.failed ?? 0} failed`,
          };
        }
      } catch (err) {
        checks.queues = { ok: false, detail: err instanceof Error ? err.message : 'could not read' };
      }
    }
  }
  try {
    const { engineGatewayUrl } = await import('./engine-hub.js');
    const r = await fetch(`${engineGatewayUrl()}/admin/ready`, { signal: AbortSignal.timeout(10_000) });
    checks.engine = r.ok ? { ok: true, detail: 'ready' } : { ok: false, detail: `HTTP ${r.status}` };
  } catch (err) {
    checks.engine = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
  }
  return checks;
}

function recipients(): string[] {
  return (process.env.ALERT_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function alert(subject: string, lines: string[]): Promise<void> {
  const to = recipients();
  const env = process.env.NODE_ENV === 'production' ? 'PROD' : 'DEV';
  logger.error({ subject, lines }, 'health-watch');
  if (!to.length) return;
  try {
    const { sendEmail } = await import('./email.js');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    await sendEmail({
      to,
      subject: `[Writers Workbench ${env}] ${subject}`,
      text: lines.join('\n'),
      html: `<pre style="font:14px/1.5 monospace">${esc(lines.join('\n'))}</pre>`,
    });
  } catch (err) {
    logger.error({ err }, 'health-watch: alert email failed');
  }
}

let state: Record<string, Tracked> = {};
let timer: ReturnType<typeof setInterval> | null = null;

export async function tick(now = new Date()): Promise<void> {
  const checks = await runChecks();
  const { next, down, recovered } = transitions(state, checks, now);
  state = next;
  if (down.length) {
    await alert(
      `DOWN: ${down.join(', ')}`,
      down.map((n) => `${n}: ${checks[n].detail} (down since ${next[n].since})`),
    );
  }
  if (recovered.length) {
    await alert(`Recovered: ${recovered.join(', ')}`, recovered.map((n) => `${n}: ${checks[n].detail}`));
  }
}

/** Start the watch. A no-op under test, and when HEALTH_WATCH=off. */
export function startHealthWatch(): void {
  if (timer || process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.HEALTH_WATCH === 'off') return;
  const every = Math.max(60_000, Number(process.env.HEALTH_WATCH_INTERVAL_MS || 300_000));
  timer = setInterval(() => void tick().catch((err) => logger.error({ err }, 'health-watch: tick failed')), every);
  timer.unref?.();
  logger.info({ every, alertTo: recipients().length }, 'health-watch started');
}
