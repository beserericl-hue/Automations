import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

// S12-13 — shared report-comment surface for chapter editors. Renders
// merged annotations from genre_eval (S12-11) and drift_scan (S12-12)
// pinned to spans in the current chapter, with apply/dismiss actions.

type AnnotationSource = 'genre_eval' | 'drift_scan';
type Severity = 'high' | 'medium' | 'low' | 'info';

interface UnifiedAnnotation {
  id: string;
  source: AnnotationSource;
  severity: Severity;
  message: string;
  evidence_quote: string | null;
  evidence_context: string | null;
  chapter_number: number | null;
  suggestion?: {
    action: 'replace' | 'note';
    target_text?: string;
    replacement_text?: string;
  };
  dismissed: boolean;
}

interface AnnotationsResponse {
  success: boolean;
  annotations: UnifiedAnnotation[];
  counts: {
    total: number;
    active: number;
    by_source: Record<AnnotationSource, number>;
  };
}

interface AnnotationsPanelProps {
  contentId: string;
}

// Sprint 8: routes through apiFetch so the X-Impersonate-User header is
// auto-attached during impersonation. The server-side annotation routes
// already use req.userId (which is swapped by requireAuth), so honoring
// the header is the only missing piece on the client.
async function fetchAnnotations(contentId: string): Promise<AnnotationsResponse> {
  return apiFetch<AnnotationsResponse>(`/api/content/${contentId}/annotations`);
}

async function applyAnnotation(args: {
  contentId: string;
  annotationId: string;
  source: AnnotationSource;
  replacementText?: string;
}): Promise<void> {
  await apiFetch(`/api/content/${args.contentId}/annotations/apply`, {
    method: 'POST',
    body: JSON.stringify({
      annotationId: args.annotationId,
      source: args.source,
      ...(args.replacementText ? { replacementText: args.replacementText } : {}),
    }),
  });
}

async function dismissAnnotation(args: {
  contentId: string;
  annotationId: string;
  source: AnnotationSource;
}): Promise<void> {
  await apiFetch(`/api/content/${args.contentId}/annotations/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ annotationId: args.annotationId, source: args.source }),
  });
}

export default function AnnotationsPanel({ contentId }: AnnotationsPanelProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['chapter-annotations', contentId],
    queryFn: () => fetchAnnotations(contentId),
  });

  const apply = useMutation({
    mutationFn: applyAnnotation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chapter-annotations', contentId] });
      queryClient.invalidateQueries({ queryKey: ['content-detail', contentId] });
    },
  });

  const dismiss = useMutation({
    mutationFn: dismissAnnotation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chapter-annotations', contentId] });
    },
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700">
        Loading review annotations…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const active = data.annotations.filter((a) => !a.dismissed);
  if (active.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700">
        No active review annotations for this chapter. Run a genre evaluation or character-drift scan from the chat to populate.
      </div>
    );
  }

  // Group by source for stable ordering: drift_scan first (concrete fixes),
  // genre_eval second (craft suggestions).
  const driftAnnotations = active.filter((a) => a.source === 'drift_scan');
  const genreAnnotations = active.filter((a) => a.source === 'genre_eval');

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between bg-gray-50 px-4 py-2 dark:bg-gray-800/50">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
          <span className="text-sm font-medium text-gray-900 dark:text-white">Review Annotations</span>
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900 dark:text-brand-300">
            {active.length} active
          </span>
        </div>
        <span className="text-xs text-gray-500">
          drift {data.counts.by_source.drift_scan} · genre {data.counts.by_source.genre_eval}
        </span>
      </div>

      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {driftAnnotations.length > 0 && (
          <SourceSection
            title="Character drift"
            description="Names that don't match the canonical roster."
            annotations={driftAnnotations}
            onApply={(a) => apply.mutate({ contentId, annotationId: a.id, source: a.source })}
            onDismiss={(a) => dismiss.mutate({ contentId, annotationId: a.id, source: a.source })}
            applyState={apply}
            dismissState={dismiss}
          />
        )}
        {genreAnnotations.length > 0 && (
          <SourceSection
            title="Genre compliance"
            description="Per-rule scores, evidence quotes, and rewrite suggestions."
            annotations={genreAnnotations}
            onApply={(a) => apply.mutate({ contentId, annotationId: a.id, source: a.source })}
            onDismiss={(a) => dismiss.mutate({ contentId, annotationId: a.id, source: a.source })}
            applyState={apply}
            dismissState={dismiss}
          />
        )}
      </div>
    </div>
  );
}

function SourceSection({
  title,
  description,
  annotations,
  onApply,
  onDismiss,
  applyState,
  dismissState,
}: {
  title: string;
  description: string;
  annotations: UnifiedAnnotation[];
  onApply: (a: UnifiedAnnotation) => void;
  onDismiss: (a: UnifiedAnnotation) => void;
  applyState: { isPending: boolean; isError: boolean; error: unknown; variables?: { annotationId?: string } };
  dismissState: { isPending: boolean; variables?: { annotationId?: string } };
}) {
  return (
    <div>
      <div className="px-4 py-2 bg-gray-50/50 dark:bg-gray-800/20">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</h4>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {annotations.map((a) => (
          <AnnotationRow
            key={a.id}
            annotation={a}
            onApply={() => onApply(a)}
            onDismiss={() => onDismiss(a)}
            applyPending={applyState.isPending && applyState.variables?.annotationId === a.id}
            applyError={applyState.isError && applyState.variables?.annotationId === a.id ? (applyState.error as Error)?.message : undefined}
            dismissPending={dismissState.isPending && dismissState.variables?.annotationId === a.id}
          />
        ))}
      </ul>
    </div>
  );
}

function AnnotationRow({
  annotation,
  onApply,
  onDismiss,
  applyPending,
  applyError,
  dismissPending,
}: {
  annotation: UnifiedAnnotation;
  onApply: () => void;
  onDismiss: () => void;
  applyPending: boolean;
  applyError?: string;
  dismissPending: boolean;
}) {
  const canApply = annotation.suggestion?.action === 'replace' && !!annotation.suggestion.target_text;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <SeverityBadge severity={annotation.severity} />
            {annotation.chapter_number != null && (
              <span className="text-gray-400">ch {annotation.chapter_number}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">{annotation.message}</p>
          {annotation.evidence_quote && (
            <blockquote className="mt-2 border-l-2 border-gray-300 pl-3 text-xs italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
              {annotation.evidence_quote}
            </blockquote>
          )}
          {annotation.suggestion?.action === 'replace' && annotation.suggestion.replacement_text && (
            <div className="mt-2 rounded bg-green-50 px-2 py-1 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-300">
              Suggested replacement: <span className="font-mono">{annotation.suggestion.replacement_text}</span>
            </div>
          )}
          {applyError && (
            <p className="mt-1 text-xs text-red-500">{applyError}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          {canApply && (
            <button
              onClick={onApply}
              disabled={applyPending}
              className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {applyPending ? 'Applying…' : 'Apply Fix'}
            </button>
          )}
          <button
            onClick={onDismiss}
            disabled={dismissPending}
            className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {dismissPending ? '…' : 'Dismiss'}
          </button>
        </div>
      </div>
    </li>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const map: Record<Severity, string> = {
    high: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
    low: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    info: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[severity]}`}>
      {severity}
    </span>
  );
}
