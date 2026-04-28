import { Link } from 'react-router-dom';
import { EmptyState } from '../shared/Skeleton';

export default function NewsletterHome() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Newsletter</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Compose, approve, schedule, and review the weekly newsletter for each enabled edition.
        </p>
      </header>

      <EmptyState
        title="Newsletter home — stub"
        description="Editions overview, recent activity, and shortcuts to Generate / Approvals / Sends will land in S6. See compose-newsletter-sprint.md."
        action={{
          label: 'Generate newsletter →',
          onClick: () => {
            window.location.href = '/newsletter/generate';
          },
        }}
      />

      <nav className="flex flex-wrap gap-2 text-sm">
        <Link to="/newsletter/generate" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Generate</Link>
        <Link to="/newsletter/approvals" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Pending approvals</Link>
        <Link to="/newsletter/sends" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Scheduled sends</Link>
        <Link to="/newsletter/ingestion" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">Ingestion browser</Link>
      </nav>
    </div>
  );
}
