import { useParams } from 'react-router-dom';
import { EmptyState } from '../shared/Skeleton';

export default function NewsletterDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Newsletter detail</h1>
        <p className="mt-1 text-sm font-mono text-gray-500 dark:text-gray-400">{id}</p>
      </header>

      <EmptyState
        title="Newsletter detail — Phase 2b"
        description="Phase 2b ships the per-issue view (full HTML preview, markdown source, edition + execution + approval lineage, send history)."
      />
    </div>
  );
}
