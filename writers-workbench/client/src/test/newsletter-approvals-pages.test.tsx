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
