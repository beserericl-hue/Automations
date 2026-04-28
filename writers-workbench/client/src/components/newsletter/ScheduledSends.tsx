import { EmptyState } from '../shared/Skeleton';

export default function ScheduledSends() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Scheduled sends</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Newsletters parked for the calendar cron at <code>scheduled_send_at</code>, plus already-sent issues.
        </p>
      </header>

      <EmptyState
        title="Scheduled sends — Phase 2b"
        description="Phase 2b ships the list view (newsletter_sends_v2 grouped by status: scheduled / sent / failed) and per-row actions (cancel, resend). Stub remains until then."
      />
    </div>
  );
}
