import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

// S12-13 — shared report-comment surface for chapter editors. Renders
// merged annotations from genre_eval (S12-11), drift_scan (S12-12) and the
// craft Q/A, pinned to spans in the current chapter, with apply/dismiss actions.
//
// craft_qa is here because every attempt to fix craft defects by regenerating prose damaged the
// book: whole-chapter revision came back at 48-80% of the original across six attempts, and
// section-wise revision with deletion forbidden inflated chapters to 123-144% and scored WORSE on
// the dimensions it targeted. Apply does a literal span replacement, so a chapter cannot shrink or
// balloon — the author sees both versions and decides. That is the whole point of routing craft
// findings through this surface instead of a repair loop.

type AnnotationSource = 'genre_eval' | 'drift_scan' | 'craft_qa';
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
    delta_chars?: number;
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
        No active review annotations for this chapter. Run the Q/A check from the Q/A tab, or a genre evaluation or character-drift scan from the chat, to populate.
      </div>
    );
  }

  // Group by source for stable ordering: drift_scan first (concrete fixes),
  // craft_qa second (the common case — pacing and prose, with a suggested replacement),
  // genre_eval last (craft suggestions).
  const driftAnnotations = active.filter((a) => a.source === 'drift_scan');
  const craftAnnotations = active.filter((a) => a.source === 'craft_qa');
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
          drift {data.counts.by_source.drift_scan} · craft {data.counts.by_source.craft_qa} · genre{' '}
          {data.counts.by_source.genre_eval}
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
        {craftAnnotations.length > 0 && (
          <SourceSection
            title="Craft Q/A"
            description="Pacing, flat paragraphs and prose clarity — each pinned to the passage it refers to. Apply swaps that passage only; undo from the Versions tab."
            annotations={craftAnnotations}
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
              {typeof annotation.suggestion.delta_chars === 'number' && annotation.suggestion.delta_chars !== 0 && (
                // Say what accepting costs. Every automated repair this engine tried failed by
                // silently removing prose — whole-chapter rewrites came back at 48-80% of the
                // original — so a suggestion that deletes most of a passage must say so before it
                // is accepted, not after.
                <span
                  className={`ml-2 whitespace-nowrap rounded px-1.5 py-0.5 font-medium ${
                    annotation.suggestion.delta_chars < -200
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  }`}
                  title="Change in length if you accept this suggestion"
                >
                  {annotation.suggestion.delta_chars > 0 ? '+' : '−'}
                  {Math.abs(annotation.suggestion.delta_chars).toLocaleString()} characters
                </span>
              )}
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
