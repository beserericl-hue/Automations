/**
 * "Revise outline" — the project-level counterpart of the per-chapter Re-outline button.
 *
 * The author types a directive ("interleave a second timeline in 1650", "add a POV chapter for the
 * archivist after every third chapter") and the engine's brainstorm.revise-outline op rewrites the
 * WHOLE outline to apply it. Before this box the op was reachable only by asking the chat or Eve.
 *
 * WHY IT POLLS ITS OWN JOB. The shared engine-job queue only knows "queued" and "error"; a revision
 * can take several minutes and can finish "complete" with nothing revised (the op reports that in its
 * result, not as a failure). So this box reads the job's status and its result itself: it shows the
 * queue → running → done progress with the elapsed time, and says what the engine said when it did
 * not revise. The running job is kept in the browser session so leaving the tab and coming back
 * picks it up again.
 *
 * NO CANCEL. arq's abort stops the worker's await, but the brainstorm step runs in its own process
 * and would still finish and save the outline — a Cancel button here would say "nothing changed"
 * when something might have.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';

type Phase = 'idle' | 'starting' | 'queued' | 'in_progress' | 'done' | 'error';

interface Saved {
  jobId: string;
  startedAt: number;
  chaptersBefore: number;
}

interface RevisionResult {
  revised?: boolean;
  error?: string;
  chapters_before?: number;
  chapters_after?: number;
  characters_after?: number;
  persist?: { persisted?: boolean; error?: string; reason?: string } | null;
}

interface JobStatus {
  status?: string;
  error?: string;
  result?: {
    status?: string;
    error?: string | { message?: string; code?: string } | null;
    payload?: { result?: RevisionResult };
  };
}

const POLL_MS = 5_000;
/** A revision is one 64k-token call; past this the job is treated as lost rather than polled forever. */
const MAX_AGE_MS = 60 * 60 * 1000;

function storageKey(projectId: string): string {
  return `ww.outlineRevise.${projectId}`;
}

function loadSaved(projectId: string): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(projectId));
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    if (saved && Date.now() - saved.startedAt < MAX_AGE_MS) return saved;
  } catch {
    // storage refused (private window) — the box still works for this page view
  }
  return null;
}

function save(projectId: string, saved: Saved | null): void {
  try {
    if (saved) window.sessionStorage.setItem(storageKey(projectId), JSON.stringify(saved));
    else window.sessionStorage.removeItem(storageKey(projectId));
  } catch {
    // ignore
  }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function errorText(e: string | { message?: string; code?: string } | null | undefined): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return e.message || e.code || 'engine error';
}

