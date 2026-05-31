/**
 * ApprovalDetail (S8) — single approval view + resolve form.
 *
 * Reads `GET /api/newsletter/approvals/open?token=:token`. The same
 * endpoint already enforces session-user ownership, so a wrong token
 * (or someone else's) shows the empty state — same behavior as a
 * resolved/expired row.
 *
 * Renders the same payload + resolve-form components as the
 * ExecutionStatus page so the in-app flow stays consistent.
 */
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import ApprovalPayloadStories from './ApprovalPayloadStories';
import ApprovalPayloadSubject from './ApprovalPayloadSubject';
import ApprovalResolveForm from './ApprovalResolveForm';
import StatusPill from './StatusPill';
import type { NewsletterApprovalStage } from '../../types/database';

interface OpenApproval {
  id: string;
  token: string;
  execution_id: string;
  stage: NewsletterApprovalStage;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

interface ApprovalsOpenResponse {
  success: boolean;
  approvals: OpenApproval[];
}

export default function ApprovalDetail() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['newsletter-approval-by-token', token],
    queryFn: () =>
      apiFetch<ApprovalsOpenResponse>(
        `/api/newsletter/approvals/open?token=${encodeURIComponent(token!)}`,
      ),
    enabled: !!token,
    staleTime: 0,
  });

  const approval = query.data?.approvals?.[0] ?? null;

  function handleResolved() {
    void queryClient.invalidateQueries({ queryKey: ['newsletter-approvals-open'] });
    void queryClient.invalidateQueries({ queryKey: ['newsletter-approval-by-token', token] });
    // Navigate back to the inbox after a brief moment so the user sees
    // the form go disabled — useful feedback that the click registered.
    navigate('/newsletter/approvals');
  }

  return (
    <div className="space-y-6">
      <header>
        <Link to="/newsletter/approvals" className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">
          ← Pending approvals
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
          {approval
            ? approval.stage === 'subject_line'
              ? 'Subject line approval'
              : approval.stage === 'image'
              ? 'Cover image approval'
              : 'Stories approval'
            : 'Approval'}
        </h1>
        {token && (
          <p className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
            token {token.slice(0, 16)}…
          </p>
        )}
      </header>

      {query.isLoading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900">
          Loading…
        </div>
      ) : !approval ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <p>This approval is no longer pending.</p>
          <p className="mt-1 text-xs">It may have been resolved already, expired, or it doesn&apos;t belong to you.</p>
          <Link to="/newsletter/approvals" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300">
            ← Back to pending approvals
          </Link>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-700 dark:bg-amber-950/30">
          <div className="flex items-center gap-2">
            <StatusPill status={approval.stage === 'stories' ? 'awaiting_stories_approval' : 'awaiting_subject_approval'} />
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              execution {approval.execution_id}
            </span>
          </div>
          {approval.stage === 'stories' ? (
            <ApprovalPayloadStories payload={approval.payload} />
          ) : (
            <ApprovalPayloadSubject payload={approval.payload} />
          )}
          <ApprovalResolveForm token={approval.token} onResolved={handleResolved} />
        </div>
      )}
    </div>
  );
}
