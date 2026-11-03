/**
 * S8 — PendingApprovals + ApprovalDetail page tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';

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

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ token: 'tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa' }),
  };
});

const seedEdition = {
  id: 'ai-news', display_name: 'The Workbench', subheader: 'd', genre: 'ai', description: null,
  newsletter_name: 'A CourseworxAI Weekly', primary_color: '#14288c', paper_color: '#fbf8f2',
  enabled: true, user_id: '+14105914612', created_at: '', updated_at: '',
};

beforeEach(() => {
  apiFetchImplRef.current = () => Promise.reject(new Error('apiFetchImpl not set'));
  navigateMock.mockReset();
});

// ---------------------------------------------------------------------------
// PendingApprovals
// ---------------------------------------------------------------------------
describe('PendingApprovals', () => {
  it('renders the empty state when the inbox is empty', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/approvals/open') return { success: true, approvals: [] };
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const PendingApprovals = (await import('../components/newsletter/PendingApprovals')).default;
    renderWithProviders(<PendingApprovals />);
    expect(await screen.findByText(/No pending approvals\. You're caught up/i)).toBeInTheDocument();
  });

  it('renders rows with stage + excerpt + Review link', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/approvals/open') {
        return {
          success: true,
          approvals: [
            { id: '1', token: 'tok-stories', execution_id: 'exec-100', stage: 'stories', payload: { top_selected_stories: [{ title: 'OpenAI ships privacy model — and the trade-off is real' }] }, created_at: '2026-04-28T10:00:00Z', expires_at: new Date(Date.now() + 36*3600*1000).toISOString(), approval_url: null },
            { id: '2', token: 'tok-subject', execution_id: 'exec-101', stage: 'subject_line', payload: { subject_line: '👀 Big AI news this week' }, created_at: '2026-04-28T11:00:00Z', expires_at: new Date(Date.now() + 24*3600*1000).toISOString(), approval_url: null },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const PendingApprovals = (await import('../components/newsletter/PendingApprovals')).default;
    renderWithProviders(<PendingApprovals />);
    expect(await screen.findByText(/OpenAI ships privacy model/i)).toBeInTheDocument();
    expect(screen.getByText(/Big AI news this week/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Review/i).length).toBeGreaterThanOrEqual(2);
  });

  it('filters expired rows client-side', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/approvals/open') {
        return {
          success: true,
          approvals: [
            { id: '1', token: 'tok-fresh', execution_id: 'exec-1', stage: 'stories', payload: { top_selected_stories: [{ title: 'Fresh' }] }, created_at: '2026-04-28T10:00:00Z', expires_at: new Date(Date.now() + 3600_000).toISOString(), approval_url: null },
            { id: '2', token: 'tok-old',   execution_id: 'exec-2', stage: 'stories', payload: { top_selected_stories: [{ title: 'Stale' }] }, created_at: '2026-04-25T10:00:00Z', expires_at: new Date(Date.now() - 3600_000).toISOString(), approval_url: null },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const PendingApprovals = (await import('../components/newsletter/PendingApprovals')).default;
    renderWithProviders(<PendingApprovals />);
    expect(await screen.findByText(/Fresh/)).toBeInTheDocument();
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument();
  });

  it('clicking a row navigates to the detail route', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/approvals/open') {
        return {
          success: true,
          approvals: [
            { id: '1', token: 'tok-clicky', execution_id: 'exec-1', stage: 'stories', payload: { top_selected_stories: [{ title: 'Clicky' }] }, created_at: '2026-04-28T10:00:00Z', expires_at: new Date(Date.now() + 3600_000).toISOString(), approval_url: null },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const PendingApprovals = (await import('../components/newsletter/PendingApprovals')).default;
    renderWithProviders(<PendingApprovals />);
    const row = (await screen.findByText(/Clicky/)).closest('tr')!;
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledWith('/newsletter/approvals/tok-clicky');
  });
});

// ---------------------------------------------------------------------------
// ApprovalDetail
// ---------------------------------------------------------------------------
describe('ApprovalDetail', () => {
  it('renders the resolve form when an open approval matches the token', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path.startsWith('/api/newsletter/approvals/open?token=')) {
        return {
          success: true,
          approvals: [
            { id: '1', token: 'tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa', execution_id: 'exec-9', stage: 'subject_line', payload: { subject_line: 'Hello' }, created_at: '', expires_at: new Date(Date.now() + 3600_000).toISOString() },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);

    expect(await screen.findByRole('heading', { name: /Subject line approval/i })).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
  });

  it('shows "no longer pending" when the token doesn\'t match an open row', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path.startsWith('/api/newsletter/approvals/open?token=')) {
        return { success: true, approvals: [] };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);

    expect(await screen.findByText(/no longer pending/i)).toBeInTheDocument();
  });

  it('resolving navigates back to /newsletter/approvals', async () => {
    let resolved = false;
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path.startsWith('/api/newsletter/approvals/open?token=')) {
        return {
          success: true,
          approvals: [
            { id: '1', token: 'tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa', execution_id: 'exec-9', stage: 'stories', payload: { top_selected_stories: [{ title: 'X' }] }, created_at: '', expires_at: new Date(Date.now() + 3600_000).toISOString() },
          ],
        };
      }
      if (path === '/api/newsletter/approvals/tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa/resolve' && (options as { method?: string })?.method === 'POST') {
        resolved = true;
        return { success: true, resumed: true };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);

    await screen.findByRole('button', { name: /Approve/i });
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() => expect(resolved).toBe(true));
    expect(navigateMock).toHaveBeenCalledWith('/newsletter/approvals');
  });
});

// ---------------------------------------------------------------------------
// The final "Send to subscribers" gate (2026-11-03)
// ---------------------------------------------------------------------------
describe('ApprovalDetail — final send gate', () => {
  const TOKEN = 'tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa';
  const sendRow = {
    id: '1', token: TOKEN, execution_id: 'exec-9', stage: 'send',
    payload: { send_id: 's1', subject: 'Issue seven', issue_number: 7, subscriber_count: 0 },
    created_at: '', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };

  function stub(calls: Array<{ path: string; body?: string }>) {
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      const o = options as { method?: string; body?: string } | undefined;
      if (path.startsWith('/api/newsletter/approvals/open?token=')) return { success: true, approvals: [sendRow] };
      if (path === `/api/newsletter/approvals/${TOKEN}/preview`) return { success: true, html: '<h1>Rendered issue</h1>', rendered: true };
      if (path === `/api/newsletter/approvals/${TOKEN}/test-copies`) return { success: true, data: [] };
      if (o?.method === 'POST') {
        calls.push({ path, body: o.body });
        if (path.endsWith('/test-copy')) {
          return { success: true, data: { to: 'eric@example.com', subject: '[TEST] Issue seven', message_id: 'm-1', sent_at: '', message: 'Test copy sent to eric@example.com. Subscribers have not been sent anything.' } };
        }
        return { success: true, resumed: true };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
  }

  it('shows the send gate with the subscriber count, the rendered issue and a test-copy button', async () => {
    stub([]);
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);
    expect(await screen.findByRole('heading', { name: /Send to subscribers/i })).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no active subscribers/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send me a test copy/i })).toBeInTheDocument();
    expect(await screen.findByText(/exactly as subscribers will receive it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send to 0 subscribers/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Revise$/)).not.toBeInTheDocument();
  });

  it('"Send me a test copy" posts to the test-copy route and does not resolve the gate', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    stub(calls);
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /Send me a test copy/i }));
    expect(await screen.findByText(/Test copy sent to eric@example.com/i)).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual([`/api/newsletter/approvals/${TOKEN}/test-copy`]);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('"Don\'t send" resolves the gate with reject', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    stub(calls);
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);
    fireEvent.click(await screen.findByLabelText(/Don.t send/i));
    fireEvent.click(screen.getByRole('button', { name: /Cancel this issue/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toBe(`/api/newsletter/approvals/${TOKEN}/resolve`);
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ decision: 'reject' });
  });
});

describe('StageStrip — send gate', () => {
  it('shows a Send approval phase awaiting while the issue waits, after Saved', async () => {
    const StageStrip = (await import('../components/newsletter/StageStrip')).default;
    renderWithProviders(<StageStrip currentStage="awaiting_send_approval" />);
    const saved = document.querySelector('[data-phase="saved"]');
    const send = document.querySelector('[data-phase="send_approval"]');
    const sent = document.querySelector('[data-phase="sent"]');
    expect(saved?.getAttribute('data-state')).toBe('done');
    expect(send?.getAttribute('data-state')).toBe('active');
    expect(send?.textContent).toContain('⌛');
    expect(sent?.getAttribute('data-state')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Image gate: the reviewer's pick reaches the resolve call (2026-11-03)
// ---------------------------------------------------------------------------
describe('ApprovalDetail — image gate picks', () => {
  const TOKEN = 'tok-detail-aaaaaaaaaaaaaaaaaaaaaaaa';
  const A = 'https://img.example/a.png';
  const B = 'https://img.example/b.png';
  const imageRow = {
    id: '1', token: TOKEN, execution_id: 'exec-9', stage: 'image',
    payload: {
      image_options_by_story: [{ story_title: 'Story one', options: [A, B], auto_pick: A }],
      segments: [{ story_title: 'Story one', chosen_image_url: A }],
    },
    created_at: '', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };

  function stub(bodies: Array<Record<string, unknown>>) {
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      const o = options as { method?: string; body?: string } | undefined;
      if (path.startsWith('/api/newsletter/approvals/open?token=')) return { success: true, approvals: [imageRow] };
      if (path.endsWith('/preview')) return { success: true, html: '<p>p</p>' };
      if (path === `/api/newsletter/approvals/${TOKEN}/resolve` && o?.method === 'POST') {
        bodies.push(JSON.parse(o.body ?? '{}'));
        return { success: true, resumed: true };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
  }

  it('approving after picking a non-default image sends it as chosen_images', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stub(bodies);
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);
    const second = await screen.findByRole('button', { name: /Use option 2 for Story one/i });
    expect(screen.getByRole('button', { name: /Use option 1 for Story one/i })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Approve/i }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ decision: 'approve', chosen_images: { 'Story one': B } });
  });

  it('shows the section\'s current image as chosen even when the section writer rewrote its title', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stub(bodies);
    imageRow.payload.segments = [{ story_title: 'A Rewritten Headline', chosen_image_url: B }];
    try {
      const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
      renderWithProviders(<ApprovalDetail />);
      expect(await screen.findByRole('button', { name: /Use option 2 for Story one/i })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: /^Approve/i }));
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toMatchObject({ chosen_images: { 'Story one': B } });
    } finally {
      imageRow.payload.segments = [{ story_title: 'Story one', chosen_image_url: A }];
    }
  });

  it('"No image for this story" sends an empty choice', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stub(bodies);
    const ApprovalDetail = (await import('../components/newsletter/ApprovalDetail')).default;
    renderWithProviders(<ApprovalDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /No image for this story/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Approve/i }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ chosen_images: { 'Story one': '' } });
  });
});
