import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from '../config/supabase';

/**
 * Non-blocking engine chapter-repair (chapter.repair) with Cancel, shared by the Chapters-table Fix
 * Drift button and the ContentDetail Engine-QA panel so they behave identically (CR-010 B2).
 *
 * queue() POSTs /api/content/:id/repair and hands off to a background poller — the click never awaits
 * the (minutes-long) repair, so the UI stays responsive and many chapters can be fixed in parallel.
 * On completion the supplied React Query keys are invalidated so the drift badge refreshes. cancel()
 * aborts the in-flight engine job (queued → dropped, running → cancelled at its next await).
 */
export type RepairState = 'idle' | 'queued' | 'error';

const POLL_INTERVAL_MS = 15_000;
const DEADLINE_MS = 40 * 60 * 1000;

export function useChapterRepair(contentId: string, invalidateKeys: QueryKey[]) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RepairState>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Hold the invalidate keys in a ref so the poller effect doesn't re-subscribe on array identity.
  const keysRef = useRef(invalidateKeys);
  keysRef.current = invalidateKeys;

  const invalidateAll = useCallback(async () => {
    for (const qk of keysRef.current) {
      await queryClient.invalidateQueries({ queryKey: qk });
    }
  }, [queryClient]);

  // Background poll — runs only while a job is in flight; never blocks the click handler.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const deadline = Date.now() + DEADLINE_MS;
    async function poll() {
      while (!cancelled && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        if (cancelled) return;
        try {
          const { data: s } = await supabase.auth.getSession();
          const token = s?.session?.access_token;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
          const pr = await fetch(`/api/jobs/engine/${jobId}/status`, { headers });
          const pj = (await pr.json()) as { status?: string };
          if (pj.status === 'complete') {
            if (cancelled) return;
            await invalidateAll();
            setJobId(null);
            setState('idle');
            return;
          }
          if (pj.status === 'error' || pj.status === 'not_found') {
            if (!cancelled) {
              setState('error');
              setJobId(null);
            }
            return;
          }
        } catch {
          // transient poll error — keep trying until the deadline
        }
      }
    }
    void poll();
    return () => {
      cancelled = true;
    };
  }, [jobId, invalidateAll]);

  const queue = useCallback(async () => {
    setState('queued');
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token;
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const r = await fetch(`/api/content/${contentId}/repair`, { method: 'POST', headers });
      const j = (await r.json()) as { jobId?: string };
      if (!r.ok || !j.jobId) throw new Error('repair failed to queue');
      setJobId(j.jobId); // hands off to the background poller; the click is already done
    } catch {
      setState('error');
    }
  }, [contentId]);

  // Cancel the in-flight repair: aborts the engine arq job, stops the poller, refetches in case the
  // job had partially written before the abort landed. Idempotent — safe even if it just finished.
  const cancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token;
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      await fetch(`/api/jobs/engine/${jobId}/abort`, { method: 'POST', headers });
      await invalidateAll();
    } catch {
      // best-effort — the poller would still reconcile on its own
    } finally {
      setJobId(null); // stops the background poller via its cleanup
      setState('idle');
      setCancelling(false);
    }
  }, [jobId, invalidateAll]);

  return { state, jobId, queue, cancel, cancelling };
}
