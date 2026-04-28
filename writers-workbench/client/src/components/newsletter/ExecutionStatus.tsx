import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { EmptyState } from '../shared/Skeleton';
import { useNewsletterEvents } from '../../lib/newsletter/sse';
import type { NewsletterStageEventData } from '../../lib/newsletter/schema';

export default function ExecutionStatus() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<NewsletterStageEventData[]>([]);

  // Subscribe to newsletter.stage events scoped to this execution. The full
  // progress strip + log + approval CTAs land in S7; for now we just append
  // any matching event to a list so the SSE plumbing can be smoke-tested.
  useNewsletterEvents({
    executionId: id,
    onStage: (data) => {
      setEvents((prev) => [...prev, data]);
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Execution status</h1>
        <p className="mt-1 text-sm font-mono text-gray-500 dark:text-gray-400">{id}</p>
      </header>

      <EmptyState
        title="Execution status — stub"
        description="S7 builds the progress strip, polling fallback, and approval CTAs. The hook below is wired so SSE smoke tests can land already."
      />

      {events.length > 0 && (
        <section className="rounded border border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-700 dark:bg-gray-900">
          <h2 className="mb-2 text-sm font-medium">Stage events received ({events.length})</h2>
          <ul className="space-y-1 font-mono">
            {events.map((e, i) => (
              <li key={`${e.executionId}-${e.stage}-${i}`}>
                <span className="text-gray-400">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                <span className="text-brand-700 dark:text-brand-300">{e.stage}</span>{' '}
                <span className="text-gray-600 dark:text-gray-400">— {e.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
