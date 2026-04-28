import { EmptyState } from '../shared/Skeleton';

export default function PendingApprovals() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Pending approvals</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Stories and subject-line approvals waiting on a human decision.
        </p>
      </header>

      <EmptyState
        title="Pending approvals — stub"
        description={
          'S5 adds the in-app approvals API; S8 fills this list view. Until then, approvers continue to work ' +
          'from the email links the workflow already sends (/approvals/:token).'
        }
      />
    </div>
  );
}