export default function OutlineReviseBox({ projectId, chapterCount }: { projectId: string; chapterCount: number }) {
  const qc = useQueryClient();
  const { refreshSubscription } = useUser();
  const [directive, setDirective] = useState('');
  const [phase, setPhase] = useState<Phase>(() => (loadSaved(projectId) ? 'queued' : 'idle'));
  const [job, setJob] = useState<Saved | null>(() => loadSaved(projectId));
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const busy = phase === 'starting' || phase === 'queued' || phase === 'in_progress';
  const jobRef = useRef(job);
  jobRef.current = job;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['project-detail', projectId] });
    void qc.invalidateQueries({ queryKey: ['outline-versions-info', projectId] });
    void qc.invalidateQueries({ queryKey: ['project-bible', projectId] });
  }, [qc, projectId]);

  const finish = useCallback(
    (next: Phase, text: string) => {
      save(projectId, null);
      setJob(null);
      setPhase(next);
      setMessage(text);
    },
    [projectId],
  );

  // Poll the running job.
  useEffect(() => {
    if (!job) return;
    let stopped = false;
    const tick = async () => {
      setNow(Date.now());
      try {
        const s = await apiFetch<JobStatus>(`/api/jobs/engine/${job.jobId}/status`);
        if (stopped || jobRef.current?.jobId !== job.jobId) return;
        if (s.status === 'queued' || s.status === 'deferred') setPhase('queued');
        else if (s.status === 'in_progress') setPhase('in_progress');
        else if (s.status === 'complete') {
          const envelopeError = errorText(s.result?.error);
          const r = s.result?.payload?.result;
          if (envelopeError) finish('error', `The engine could not revise the outline: ${envelopeError}`);
          else if (r?.revised && r.persist?.persisted !== false) {
            refresh();
            const before = r.chapters_before ?? job.chaptersBefore;
            finish('done', `Outline revised: ${before} → ${r.chapters_after ?? '?'} chapters. The previous outline was saved as a prior version.`);
          } else if (r?.revised) {
            finish('error', `The outline was revised but could not be saved: ${r.persist?.error || r.persist?.reason || 'unknown error'}`);
          } else {
            finish('error', `The engine did not revise the outline${r?.error ? `: ${r.error}` : '.'}`);
          }
        } else if (s.status === 'error') {
          finish('error', `The revision failed: ${s.error || 'engine error'}`);
        } else if (s.status === 'not_found') {
          finish('error', 'The revision job was lost (the engine no longer knows it). Nothing was changed; try again.');
        }
      } catch {
        // transient poll failure — try again on the next tick
      }
    };
    void tick();
    const poll = setInterval(() => void tick(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [job, finish, refresh]);

  const start = async () => {
    const d = directive.trim();
    if (d.length < 3 || busy) return;
    setPhase('starting');
    setMessage('');
    try {
      const res = await apiFetch<{ jobId?: string }>(`/api/projects/${projectId}/outline/revise`, {
        method: 'POST',
        body: JSON.stringify({ directive: d }),
      });
      if (!res.jobId) {
        setPhase('error');
        setMessage('The engine did not return a job for this revision.');
        return;
      }
      const saved = { jobId: res.jobId, startedAt: Date.now(), chaptersBefore: chapterCount };
      save(projectId, saved);
      setJob(saved);
      setPhase('queued');
      setDirective('');
      // The revision is charged when it is queued.
      void refreshSubscription();
    } catch (err) {
      setPhase('error');
      if (err instanceof ApiError && err.status === 402) setMessage(`Not enough credits: ${err.message}`);
      else setMessage(err instanceof Error ? err.message : 'The revision could not be started.');
    }
  };

  return (
    <div
      data-testid="outline-revise"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Revise the whole outline</h3>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        Describe the change and the engine rewrites every chapter of the outline to apply it — add or reorder chapters,
        add characters or a second storyline. Existing characters and the title are kept. Your current outline is saved as a
        prior version first. Takes a few minutes.
      </p>
      <textarea
        data-testid="outline-revise-input"
        aria-label="Outline revision instructions"
        value={directive}
        onChange={(e) => setDirective(e.target.value)}
        disabled={busy}
        rows={3}
        maxLength={4000}
        placeholder="e.g. Interleave a second timeline set in 1650, told by the woman who carved the effigy, every third chapter."
        className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white disabled:opacity-60"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          data-testid="outline-revise-submit"
          onClick={() => void start()}
          disabled={busy || directive.trim().length < 3}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {phase === 'starting' ? 'Starting…' : busy ? 'Revising…' : 'Revise outline'}
        </button>
        {job && (phase === 'queued' || phase === 'in_progress') && (
          <span data-testid="outline-revise-progress" className="text-xs text-gray-600 dark:text-gray-300">
            {phase === 'queued' ? 'Queued — waiting for a writer slot' : 'Revising the outline'} · {elapsed(now - job.startedAt)}
          </span>
        )}
      </div>
      {message && (phase === 'done' || phase === 'error') && (
        <div
          data-testid={phase === 'error' ? 'outline-revise-error' : 'outline-revise-result'}
          role={phase === 'error' ? 'alert' : 'status'}
          className={`mt-2 flex items-start justify-between gap-2 rounded px-3 py-2 text-xs ${
            phase === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
              : 'bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300'
          }`}
        >
          <span>{message}</span>
          <button
            data-testid="outline-revise-dismiss"
            onClick={() => {
              setMessage('');
              setPhase('idle');
            }}
            className="shrink-0 underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
