/**
 * ExecutionStatus — the marquee page for Compose Newsletter 2a (S7).
 *
 * Layout:
 *   - PageHeader: "{edition.display_name} · {send_date}" + "Open in n8n →" link
 *   - <StageStrip /> full-width
 *   - Two-column body:
 *       left  → <LiveLog /> of all newsletter.stage events for this execution
 *       right → awaiting-approval panel: ApprovalPayload* + ApprovalResolveForm
 *   - <details> "Raw events" at the bottom for debugging
 *
 * Refresh-durability strategy:
 *   On mount we fetch:
 *     1. /api/newsletter/execution/:id/status   — last n8n state for the strip
 *     2. /api/newsletter/approvals/open?execution_id=:id
 *        — surface any pending approval if the user reloaded mid-run
 *
 * Live updates flow through useNewsletterEvents (SSE → window CustomEvents),
 * filtered by executionId. Approval events arrive on different channels:
 *   newsletter.approval.created  → fetch /approvals/open to populate the panel
 *   newsletter.approval.resolved → clear the panel optimistically (the
 *                                  workflow will follow up with stages_approved)
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { useNewsletterEvents } from '../../lib/newsletter/sse';
import StageStrip from './StageStrip';
import LiveLog from './LiveLog';
import ApprovalPayloadStories from './ApprovalPayloadStories';
import ApprovalPayloadSubject from './ApprovalPayloadSubject';
import ApprovalResolveForm from './ApprovalResolveForm';
import type {
  NewsletterStage,
  NewsletterStageEventData,
  NewsletterApprovalCreatedEventData,
  NewsletterApprovalResolvedEventData,
} from '../../lib/newsletter/schema';
import type { NewsletterEdition, NewsletterApprovalStage } from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface ExecutionStatusResponse {
  success: boolean;
  executionId: string;
  status: string;
  mode: string;
  startedAt: string | null;
  stoppedAt: string | null;
  lastNodeExecuted: string | null;
}
interface OpenApproval {
  id: string;
  token: string;
  execution_id: string;
  stage: NewsletterApprovalStage;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}
interface ApprovalsOpenResponse { success: boolean; approvals: OpenApproval[] }

// Best-effort mapping from n8n's lastNodeExecuted to a stage so the
// strip lights up before any SSE event arrives. Keeps in sync with the
// 9 emit_stage_* nodes added in S3.
function stageFromLastNode(lastNode: string | null): NewsletterStage | null {
  if (!lastNode) return null;
  const map: Record<string, NewsletterStage> = {
    search_markdown_objects: 'gathering',
    pick_top_stories: 'selecting_stories',
    create_approval_stories: 'awaiting_stories_approval',
    check_stories_feedback: 'stories_approved',
    create_approval_subject_line: 'awaiting_subject_approval',
    check_subject_line_feedback: 'subject_approved',
    iterate_stories: 'writing_segment',
    set_combined_sections_content: 'segments_done',
    save_scheduled_newsletter: 'saved',
    final_notification: 'saved',
  };
  return map[lastNode] ?? null;
}

export default function ExecutionStatus() {
  const { id } = useParams<{ id: string }>();
  const executionId = id ?? '';
  const queryClient = useQueryClient();

  const [events, setEvents] = useState<NewsletterStageEventData[]>([]);
  const [errorEvent, setErrorEvent] = useState<NewsletterStageEventData | null>(null);
  const [optimisticStage, setOptimisticStage] = useState<NewsletterStage | null>(null);

  // Mount-time hydration so a refresh mid-run still shows the right state.
  const statusQuery = useQuery({
    queryKey: ['execution-status', executionId],
    queryFn: () =>
      apiFetch<ExecutionStatusResponse>(`/api/newsletter/execution/${encodeURIComponent(executionId)}/status`),
    enabled: !!executionId,
    staleTime: 30_000,
    retry: false,
  });

  const approvalsQuery = useQuery({
    queryKey: ['approvals-open', executionId],
    queryFn: () =>
      apiFetch<ApprovalsOpenResponse>(
        `/api/newsletter/approvals/open?execution_id=${encodeURIComponent(executionId)}`,
      ),
    enabled: !!executionId,
    staleTime: 15_000,
  });

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });

  // Subscribe to live events.
  useNewsletterEvents({
    executionId,
    onStage: (data: NewsletterStageEventData) => {
      setEvents((prev) => [...prev, data]);
      if (data.stage === 'error') {
        setErrorEvent(data);
      }
      // Clear optimistic stage once a real event lands.
      setOptimisticStage(null);
    },
    onApprovalCreated: (_data: NewsletterApprovalCreatedEventData) => {
      // Refresh open approvals — the new row should appear.
      void queryClient.invalidateQueries({ queryKey: ['approvals-open', executionId] });
    },
    onApprovalResolved: (_data: NewsletterApprovalResolvedEventData) => {
      // Refresh — the row should be gone or marked resolved on the next fetch.
      void queryClient.invalidateQueries({ queryKey: ['approvals-open', executionId] });
    },
  });

  // Determine current stage. Prefer the latest SSE event; fall back to
  // n8n's lastNodeExecuted from /status; fall back to optimistic state
  // set after an Approve click.
  const currentStage: NewsletterStage | null = useMemo(() => {
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    if (lastEvent) return lastEvent.stage;
    if (optimisticStage) return optimisticStage;
    if (statusQuery.data) return stageFromLastNode(statusQuery.data.lastNodeExecuted);
    return null;
  }, [events, optimisticStage, statusQuery.data]);

  // The first open approval becomes the active panel. There's at most one
  // outstanding approval at a time per the workflow design (stories OR
  // subject_line, never both).
  const activeApproval = (approvalsQuery.data?.approvals ?? [])[0] ?? null;

  // The execution's edition_id rides on stage events (data.editionId). If
  // we have any event, prefer that; otherwise fall back to ai-news for
  // header purposes (which matches today's only seeded edition).
  const editionId = events[0]?.editionId ?? 'ai-news';
  const edition = (editionsQuery.data?.editions ?? []).find((e) => e.id === editionId);

  const sendDate = events[0]?.ts ? new Date(events[0].ts).toLocaleDateString() : '';
  const n8nUiUrl = (import.meta as unknown as { env?: { VITE_N8N_UI_URL?: string } }).env?.VITE_N8N_UI_URL
    ?? 'https://n8n.agileadautomation.com';

  function handleResolved(decision: 'approve' | 'revise') {
    // Optimistically advance the strip so the user sees movement before
    // the next stage event lands. The approval-resolved SSE will trigger
    // a refetch that clears `activeApproval`; the real next stage event
    // will replace `optimisticStage`.
    if (!activeApproval) return;
    if (decision === 'approve') {
      if (activeApproval.stage === 'stories') setOptimisticStage('stories_approved');
      else if (activeApproval.stage === 'subject_line') setOptimisticStage('subject_approved');
    }
    // On revise the workflow loops back; no optimistic strip move.
    void queryClient.invalidateQueries({ queryKey: ['approvals-open', executionId] });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <Link to="/newsletter" className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">
            ← Newsletter home
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {edition ? edition.display_name : editionId}
            {sendDate && <span className="text-gray-400"> · {sendDate}</span>}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
            execution {executionId}
          </p>
        </div>
        <a
          href={`${n8nUiUrl}/executions/${encodeURIComponent(executionId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
        >
          Open in n8n →
        </a>
      </header>

      <StageStrip
        currentStage={currentStage}
        error={errorEvent ? { stage: errorEvent.stage, detail: errorEvent.detail } : null}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_480px]">
        {/* Left: live log */}
        <LiveLog events={events} errorEvent={errorEvent} />

        {/* Right: active approval (if any) */}
        <aside className="space-y-3">
          {approvalsQuery.isLoading && !activeApproval ? (
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900">
              Checking for pending approvals…
            </div>
          ) : !activeApproval ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              No approval waiting. The workflow advances automatically.
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-700 dark:bg-amber-950/30">
              <header>
                <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
                  {activeApproval.stage === 'stories' ? 'Stories approval' : 'Subject approval'}
                </span>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Token: <code className="font-mono">{activeApproval.token.slice(0, 12)}…</code>
                </p>
              </header>
              {activeApproval.stage === 'stories' ? (
                <ApprovalPayloadStories payload={activeApproval.payload} />
              ) : (
                <ApprovalPayloadSubject payload={activeApproval.payload} />
              )}
              <ApprovalResolveForm
                token={activeApproval.token}
                onResolved={handleResolved}
              />
            </div>
          )}
        </aside>
      </div>

      <details className="rounded-lg border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-900">
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-gray-700 dark:text-gray-200">
          Raw events ({events.length})
        </summary>
        <pre className="overflow-x-auto border-t border-gray-100 p-3 font-mono text-[10px] leading-4 text-gray-700 dark:border-gray-800 dark:text-gray-300">
          {events.map((e, i) => `${e.ts}  ${e.stage}  ${e.detail}\n${i === events.length - 1 ? '' : ''}`).join('')}
          {events.length === 0 && '(no events yet)'}
        </pre>
      </details>
    </div>
  );
}
