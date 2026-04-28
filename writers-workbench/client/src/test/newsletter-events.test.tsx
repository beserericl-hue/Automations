/**
 * S4 (Compose Newsletter 2a) — useNewsletterEvents hook contract test.
 *
 * Asserts that:
 *   1. dispatching `newsletter-stage` on window invokes onStage with the
 *      payload exactly as AppShell provides it.
 *   2. the `executionId` filter discards events from other executions.
 *   3. `newsletter-approval-created` and `newsletter-approval-resolved`
 *      route to the right handlers.
 *   4. the `token` filter discards approval events for other tokens.
 *   5. cleanup removes listeners (no leak across renders).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNewsletterEvents } from '../lib/newsletter/sse';
import type {
  NewsletterStageEventData,
  NewsletterApprovalCreatedEventData,
  NewsletterApprovalResolvedEventData,
} from '../lib/newsletter/schema';

afterEach(() => {
  // Sanity guard so a failing test doesn't leak listeners into the next one.
  // (CustomEvents persist on the window; the hook cleans up on unmount, but
  // belt-and-braces.)
});

function dispatchStage(data: NewsletterStageEventData) {
  window.dispatchEvent(new CustomEvent('newsletter-stage', { detail: data }));
}
function dispatchApprovalCreated(data: NewsletterApprovalCreatedEventData) {
  window.dispatchEvent(new CustomEvent('newsletter-approval-created', { detail: data }));
}
function dispatchApprovalResolved(data: NewsletterApprovalResolvedEventData) {
  window.dispatchEvent(new CustomEvent('newsletter-approval-resolved', { detail: data }));
}

const stageEvent: NewsletterStageEventData = {
  userId: '+14105914612',
  executionId: 'exec-123',
  editionId: 'ai-news',
  stage: 'gathering',
  detail: 'started ingestion search',
  ts: '2026-04-28T10:00:00.000Z',
};

const approvalCreatedEvent: NewsletterApprovalCreatedEventData = {
  token: 'tok-abc',
  stage: 'stories',
  execution_id: 'exec-123',
  approval_url: 'http://localhost:3001/approvals/tok-abc',
};

const approvalResolvedEvent: NewsletterApprovalResolvedEventData = {
  token: 'tok-abc',
  stage: 'stories',
  execution_id: 'exec-123',
  decision: 'approve',
  feedback: '',
  resumed: true,
};

describe('useNewsletterEvents', () => {
  it('invokes onStage when newsletter-stage fires on window', () => {
    const onStage = vi.fn();
    renderHook(() => useNewsletterEvents({ onStage }));
    act(() => {
      dispatchStage(stageEvent);
    });
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage).toHaveBeenCalledWith(stageEvent);
  });

  it('filters by executionId — non-matching events are ignored', () => {
    const onStage = vi.fn();
    const onAny = vi.fn();
    renderHook(() => useNewsletterEvents({ executionId: 'exec-OTHER', onStage, onAny }));
    act(() => {
      dispatchStage(stageEvent);
    });
    expect(onStage).not.toHaveBeenCalled();
    expect(onAny).not.toHaveBeenCalled();
  });

  it('routes approval.created to onApprovalCreated', () => {
    const onApprovalCreated = vi.fn();
    const onApprovalResolved = vi.fn();
    renderHook(() => useNewsletterEvents({ onApprovalCreated, onApprovalResolved }));
    act(() => {
      dispatchApprovalCreated(approvalCreatedEvent);
    });
    expect(onApprovalCreated).toHaveBeenCalledWith(approvalCreatedEvent);
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it('routes approval.resolved to onApprovalResolved', () => {
    const onApprovalResolved = vi.fn();
    renderHook(() => useNewsletterEvents({ onApprovalResolved }));
    act(() => {
      dispatchApprovalResolved(approvalResolvedEvent);
    });
    expect(onApprovalResolved).toHaveBeenCalledWith(approvalResolvedEvent);
  });

  it('filters by token — non-matching approval events are ignored', () => {
    const onApprovalResolved = vi.fn();
    renderHook(() => useNewsletterEvents({ token: 'tok-OTHER', onApprovalResolved }));
    act(() => {
      dispatchApprovalResolved(approvalResolvedEvent);
    });
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it('catch-all onAny receives every newsletter event', () => {
    const onAny = vi.fn();
    renderHook(() => useNewsletterEvents({ onAny }));
    act(() => {
      dispatchStage(stageEvent);
      dispatchApprovalCreated(approvalCreatedEvent);
      dispatchApprovalResolved(approvalResolvedEvent);
    });
    expect(onAny).toHaveBeenCalledTimes(3);
    const calls = onAny.mock.calls.map((c) => c[0].event);
    expect(calls).toEqual([
      'newsletter.stage',
      'newsletter.approval.created',
      'newsletter.approval.resolved',
    ]);
  });

  it('removes listeners on unmount — no calls after unmount', () => {
    const onStage = vi.fn();
    const { unmount } = renderHook(() => useNewsletterEvents({ onStage }));
    unmount();
    act(() => {
      dispatchStage(stageEvent);
    });
    expect(onStage).not.toHaveBeenCalled();
  });
});
