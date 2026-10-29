import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { aiTells, summarizeTells } from '../../lib/aiTells';

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
//
// A suggestion can also be EDITED before it is applied. The server has always accepted a
// `replacementText` of the caller's choosing; nothing in the UI ever offered it, so the only two
// answers available were "take the model's wording" and "do nothing". The third answer — the
// author's own words, in the exact span the finding pins — is the one that actually fixes prose.

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
  /** The passage it was about has been rewritten since the report — answered, nothing to apply. */
  resolved?: boolean;
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

/** What the editor pane can be asked to do with a quoted passage. */
export type RevealResult = 'exact' | 'approximate' | 'missing';

interface AnnotationsPanelProps {
  contentId: string;
  /**
   * Scroll the manuscript to a quoted passage and mark it. Optional, because the panel is also
   * rendered in places with no editor beside it — without one, the rows are simply not clickable
   * rather than clickable and inert.
   */
  onReveal?: (quote: string) => RevealResult;
  /** Send a suggested replacement to the Humanizer tab, to replace the passage it would fix. */
  onHumanize?: (text: string, passage: string) => void;
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

export default function AnnotationsPanel({ contentId, onReveal, onHumanize }: AnnotationsPanelProps) {
  const queryClient = useQueryClient();
  // Which finding the manuscript is currently showing, and how well its quote matched.
  const [shown, setShown] = useState<{ id: string; result: RevealResult } | null>(null);

  const reveal = (a: UnifiedAnnotation): void => {
    if (!onReveal) return;
    const quote = a.evidence_quote || a.suggestion?.target_text || '';
    if (!quote.trim()) {
      setShown({ id: a.id, result: 'missing' });
      return;
    }
    setShown({ id: a.id, result: onReveal(quote) });
  };
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

  const active = data.annotations.filter((a) => !a.dismissed && !a.resolved);
  const fixed = data.annotations.filter((a) => !a.dismissed && a.resolved);
  if (active.length === 0) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700">
          {fixed.length
            ? 'Every finding in this chapter’s report has been dealt with.'
            : 'No active review annotations for this chapter. Run the Q/A check from the Q/A tab, or a genre evaluation or character-drift scan from the chat, to populate.'}
        </div>
        <FixedList fixed={fixed} />
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
            onApply={(a, replacementText) =>
              apply.mutate({ contentId, annotationId: a.id, source: a.source, replacementText })
            }
            onDismiss={(a) => dismiss.mutate({ contentId, annotationId: a.id, source: a.source })}
            applyState={apply}
            dismissState={dismiss}
            onReveal={onReveal ? reveal : undefined}
            onHumanize={onHumanize}
            shown={shown}
          />
        )}
        {craftAnnotations.length > 0 && (
          <SourceSection
            title="Craft Q/A"
            description="Pacing, flat paragraphs and prose clarity — each pinned to the passage it refers to. Apply swaps that passage only; undo from the Versions tab."
            annotations={craftAnnotations}
            onApply={(a, replacementText) =>
              apply.mutate({ contentId, annotationId: a.id, source: a.source, replacementText })
            }
            onDismiss={(a) => dismiss.mutate({ contentId, annotationId: a.id, source: a.source })}
            applyState={apply}
            dismissState={dismiss}
            onReveal={onReveal ? reveal : undefined}
            onHumanize={onHumanize}
            shown={shown}
          />
        )}
        {genreAnnotations.length > 0 && (
          <SourceSection
            title="Genre compliance"
            description="Per-rule scores, evidence quotes, and rewrite suggestions."
            annotations={genreAnnotations}
            onApply={(a, replacementText) =>
              apply.mutate({ contentId, annotationId: a.id, source: a.source, replacementText })
            }
            onDismiss={(a) => dismiss.mutate({ contentId, annotationId: a.id, source: a.source })}
            applyState={apply}
            dismissState={dismiss}
            onReveal={onReveal ? reveal : undefined}
            onHumanize={onHumanize}
            shown={shown}
          />
        )}
      </div>
      <FixedList fixed={fixed} />
    </div>
  );
}

