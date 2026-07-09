import { useState } from 'react';
import { supabase } from '../../config/supabase';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';
import type { QAReport, QACheck } from '../../types/database';

interface QAReportPanelProps {
  metadata: Record<string, unknown>;
  contentId: string;
  contentTitle: string;
  chapterNumber: number | null;
  projectId: string | null;
  userId: string;
}

export default function QAReportPanel({ metadata, contentId, userId }: QAReportPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const report = metadata?.qa_report as QAReport | undefined;

  // Queue the Q/A op so the click returns immediately; the content refetches when the engine job
  // completes (and the panel shows the new report). The hook also handles a sync engine response.
  const jobQueue = useEngineJobQueue(userId);
  const qaState = jobQueue.stateOf('qa');
  const qaRunning = qaState === 'queued';
  const qaError = qaState === 'error';

  // Queue the Q/A as a background engine job (POST returns immediately with a job_id; the arq worker runs
  // it independent of this request/tab, so navigating away can't kill it). Poll + refetch via trackJob.
  async function runQACheck() {
    if (qaRunning) return;
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    try {
      const res = await fetch(`/api/content/${contentId}/run-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const body = (await res.json()) as { jobId?: string };
      if (body.jobId) jobQueue.trackJob('qa', body.jobId, [['content-detail', contentId]]);
    } catch {
      /* button re-enables on next render */
    }
  }

  // One-click "Rewrite to fix Q/A": queues a chapter rewrite that targets the flagged checks. The
  // chapter refetches when the engine job completes (trackJob polls /api/jobs/engine/:id).
  const fixState = jobQueue.stateOf('qa-fix');
  const fixRunning = fixState === 'queued';
  async function fixQA() {
    if (fixRunning) return;
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    try {
      const res = await fetch(`/api/content/${contentId}/rewrite-to-fix-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const body = (await res.json()) as { jobId?: string };
      if (body.jobId) jobQueue.trackJob('qa-fix', body.jobId, [['content-detail', contentId]]);
    } catch {
      /* button re-enables on next render */
    }
  }

  if (!report || !report.checks?.length) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            No consistency report available
          </div>
          <button
            onClick={() => void runQACheck()}
            disabled={qaRunning}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {qaRunning ? 'Running...' : qaError ? 'Retry Q/A Check' : 'Run Q/A Check'}
          </button>
        </div>
        {qaRunning && (
          <p className="mt-2 text-xs text-green-600 dark:text-green-400">
            Q/A check queued — results will appear here when it finishes.
          </p>
        )}
        {qaError && (
          <p className="mt-2 text-xs text-red-500">
            Failed to start Q/A check. Try again.
          </p>
        )}
      </div>
    );
  }

  const passCount = report.checks.filter((c) => c.status === 'PASS').length;
  const totalCount = report.checks.length;
  const allPass = passCount === totalCount;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
      >
        <div className="flex items-center gap-2">
          <QAStatusIcon allPass={allPass} />
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            Q/A Consistency Report
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            allPass
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
          }`}>
            {passCount}/{totalCount} passed
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!allPass && (
            <button
              onClick={(e) => { e.stopPropagation(); void fixQA(); }}
              disabled={fixRunning}
              title="Rewrite this chapter to address the flagged Q/A findings — queues in the background"
              className="rounded px-2 py-1 text-[10px] font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {fixRunning ? 'Rewriting…' : 'Rewrite to fix Q/A'}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); void runQACheck(); }}
            disabled={qaRunning}
            className="rounded px-2 py-1 text-[10px] font-medium border border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {qaRunning ? 'Running...' : 'Re-run'}
          </button>
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {qaRunning && (
        <div className="px-4 py-2 text-xs text-green-600 dark:text-green-400 border-t border-gray-200 dark:border-gray-700 bg-green-50 dark:bg-green-950/20">
          Q/A re-check queued — results will refresh when it finishes.
        </div>
      )}
      {fixRunning && (
        <div className="px-4 py-2 text-xs text-brand-700 dark:text-brand-300 border-t border-gray-200 dark:border-gray-700 bg-brand-50 dark:bg-brand-950/20">
          Rewrite-to-fix-Q/A queued — the chapter (and its Q/A report) refresh when it finishes (~2–4 min).
        </div>
      )}

      {/* Expanded checks list */}
      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {report.checks.map((check, i) => (
              <CheckRow key={i} check={check} />
            ))}
          </div>
          {report.generated_at && (
            <div className="px-4 py-2 text-xs text-gray-400 bg-gray-50 dark:bg-gray-800/30">
              Report generated: {new Date(report.generated_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: QACheck }) {
  const isPass = check.status === 'PASS';
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {isPass ? (
        <svg className="h-4 w-4 mt-0.5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-4 w-4 mt-0.5 text-yellow-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{check.name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{check.details}</p>
      </div>
    </div>
  );
}

function QAStatusIcon({ allPass }: { allPass: boolean }) {
  if (allPass) {
    return (
      <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}
