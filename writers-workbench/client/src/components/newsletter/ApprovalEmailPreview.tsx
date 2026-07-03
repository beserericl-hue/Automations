/**
 * ApprovalEmailPreview — rendered HTML email preview for a pending approval.
 *
 * Calls GET /api/newsletter/approvals/:token/preview, which renders the edition's
 * branded default template with the approval's selected stories laid in, and shows
 * the result in a sandboxed iframe. This is what the marketing demo (Scene 6) and
 * marketing-copy.md refer to as "ApprovalDetail with rendered HTML preview" — a
 * reviewer sees the actual email before approving.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

interface PreviewResponse {
  success: boolean;
  html: string;
  warnings?: string[];
}

export default function ApprovalEmailPreview({ token }: { token: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['newsletter-approval-preview', token],
    queryFn: () => apiFetch<PreviewResponse>(`/api/newsletter/approvals/${encodeURIComponent(token)}/preview`),
    enabled: !!token,
    staleTime: 30_000,
    retry: 1,
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Email preview</h3>
        <span className="text-xs text-gray-400">How this issue will look when sent</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-sm text-gray-400">Rendering preview…</div>
      ) : isError || !data?.html ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
          Preview unavailable
          {error instanceof Error ? <span className="ml-1 text-xs text-gray-400">({error.message})</span> : null}.
          {' '}Ensure this edition has an active default template in Newsletter → Templates.
        </div>
      ) : (
        <iframe
          title="Approval email preview"
          srcDoc={data.html}
          sandbox=""
          className="h-[720px] w-full rounded-b-lg bg-white"
        />
      )}
    </div>
  );
}
