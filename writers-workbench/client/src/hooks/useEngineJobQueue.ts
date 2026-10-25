import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from '../config/supabase';
import { enqueueHubCommand } from '../lib/webhook';

/**
 * Track multiple long-running engine jobs started from action buttons, keyed by an action key
 * (e.g. a chapter id + ":outline"). Each job is enqueued through the server proxy (returns instantly
 * with a job_id) and then background-polled via /api/jobs/engine/:id/status. On completion the
 * supplied React Query keys are invalidated so freshly generated content appears on its own. The
 * click handler never awaits the generation, so the UI stays responsive.
 *
 * WHERE THE JOBS LIVE. In one module-level store shared by every component, saved to the browser
 * session — not in the state of the component that started them. They used to be component state,
 * so a job outlived the button that started it but not the panel the button sat in: queue "Rewrite
 * to fix Q/A", switch to the Review tab and back, and the panel had remounted with no memory of the
 * job. The button looked idle, and because the job was no longer tracked, nothing refetched the
 * chapter or its versions when it finished — the rewrite was saved but the page never showed it.
 *
 * SCOPE. Keys are only unique within a page ("qa-fix", "book-cover", a chapter number), so a store
 * shared across pages needs a scope: pass the project or content id the job belongs to.
 */
export type QueuedJobState = 'queued' | 'error';

export interface QueuedJob {
  state: QueuedJobState;
  jobId: string | null;
}

interface Entry extends QueuedJob {
  invalidate: QueryKey[];
  startedAt: number;
}

const POLL_INTERVAL_MS = 15_000;
const STORAGE_KEY = 'ww.engineJobs.v1';
/** A job older than this is dropped rather than polled forever; the longest engine jobs run ~90 min. */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

function load(): Record<string, Entry> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(parsed).filter(([, e]) => now - (e.startedAt ?? 0) < MAX_AGE_MS));
  } catch {
    return {};
  }
}

let store: Record<string, Entry> = typeof window === 'undefined' ? {} : load();
const listeners = new Set<() => void>();
let client: QueryClient | null = null;
let mountedHooks = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function commit(next: Record<string, Entry>): void {
  store = next;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private windows can refuse storage; the in-memory store still works for this page.
  }
  listeners.forEach((l) => l());
  if (Object.values(store).some((e) => e.state === 'queued' && e.jobId)) startPolling();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function finish(fullKey: string): void {
  const entry = store[fullKey];
  if (!entry) return;
  for (const qk of entry.invalidate) void client?.invalidateQueries({ queryKey: qk });
  const next = { ...store };
  delete next[fullKey];
  commit(next);
}

function markError(fullKey: string): void {
  const entry = store[fullKey];
  if (entry) commit({ ...store, [fullKey]: { ...entry, state: 'error' } });
}

async function pollOnce(): Promise<void> {
  const active = Object.entries(store).filter(([, e]) => e.state === 'queued' && e.jobId);
  if (active.length === 0) {
    stopPolling();
    return;
  }
  const { data: s } = await supabase.auth.getSession();
  const token = s?.session?.access_token;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  for (const [key, e] of active) {
    try {
      const pr = await fetch(`/api/jobs/engine/${e.jobId}/status`, { headers });
      const pj = (await pr.json()) as { status?: string };
      if (pj.status === 'complete') finish(key);
      else if (pj.status === 'error' || pj.status === 'not_found') markError(key);
    } catch {
      // transient poll error — keep trying on the next tick
    }
  }
}

function startPolling(): void {
  if (pollTimer || mountedHooks === 0) return;
  void pollOnce(); // a job restored from the session may already be done
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Test seam: forget every tracked job. */
export function resetEngineJobs(): void {
  stopPolling();
  commit({});
}

export function useEngineJobQueue(userId: string | undefined, scope = '') {
  const queryClient = useQueryClient();
  const jobsAll = useSyncExternalStore(subscribe, () => store, () => store);
  const full = useCallback((key: string) => (scope ? `${scope}|${key}` : key), [scope]);

  // Polling runs while at least one hook is mounted, wherever the job was started.
  useEffect(() => {
    client = queryClient;
    mountedHooks += 1;
    startPolling();
    return () => {
      mountedHooks -= 1;
      if (mountedHooks === 0) stopPolling();
    };
  }, [queryClient]);

  /** Queue a hub command for `key`. Returns immediately; results refetch when the job completes. */
  const enqueue = useCallback(
    async (key: string, message: string, invalidate: QueryKey[] = []) => {
      if (!userId) return;
      const k = full(key);
      commit({ ...store, [k]: { state: 'queued', jobId: null, invalidate, startedAt: Date.now() } });
      try {
        const { jobId } = await enqueueHubCommand(userId, message);
        if (jobId) {
          commit({ ...store, [k]: { ...store[k], state: 'queued', jobId } });
        } else {
          // Sync op (or no engine job) — nothing to poll; refetch shortly and clear.
          setTimeout(() => finish(k), 4_000);
        }
      } catch {
        if (store[k]) commit({ ...store, [k]: { ...store[k], state: 'error' } });
      }
    },
    [userId, full],
  );

  /** Track an engine job created by a dedicated endpoint (returns a job_id directly, not via a hub
   *  command) so it gets the same background poll + query invalidation as enqueue(). */
  const trackJob = useCallback(
    (key: string, jobId: string, invalidate: QueryKey[] = []) => {
      commit({ ...store, [full(key)]: { state: 'queued', jobId, invalidate, startedAt: Date.now() } });
    },
    [full],
  );

  /** Manually drop a tracked job (e.g. to dismiss an error and re-enable the button). */
  const clear = useCallback(
    (key: string) => {
      const next = { ...store };
      delete next[full(key)];
      commit(next);
    },
    [full],
  );

  const prefix = scope ? `${scope}|` : '';
  const jobs: Record<string, QueuedJob> = {};
  for (const [k, e] of Object.entries(jobsAll)) {
    if (prefix ? k.startsWith(prefix) : !k.includes('|')) jobs[k.slice(prefix.length)] = { state: e.state, jobId: e.jobId };
  }

  const stateOf = useCallback((key: string): QueuedJobState | undefined => jobsAll[full(key)]?.state, [jobsAll, full]);

  return { jobs, enqueue, trackJob, clear, stateOf };
}
