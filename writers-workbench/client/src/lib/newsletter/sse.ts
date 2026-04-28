/**
 * useNewsletterEvents — subscribes to newsletter.* SSE events.
 *
 * Single EventSource lives in AppShell.tsx (`/api/callback/events`). It already
 * fans every payload it receives to the window via CustomEvent, mirroring the
 * pattern S10b-3 set up for `chat-job-status`. AppShell was extended in S4 to
 * also dispatch `newsletter-stage`, `newsletter-approval-created`, and
 * `newsletter-approval-resolved` whenever the corresponding `payload.event`
 * arrives — see AppShell.tsx for the source.
 *
 * This hook is the consumer side of that contract. It listens to the window
 * events, optionally filters by executionId / token, and calls the supplied
 * handler. No second EventSource is opened.
 */
import { useEffect, useRef } from 'react';
import type {
  NewsletterEvent,
  NewsletterStageEventData,
  NewsletterApprovalCreatedEventData,
  NewsletterApprovalResolvedEventData,
} from './schema';

export interface NewsletterEventHandlers {
  /** Called for newsletter.stage. If `executionId` filter is set, only matching events fire. */
  onStage?: (data: NewsletterStageEventData) => void;
  /** Called for newsletter.approval.created. */
  onApprovalCreated?: (data: NewsletterApprovalCreatedEventData) => void;
  /** Called for newsletter.approval.resolved. If `token` filter is set, only matching events fire. */
  onApprovalResolved?: (data: NewsletterApprovalResolvedEventData) => void;
  /** Catch-all — receives every newsletter event. Useful for the in-flight log. */
  onAny?: (event: NewsletterEvent) => void;
}

export interface UseNewsletterEventsOptions extends NewsletterEventHandlers {
  /** When set, onStage/onAny only fire for events with this executionId. */
  executionId?: string;
  /** When set, onApprovalResolved/onAny only fire for events with this token. */
  token?: string;
}

const STAGE_EVENT = 'newsletter-stage';
const APPROVAL_CREATED_EVENT = 'newsletter-approval-created';
const APPROVAL_RESOLVED_EVENT = 'newsletter-approval-resolved';

export function useNewsletterEvents({
  executionId,
  token,
  onStage,
  onApprovalCreated,
  onApprovalResolved,
  onAny,
}: UseNewsletterEventsOptions = {}) {
  // Stash callbacks in refs so the effect doesn't re-bind on every render —
  // listeners stay attached for the consumer's whole lifetime.
  const handlersRef = useRef({ onStage, onApprovalCreated, onApprovalResolved, onAny });
  handlersRef.current = { onStage, onApprovalCreated, onApprovalResolved, onAny };

  useEffect(() => {
    function handleStage(e: Event) {
      const ce = e as CustomEvent<NewsletterStageEventData>;
      const data = ce.detail;
      if (executionId && data.executionId !== executionId) return;
      handlersRef.current.onStage?.(data);
      handlersRef.current.onAny?.({ event: 'newsletter.stage', data });
    }
    function handleApprovalCreated(e: Event) {
      const ce = e as CustomEvent<NewsletterApprovalCreatedEventData>;
      const data = ce.detail;
      if (token && data.token !== token) return;
      handlersRef.current.onApprovalCreated?.(data);
      handlersRef.current.onAny?.({ event: 'newsletter.approval.created', data });
    }
    function handleApprovalResolved(e: Event) {
      const ce = e as CustomEvent<NewsletterApprovalResolvedEventData>;
      const data = ce.detail;
      if (token && data.token !== token) return;
      handlersRef.current.onApprovalResolved?.(data);
      handlersRef.current.onAny?.({ event: 'newsletter.approval.resolved', data });
    }

    window.addEventListener(STAGE_EVENT, handleStage);
    window.addEventListener(APPROVAL_CREATED_EVENT, handleApprovalCreated);
    window.addEventListener(APPROVAL_RESOLVED_EVENT, handleApprovalResolved);

    return () => {
      window.removeEventListener(STAGE_EVENT, handleStage);
      window.removeEventListener(APPROVAL_CREATED_EVENT, handleApprovalCreated);
      window.removeEventListener(APPROVAL_RESOLVED_EVENT, handleApprovalResolved);
    };
  }, [executionId, token]);
}

// Exported so AppShell + tests don't string-duplicate the event names.
export const NEWSLETTER_EVENT_NAMES = {
  STAGE: STAGE_EVENT,
  APPROVAL_CREATED: APPROVAL_CREATED_EVENT,
  APPROVAL_RESOLVED: APPROVAL_RESOLVED_EVENT,
} as const;
