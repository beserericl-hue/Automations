/**
 * "Research a topic" — runs the engine's research report from the Research screens. It used to be
 * reachable only by asking the chat or Eve. The report is linked to the project when there is one,
 * and the list refreshes when the job finishes.
 */

import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';

interface Props {
  userId: string | undefined;
  projectId?: string;
  /** Queries to refetch when the report is saved. */
  invalidate: unknown[][];
}

export default function ResearchRunBox({ userId, projectId, invalidate }: Props) {
  const [topic, setTopic] = useState('');
  const jobQueue = useEngineJobQueue(userId, projectId ?? 'research');
  const key = 'research-run';
  const state = jobQueue.stateOf(key);
  const running = state === 'queued';

  const start = () => {
    const t = topic.trim();
    if (t.length < 3) return;
    void jobQueue.run(
      key,
      async () =>
        (
          await apiFetch<{ jobId?: string }>('/api/research/run', {
            method: 'POST',
            body: JSON.stringify({ topic: t, ...(projectId ? { project_id: projectId } : {}) }),
          })
        ).jobId,
      invalidate,
    );
    setTopic('');
  };

  return (
    <div data-testid="research-run" className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <input
        aria-label="Research topic"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
        placeholder="What should be researched? e.g. Piscataway burial practice before 1650"
        className="min-w-[16rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
      />
      <button
        onClick={start}
        disabled={running || topic.trim().length < 3}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {running ? 'Researching… (a few minutes)' : 'Research this'}
      </button>
      {state === 'error' ? (
        <span className="text-sm text-red-600">
          The research could not be started.{' '}
          <button className="underline" onClick={() => jobQueue.clear(key)}>Dismiss</button>
        </span>
      ) : null}
    </div>
  );
}
