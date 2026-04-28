/**
 * S7 — ExecutionStatus components.
 *
 * Six unit tests per the sprint doc verification table:
 *   1. StageStrip renders 7 pills, current pill has aria-current="step"
 *   2. LiveLog auto-scrolls when at bottom; does not when scrolled up
 *   3. ApprovalPayloadStories with 0 stories → empty state; with 7 → 7 cards
 *   4. ApprovalPayloadSubject reasoning collapsed by default; expands on click
 *   5. Approve submit fires POST with decision: 'approve', empty feedback ok
 *   6. Revise with empty feedback blocks submit with inline validation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';
import StageStrip from '../components/newsletter/StageStrip';
import LiveLog from '../components/newsletter/LiveLog';
import ApprovalPayloadStories from '../components/newsletter/ApprovalPayloadStories';
import ApprovalPayloadSubject from '../components/newsletter/ApprovalPayloadSubject';
import type { NewsletterStageEventData } from '../lib/newsletter/schema';

// Hoisted apiFetch mock for ApprovalResolveForm.
const { apiFetchImplRef, TestApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(public status: number, public code: string, message: string, public body?: unknown) {
      super(message);
    }
  }
  return {
    apiFetchImplRef: { current: ((() => Promise.reject(new Error('apiFetchImpl not set'))) as (path: string, options?: unknown) => Promise<unknown> | unknown) },
    TestApiError: HoistedApiError,
  };
});

vi.mock('../lib/api', () => ({
  apiFetch: async (path: string, options?: unknown) => apiFetchImplRef.current(path, options),
  ApiError: TestApiError,
  getActiveImpersonation: () => null,
  setActiveImpersonation: () => undefined,
}));

beforeEach(() => {
  apiFetchImplRef.current = () => Promise.reject(new Error('apiFetchImpl not set'));
});

// ---------------------------------------------------------------------------
// 1. StageStrip
// ---------------------------------------------------------------------------
describe('StageStrip', () => {
  it('renders 7 pills with the current one carrying aria-current="step"', () => {
    renderWithProviders(<StageStrip currentStage="writing_segment" />);
    const pills = screen.getAllByRole('listitem');
    expect(pills).toHaveLength(7);
    const current = pills.find((el) => el.getAttribute('aria-current') === 'step');
    expect(current).toBeTruthy();
    expect(current?.getAttribute('data-phase')).toBe('writing');
  });

  it('shows error state on the phase the error landed in', () => {
    renderWithProviders(
      <StageStrip
        currentStage="selecting_stories"
        error={{ stage: 'selecting_stories', detail: 'Claude API 503' }}
      />,
    );
    const errorPill = screen.getAllByRole('listitem').find(
      (el) => el.getAttribute('data-state') === 'error',
    );
    expect(errorPill).toBeTruthy();
    expect(errorPill?.getAttribute('data-phase')).toBe('selecting');
  });

  it('marks earlier phases as done when current is mid-strip', () => {
    renderWithProviders(<StageStrip currentStage="writing_segment" />);
    const pills = screen.getAllByRole('listitem');
    // Phases 0..3 (gathering, selecting, stories_approval, subject_approval) → done
    // Phase 4 (writing) → active
    // Phases 5,6 (assembling, saved) → pending
    expect(pills[0].getAttribute('data-state')).toBe('done');
    expect(pills[3].getAttribute('data-state')).toBe('done');
    expect(pills[4].getAttribute('data-state')).toBe('active');
    expect(pills[5].getAttribute('data-state')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 2. LiveLog
// ---------------------------------------------------------------------------
describe('LiveLog', () => {
  function makeEvents(n: number): NewsletterStageEventData[] {
    return Array.from({ length: n }, (_, i) => ({
      userId: '+14105914612',
      executionId: 'exec-1',
      editionId: 'ai-news',
      stage: 'gathering' as const,
      detail: `event ${i}`,
      ts: new Date(2026, 3, 28, 10, 0, i).toISOString(),
    }));
  }

  it('auto-scrolls to bottom when user is near the bottom (no "New events" indicator)', async () => {
    const { rerender } = renderWithProviders(<LiveLog events={makeEvents(2)} />);
    // Re-render with more events; "stuck to bottom" is true on mount, so
    // no new-events indicator should appear.
    rerender(<LiveLog events={makeEvents(5)} />);
    expect(screen.queryByRole('button', { name: /New events/i })).not.toBeInTheDocument();
  });

  it('shows the "New events" scroll-lock indicator when user has scrolled up', async () => {
    const events = makeEvents(20);
    renderWithProviders(<LiveLog events={events} />);
    const log = screen.getByRole('log');
    // Simulate the user scrolling up — clientHeight + scrollTop is far below scrollHeight.
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 0, configurable: true, writable: true });
    fireEvent.scroll(log);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New events/i })).toBeInTheDocument();
    });
  });

  it('renders the error banner when errorEvent is provided', () => {
    renderWithProviders(
      <LiveLog
        events={makeEvents(1)}
        errorEvent={{
          userId: '+1', executionId: 'exec-1', editionId: 'ai-news',
          stage: 'error', detail: 'pick_top_stories failed',
          ts: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/pick_top_stories failed/i);
  });
});

// ---------------------------------------------------------------------------
// 3. ApprovalPayloadStories
// ---------------------------------------------------------------------------
describe('ApprovalPayloadStories', () => {
  it('shows the empty state when payload has no stories', () => {
    renderWithProviders(<ApprovalPayloadStories payload={{ top_selected_stories: [] }} />);
    expect(screen.getByText(/No stories in this approval payload/i)).toBeInTheDocument();
  });

  it('renders a card per story (7 stories → 7 cards)', () => {
    const stories = Array.from({ length: 7 }, (_, i) => ({
      title: `Story ${i + 1}`,
      summary: `Summary ${i + 1}`,
      external_source_urls: [`https://example.com/${i + 1}`],
      identifiers: [`id-${i + 1}`],
    }));
    renderWithProviders(<ApprovalPayloadStories payload={{ top_selected_stories: stories }} />);
    const list = screen.getByRole('list', { name: /selected stories/i });
    const items = list.querySelectorAll(':scope > li');
    expect(items).toHaveLength(7);
    expect(screen.getByText('Story 1')).toBeInTheDocument();
    expect(screen.getByText('Story 7')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. ApprovalPayloadSubject — collapsed by default; expandable
// ---------------------------------------------------------------------------
describe('ApprovalPayloadSubject', () => {
  const payload = {
    subject_line: '👀 Big AI news this week',
    pre_header_text: 'Plus three things you should read.',
    additional_subject_lines: ['Alt 1', 'Alt 2'],
    subject_line_reasoning: 'Hooks attention with eye emoji.',
    pre_header_text_reasoning: 'Compounds the curiosity gap.',
  };

  it('renders subject + preheader visible at top', () => {
    renderWithProviders(<ApprovalPayloadSubject payload={payload} />);
    expect(screen.getByText('👀 Big AI news this week')).toBeInTheDocument();
    expect(screen.getByText(/Plus three things/)).toBeInTheDocument();
  });

  it('keeps reasoning + alternatives collapsed by default; opens on click', () => {
    renderWithProviders(<ApprovalPayloadSubject payload={payload} />);

    // The <details> exists but is not open.
    const details = screen.getByText(/Reasoning \+ alternatives/i).closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);

    // Body content is hidden by browsers when not open; the DOM still has
    // the children but the <details> guard the visual reveal.
    fireEvent.click(screen.getByText(/Reasoning \+ alternatives/i));
    expect(details.open).toBe(true);
    expect(screen.getByText('Alt 1')).toBeInTheDocument();
    expect(screen.getByText('Hooks attention with eye emoji.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. ApprovalResolveForm
// ---------------------------------------------------------------------------
describe('ApprovalResolveForm', () => {
  it('Approve submit fires POST with decision: "approve" + empty feedback OK', async () => {
    const onResolved = vi.fn();
    let postedBody: string | null = null;
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path === '/api/newsletter/approvals/tok-123/resolve') {
        postedBody = (options as { body?: string }).body ?? null;
        return { success: true, resumed: true };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };

    const ApprovalResolveForm = (await import('../components/newsletter/ApprovalResolveForm')).default;
    renderWithProviders(<ApprovalResolveForm token="tok-123" onResolved={onResolved} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('approve', true));
    expect(postedBody).toBeTruthy();
    expect(JSON.parse(postedBody!)).toEqual({ decision: 'approve', feedback: '' });
  });

  it('Revise with empty feedback blocks submit with inline validation', async () => {
    const onResolved = vi.fn();
    let postCount = 0;
    apiFetchImplRef.current = (path: string) => {
      if (path.includes('/resolve')) postCount++;
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const ApprovalResolveForm = (await import('../components/newsletter/ApprovalResolveForm')).default;
    renderWithProviders(<ApprovalResolveForm token="tok-456" onResolved={onResolved} />);

    fireEvent.click(screen.getByLabelText(/Revise/i));
    fireEvent.click(screen.getByRole('button', { name: /Send back to revise/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Revise needs feedback/i);
    expect(onResolved).not.toHaveBeenCalled();
    expect(postCount).toBe(0);
  });

  it('Revise with non-empty feedback fires POST', async () => {
    const onResolved = vi.fn();
    let postedBody: string | null = null;
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path === '/api/newsletter/approvals/tok-789/resolve') {
        postedBody = (options as { body?: string }).body ?? null;
        return { success: true, resumed: true };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const ApprovalResolveForm = (await import('../components/newsletter/ApprovalResolveForm')).default;
    renderWithProviders(<ApprovalResolveForm token="tok-789" onResolved={onResolved} />);

    fireEvent.click(screen.getByLabelText(/Revise/i));
    fireEvent.change(screen.getByPlaceholderText(/What should change/i), { target: { value: 'Tighten the lead' } });
    fireEvent.click(screen.getByRole('button', { name: /Send back to revise/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('revise', true));
    expect(JSON.parse(postedBody!)).toEqual({ decision: 'revise', feedback: 'Tighten the lead' });
  });
});
