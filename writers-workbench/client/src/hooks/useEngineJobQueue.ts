import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from '../config/supabase';
import { enqueueHubCommand } from '../lib/webhook';

/**
 * Track multiple long-running engine jobs started from action buttons, keyed by an arbitrary
 * action key (e.g. a chapter id + ":outline"). Each job is enqueued through the server proxy
 * (returns instantly with a job_id) and then background-polled via /api/jobs/engine/:id/status.
 * On completion the supplied React Query keys are invalidated so freshly generated content
 * appears on its own. The click handler never awaits the generation, so the UI stays responsive
 * and the user can fan out many jobs at once.
 */
export type QueuedJobState = 'queued' | 'error';

export interface QueuedJob {
  state: QueuedJobState;
  jobId: string | null;
}

const POLL_INTERVAL_MS = 15_000;

export function useEngineJobQueue(userId: string | undefined) {
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, QueuedJob>>({});
  // Invalidation keys live in a ref so the poller doesn't need them in its dependency list.
  const invalidateRef = useRef<Record<string, QueryKey[]>>({});

  const finish = useCallback(
    (key: string) => {
      for (const qk of invalidateRef.current[key] ?? []) {
        void queryClient.invalidateQueries({ queryKey: qk });
      }
      delete invalidateRef.current[key];
      setJobs((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [queryClient],
  );

  /** Queue a hub command for `key`. Returns immediately; results refetch when the job completes. */
  const enqueue = useCallback(
    async (key: string, message: string, invalidate: QueryKey[] = []) => {
      if (!userId) return;
      invalidateRef.current[key] = invalidate;
      setJobs((prev) => ({ ...prev, [key]: { state: 'queued', jobId: null } }));
      try {
        const { jobId } = await enqueueHubCommand(userId, message);
        if (jobId) {
          setJobs((prev) => ({ ...prev, [key]: { state: 'queued', jobId } }));
        } else {
          // Sync op (or no engine job) — nothing to poll; refetch shortly and clear.
          setTimeout(() => finish(key), 4_000);
        }
      } catch {
        setJobs((prev) => ({ ...prev, [key]: { state: 'error', jobId: null } }));
      }
    },
    [userId, finish],
  );

  /** Track an engine job created by a dedicated endpoint (returns a job_id directly, not via a hub
   *  command) so it gets the same background poll + query invalidation as enqueue(). */
  const trackJob = useCallback((key: string, jobId: string, invalidate: QueryKey[] = []) => {
    invalidateRef.current[key] = invalidate;
    setJobs((prev) => ({ ...prev, [key]: { state: 'queued', jobId } }));
  }, []);

  /** Manually drop a tracked job (e.g. to dismiss an error and re-enable the button). */
  const clear = useCallback((key: string) => {
    delete invalidateRef.current[key];
    setJobs((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Background poll every active job that has a job_id. Re-runs whenever the job set changes.
  useEffect(() => {
    const active = Object.entries(jobs).filter(([, j]) => j.state === 'queued' && j.jobId);
    if (active.length === 0) return;
    let cancelled = false;

    const interval = setInterval(async () => {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token;
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      for (const [key, j] of active) {
        if (cancelled) return;
        try {
          const pr = await fetch(`/api/jobs/engine/${j.jobId}/status`, { headers });
          const pj = (await pr.json()) as { status?: string };
          if (pj.status === 'complete') {
            if (!cancelled) finish(key);
          } else if (pj.status === 'error' || pj.status === 'not_found') {
            if (!cancelled) {
              setJobs((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], state: 'error' } } : prev));
            }
          }
        } catch {
          // transient poll error — keep trying on the next tick
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobs, finish]);

  const stateOf = useCallback((key: string): QueuedJobState | undefined => jobs[key]?.state, [jobs]);

  return { jobs, enqueue, trackJob, clear, stateOf };
}
