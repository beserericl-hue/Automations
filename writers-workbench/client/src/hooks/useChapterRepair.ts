import { useCallback, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from '../config/supabase';
import { useUser } from '../contexts/UserContext';
import { useEngineJobQueue } from './useEngineJobQueue';

/**
 * Non-blocking engine chapter-repair (chapter.repair) with Cancel, shared by the Chapters-table Fix
 * Drift button and the ContentDetail Engine-QA panel so they behave identically (CR-010 B2).
 *
 * queue() POSTs /api/content/:id/repair and hands the engine job to the shared job store — the click
 * never awaits the (minutes-long) repair, so the UI stays responsive and many chapters can be fixed in
 * parallel. cancel() aborts the in-flight engine job (queued → dropped, running → cancelled at its
 * next await).
 *
 * WHY THE SHARED STORE. The job used to live in this hook's component state, so leaving the chapter
 * dropped it: come back and the button read "Fix drift" again while the repair was still running,
 * and nothing refetched the chapter when it finished. In useEngineJobQueue, scoped to the chapter, the
 * job survives navigation and a reload of the tab, and both buttons see the same job — queue it from
 * the Chapters table and the chapter page shows it queued too.
 */
export type RepairState = 'idle' | 'queued' | 'error';

const KEY = 'repair';

export function useChapterRepair(contentId: string, invalidateKeys: QueryKey[]) {
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const { jobs, run, clear } = useEngineJobQueue(profile?.user_id, contentId);
  const [cancelling, setCancelling] = useState(false);
  const job = jobs[KEY];
  const state: RepairState = job?.state ?? 'idle';
  const jobId = job?.jobId ?? null;

  const authHeaders = async (): Promise<Record<string, string>> => {
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };

  // Whichever page started it, the repair rewrites this chapter: refresh the chapter page as well as
  // the caller's own queries.
  const keys = useCallback(
    (): QueryKey[] => [
      ...invalidateKeys,
      ['content-detail', contentId],
      ['content-versions', contentId],
      ['chapter-annotations', contentId],
    ],
    [invalidateKeys, contentId],
  );

  const queue = useCallback(async () => {
    await run(
      KEY,
      async () => {
        const r = await fetch(`/api/content/${contentId}/repair`, { method: 'POST', headers: await authHeaders() });
        const j = (await r.json()) as { jobId?: string };
        if (!r.ok || !j.jobId) throw new Error('repair failed to queue');
        return j.jobId;
      },
      keys(),
    );
  }, [run, contentId, keys]);

  // Cancel the in-flight repair: aborts the engine arq job, stops tracking it, refetches in case the
  // job had partially written before the abort landed. Idempotent — safe even if it just finished.
  const cancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      await fetch(`/api/jobs/engine/${jobId}/abort`, { method: 'POST', headers: await authHeaders() });
    } catch {
      // best-effort — the job is dropped from tracking either way
    } finally {
      clear(KEY);
      for (const qk of keys()) void queryClient.invalidateQueries({ queryKey: qk });
      setCancelling(false);
    }
  }, [jobId, clear, keys, queryClient]);

  return { state, jobId, queue, cancel, cancelling };
}
