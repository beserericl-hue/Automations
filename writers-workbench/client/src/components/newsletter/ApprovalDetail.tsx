import { useParams } from 'react-router-dom';
import { EmptyState } from '../shared/Skeleton';

export default function ApprovalDetail() {
  const { token } = useParams<{ token: string }>();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Approval detail</h1>
        <p className="mt-1 text-sm font-mono text-gray-500 dark:text-gray-400">{token}</p>
      </header>

      <EmptyState
        title="Approval detail — stub"
        description={
          'S8 lands the rich detail view (selected stories, reasoning, accept/revise form). For now the public ' +
          'email-driven form at /approvals/:token remains the live approval surface.'
        }
      />
    </div>
  );
}