/**
 * Findings whose passage has been rewritten since the report — by Apply, the Humanizer or by hand.
 * They are answered, so they leave the active list and lose their Apply Fix (the passage it would
 * replace is gone). Kept here, folded, so the author can see the report was dealt with rather than
 * watching findings silently vanish.
 */
function FixedList({ fixed }: { fixed: UnifiedAnnotation[] }) {
  if (!fixed.length) return null;
  return (
    <details data-testid="fixed-annotations" className="border-t border-gray-100 px-4 py-2 text-xs dark:border-gray-800">
      <summary className="cursor-pointer text-green-700 dark:text-green-400">
        ✓ {fixed.length} fixed since the report
      </summary>
      <ul className="mt-2 space-y-1.5">
        {fixed.map((a) => (
          <li key={a.id} className="text-gray-500 dark:text-gray-400">
            <span className="mr-1.5 rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              Fixed
            </span>
            {a.message}
          </li>
        ))}
      </ul>
    </details>
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
  onReveal,
  onHumanize,
  shown,
}: {
  title: string;
  description: string;
  annotations: UnifiedAnnotation[];
  onApply: (a: UnifiedAnnotation, replacementText?: string) => void;
  onDismiss: (a: UnifiedAnnotation) => void;
  applyState: { isPending: boolean; isError: boolean; error: unknown; variables?: { annotationId?: string } };
  dismissState: { isPending: boolean; variables?: { annotationId?: string } };
  onReveal?: (a: UnifiedAnnotation) => void;
  onHumanize?: (text: string, passage: string) => void;
  shown: { id: string; result: RevealResult } | null;
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
            onApply={(replacementText) => onApply(a, replacementText)}
            onDismiss={() => onDismiss(a)}
            applyPending={applyState.isPending && applyState.variables?.annotationId === a.id}
            applyError={applyState.isError && applyState.variables?.annotationId === a.id ? (applyState.error as Error)?.message : undefined}
            dismissPending={dismissState.isPending && dismissState.variables?.annotationId === a.id}
            onReveal={onReveal ? () => onReveal(a) : undefined}
            onHumanize={onHumanize}
            revealed={shown?.id === a.id ? shown.result : null}
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
  onReveal,
  onHumanize,
  revealed,
}: {
  annotation: UnifiedAnnotation;
  onApply: (replacementText?: string) => void;
  onDismiss: () => void;
  applyPending: boolean;
  applyError?: string;
  dismissPending: boolean;
  onReveal?: () => void;
  onHumanize?: (text: string, passage: string) => void;
  revealed: RevealResult | null;
}) {
  const canApply = annotation.suggestion?.action === 'replace' && !!annotation.suggestion.target_text;
  // null = not editing. The draft starts from the model's wording when there is one, otherwise from
  // the passage itself, because rewriting a sentence is easier than typing it out again first.
  const [draft, setDraft] = useState<string | null>(null);
  const target = annotation.suggestion?.target_text ?? '';
  const suggested = annotation.suggestion?.replacement_text ?? '';
  const delta = draft !== null ? draft.length - target.length : 0;

  const quote = annotation.evidence_quote || target;
  const canReveal = Boolean(onReveal && quote.trim());

  return (
    <li
      className={`px-4 py-3 transition-colors ${
        revealed ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <SeverityBadge severity={annotation.severity} />
            {annotation.chapter_number != null && (
              <span className="text-gray-400">ch {annotation.chapter_number}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">{annotation.message}</p>
          {/* The quote IS the link. A suggested sentence cannot be judged on its own — the question
              is whether it still joins up with the sentences on either side — and those are in the
              editor pane, not here. Clicking takes you to them. */}
          {annotation.evidence_quote && (
            <blockquote
              onClick={canReveal ? onReveal : undefined}
              onKeyDown={
                canReveal
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onReveal?.();
                      }
                    }
                  : undefined
              }
              role={canReveal ? 'button' : undefined}
              tabIndex={canReveal ? 0 : undefined}
              title={canReveal ? 'Show this passage in the manuscript' : undefined}
              className={`mt-2 border-l-2 pl-3 text-xs italic text-gray-600 dark:text-gray-400 ${
                canReveal
                  ? 'cursor-pointer rounded-r border-brand-400 hover:bg-brand-50/60 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-brand-600 dark:hover:bg-brand-950/30'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
            >
              {annotation.evidence_quote}
            </blockquote>
          )}
          {canReveal && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <button
                onClick={onReveal}
                className="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {revealed ? 'Show again' : 'Show in manuscript'}
              </button>
              {/* The three outcomes are said plainly. "Approximate" is the one that matters: the
                  chapter has been edited since the report was written, so the suggestion may be
                  answering a sentence that no longer exists. */}
              {revealed === 'approximate' && (
                <span className="text-amber-700 dark:text-amber-400">
                  only the opening matched — this passage has changed since the report was written
                </span>
              )}
              {revealed === 'missing' && (
                <span className="text-red-600 dark:text-red-400">
                  not found in the current text — re-run the Q/A check for this chapter
                </span>
              )}
            </div>
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
              {/* Every suggestion is written by a model; say so, and say what gives it away. */}
              <AiWrittenFlag
                text={annotation.suggestion.replacement_text}
                onHumanize={onHumanize && target ? () => onHumanize(annotation.suggestion!.replacement_text!, target) : undefined}
              />
            </div>
          )}
          {/* Edit the fix before taking it. What replaces the passage is whatever is in this box —
              the model's wording, the author's, or the model's with one word changed. */}
          {canApply && draft !== null && (
            <div className="mt-2 space-y-1.5 rounded border border-brand-200 bg-brand-50/40 p-2 dark:border-brand-800 dark:bg-brand-950/20">
              <p className="text-[11px] font-medium text-brand-700 dark:text-brand-300">
                This text will replace the quoted passage exactly.
              </p>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(10, Math.max(2, Math.ceil(draft.length / 70)))}
                className="block w-full rounded border border-gray-300 px-2 py-1 text-xs shadow-sm focus:border-brand-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => onApply(draft)}
                  disabled={applyPending || !draft.trim()}
                  className="rounded bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {applyPending ? 'Applying…' : 'Apply my version'}
                </button>
                <button
                  onClick={() => setDraft(null)}
                  className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 dark:border-gray-600 dark:text-gray-400"
                >
                  Cancel
                </button>
                {suggested && draft !== suggested && (
                  <button
                    onClick={() => setDraft(suggested)}
                    className="text-[11px] text-gray-500 underline hover:text-gray-700 dark:text-gray-400"
                  >
                    reset to suggestion
                  </button>
                )}
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  {delta === 0 ? 'same length' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} characters`}
                </span>
              </div>
            </div>
          )}
          {applyError && (
            <p className="mt-1 text-xs text-red-500">{applyError}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          {canApply && draft === null && (
            <>
              <button
                onClick={() => onApply()}
                disabled={applyPending}
                className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {applyPending ? 'Applying…' : 'Apply Fix'}
              </button>
              <button
                onClick={() => {
                  setDraft(suggested || target);
                  // Reveal on the way in. Rewriting a sentence is the moment you most need to see
                  // the two it sits between, so opening the box without scrolling there would make
                  // the author do the lookup by hand anyway.
                  onReveal?.();
                }}
                className="rounded-lg border border-brand-300 px-3 py-1 text-xs text-brand-700 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
              >
                Edit first
              </button>
            </>
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

function AiWrittenFlag({ text, onHumanize }: { text: string; onHumanize?: () => void }) {
  const tells = aiTells(text);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-gray-700 dark:text-gray-300" data-testid="ai-written-flag">
      <span className="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
        AI-written
      </span>
      {tells.length ? (
        <span className="text-amber-800 dark:text-amber-300" title={tells.flatMap((t) => t.examples).join('\n')}>
          reads as machine-written: {summarizeTells(tells)}
        </span>
      ) : (
        <span className="text-gray-500 dark:text-gray-400">no common tells found</span>
      )}
      {onHumanize ? (
        <button
          onClick={onHumanize}
          className="rounded border border-violet-300 px-2 py-0.5 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30"
        >
          Open in Humanizer
        </button>
      ) : null}
    </div>
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
