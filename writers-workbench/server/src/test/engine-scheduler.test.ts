/**
 * Admin → Engine Fleet → Scheduled jobs. The server reads the engine runtime's /admin/scheduler from
 * EVERY runtime replica with the admin token (which never goes to the browser), and merges them: a
 * singleton job runs on whichever replica takes its lock, so one replica alone would report a healthy
 * job as never run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeSchedulerReports, type SchedulerJobReport } from '../lib/engine-hub.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('node:dns/promises');
  vi.resetModules();
});

const NOW = Date.parse('2026-11-02T20:30:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const job = (o: Partial<SchedulerJobReport> & { name: string }): SchedulerJobReport => ({
  interval_s: 900, singleton: true, ticks: 0, skipped: 0, last_run: null, last_error: null, ...o,
});

describe('mergeSchedulerReports', () => {
  it('takes the latest run across replicas, and that run’s error, and sums the counters', () => {
    const [radar] = mergeSchedulerReports(
      [
        { instance: 'a', jobs: [job({ name: 'radar', interval_s: 3600, skipped: 1 })] },
        { instance: 'b', jobs: [job({ name: 'radar', interval_s: 3600, ticks: 1, last_run: ago(600) })] },
      ],
      NOW,
    );
    expect(radar).toMatchObject({ ticks: 1, skipped: 1, last_run: ago(600), last_error: null, health: 'ok', next_run: ago(600 - 3600) });
    expect(radar.replicas.map((r) => r.instance)).toEqual(['a', 'b']);
  });

  it('flags a job whose latest run failed, but not one whose old failure was followed by a good run elsewhere', () => {
    const jobs = mergeSchedulerReports(
      [
        { instance: 'a', jobs: [job({ name: 'ingestion', ticks: 1, last_run: ago(100), last_error: 'RuntimeError: boom' }), job({ name: 'cadence', ticks: 1, last_run: ago(2000), last_error: 'old' })] },
        { instance: 'b', jobs: [job({ name: 'ingestion', ticks: 1, last_run: ago(1000) }), job({ name: 'cadence', ticks: 1, last_run: ago(100) })] },
      ],
      NOW,
    );
    expect(jobs.find((j) => j.name === 'ingestion')).toMatchObject({ health: 'failing', last_error: 'RuntimeError: boom' });
    expect(jobs.find((j) => j.name === 'cadence')).toMatchObject({ health: 'ok', last_error: null });
  });

  it('calls a job overdue after two intervals plus grace, and tells never-run jobs apart', () => {
    const jobs = mergeSchedulerReports(
      [{
        instance: 'a',
        jobs: [
          job({ name: 'late', interval_s: 300, ticks: 1, last_run: ago(300 * 2 + 121) }),
          job({ name: 'on-time', interval_s: 300, ticks: 1, last_run: ago(300 * 2 + 60) }),
          job({ name: 'locked-elsewhere', skipped: 2 }),
          job({ name: 'starting' }),
        ],
      }],
      NOW,
    );
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.health]))).toEqual({
      late: 'overdue', 'on-time': 'ok', 'locked-elsewhere': 'waiting', starting: 'pending',
    });
    expect(jobs.find((j) => j.name === 'starting')!.next_run).toBeNull();
  });
});

describe('getEngineScheduler', () => {
  it('asks every runtime replica with the admin token and merges their answers', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: async () => [{ address: '10.0.0.1', family: 4 }, { address: '10.0.0.2', family: 4 }, { address: 'fd12::1', family: 6 }],
    }));
    vi.stubEnv('ENGINE_RUNTIME_URL', 'http://writer-engine-runtime.railway.internal:8001');
    vi.stubEnv('ENGINE_ADMIN_TOKEN', 'adm1n');
    const calls: Array<{ url: string; headers: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers });
      const mine = url.includes('10.0.0.1');
      return new Response(
        JSON.stringify({ running: true, jobs: [{ name: 'radar', interval_s: 3600, singleton: true, ticks: mine ? 1 : 0, skipped: mine ? 0 : 1, last_run: mine ? new Date().toISOString() : null, last_error: null }] }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-engine-instance': mine ? 'rep-a' : 'rep-b' } },
      );
    }));
    const { getEngineScheduler } = await import('../lib/engine-hub.js');
    const view = await getEngineScheduler();
    expect(calls.map((c) => c.url).sort()).toEqual(['http://10.0.0.1:8001/admin/scheduler', 'http://10.0.0.2:8001/admin/scheduler']);
    expect(calls[0].headers).toEqual({ 'x-admin-token': 'adm1n' });
    expect(view.running).toBe(true);
    expect(view.replicas.map((r) => r.instance).sort()).toEqual(['rep-a', 'rep-b']);
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0]).toMatchObject({ name: 'radar', ticks: 1, skipped: 1, health: 'ok' });
    expect(JSON.stringify(view)).not.toContain('adm1n');
  });

  it('reports a replica that did not answer, and fails only when none did', async () => {
    vi.doMock('node:dns/promises', () => ({ lookup: async () => [{ address: '10.0.0.1', family: 4 }, { address: '10.0.0.2', family: 4 }] }));
    vi.stubEnv('ENGINE_RUNTIME_URL', 'http://writer-engine-runtime.railway.internal:8001');
    vi.stubEnv('ENGINE_ADMIN_TOKEN', 'adm1n');
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('10.0.0.2') ? new Response('nope', { status: 401 }) : new Response(JSON.stringify({ running: true, jobs: [] }), { status: 200 }),
    ));
    const { getEngineScheduler } = await import('../lib/engine-hub.js');
    const view = await getEngineScheduler();
    expect(view.replicas.find((r) => r.address === '10.0.0.2')).toMatchObject({ ok: false, error: 'HTTP 401' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(getEngineScheduler()).rejects.toThrow(/engine scheduler unreachable/);
  });

  it('refuses without an admin token rather than calling the engine', async () => {
    vi.stubEnv('ENGINE_ADMIN_TOKEN', '');
    vi.stubEnv('ADMIN_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getEngineScheduler } = await import('../lib/engine-hub.js');
    await expect(getEngineScheduler()).rejects.toThrow('ENGINE_ADMIN_TOKEN is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
