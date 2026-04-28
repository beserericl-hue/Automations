import { EmptyState } from '../shared/Skeleton';

export default function NewsletterGenerate() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Generate newsletter</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Pick an edition, set the send date, optionally paste prior content to avoid duplicate coverage.
        </p>
      </header>

      <EmptyState
        title="Generate page — stub"
        description={
          'S6 fills this in: edition selector (driven by /api/newsletter/editions), send-date picker, ' +
          '"Previous Newsletter Content" textarea pre-filled from /editions/:id/last-sent-markdown, and a ' +
          'submit button that POSTs /api/newsletter/generate then routes to /newsletter/execution/:id.'
        }
      />
    </div>
  );
}
