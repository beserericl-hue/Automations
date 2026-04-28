/**
 * S6 — NewsletterHome + NewsletterGenerate page tests.
 *
 * apiFetch is mocked at module scope so each test can stub responses
 * per-call without flakily threading fetch through. UserContext is
 * stubbed via the existing test setup pattern (see s10b3-chat-queue.test).
 *
 * For NewsletterHome we mostly assert that the right tile lights up
 * given a particular dataset. For NewsletterGenerate we assert the
 * disabled-while-in-flight state, the inline 400 error rendering, and
 * the post-success navigation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';
import { act } from 'react';

// -----------------------------------------------------------------------------
// apiFetch mock — programmable per-path responses or thrown errors.
// -----------------------------------------------------------------------------

type ApiResolver = (path: string, options?: unknown) =>
  | Promise<unknown>
  | unknown;

// vi.hoisted lets the apiFetchImpl ref live above the vi.mock factory
// (vi.mock is hoisted to the top of the file). The ApiError class also
// goes through hoisted so the same constructor reference is available
// to apiFetchImpl callers and to `instanceof` checks inside the page.
const { apiFetchImplRef, TestApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(public status: number, public code: string, message: string, public body?: unknown) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    apiFetchImplRef: { current: ((() => Promise.reject(new Error('apiFetchImpl not set'))) as ApiResolver) },
    TestApiError: HoistedApiError,
  };
});

vi.mock('../lib/api', () => ({
  apiFetch: async (path: string, options?: unknown) => apiFetchImplRef.current(path, options),
  ApiError: TestApiError,
  getActiveImpersonation: () => null,
  setActiveImpersonation: () => undefined,
}));

function setApiFetchImpl(impl: ApiResolver) { apiFetchImplRef.current = impl; }

vi.mock('../contexts/UserContext', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useUser: () => ({
      profile: { user_id: '+14105914612', display_name: 'Test User', isAdmin: false },
      isImpersonating: false,
    }),
  };
});

// react-router's `useNavigate()` — we want to capture calls without
// actually navigating (the BrowserRouter in test-utils owns history, but
// we'd rather assert intent than spelunk into it).
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

beforeEach(() => {
  setApiFetchImpl(() => Promise.reject(new Error('apiFetchImpl not set')));
  navigateMock.mockReset();
});

// -----------------------------------------------------------------------------
// Helpers — typed query map so each test can describe its dataset cleanly.
// -----------------------------------------------------------------------------

interface MockResponses {
  editions?: { id: string; display_name: string; primary_color: string; subheader: string; genre: string; description: string | null; newsletter_name: string; paper_color: string; enabled: boolean; user_id: string; created_at: string; updated_at: string }[];
  approvals?: Array<{ id: string; token: string; execution_id: string; stage: 'stories' | 'subject_line'; created_at: string; expires_at: string; approval_url: string | null }>;
  sends?: Array<{ id: string; user_id: string; edition_id: string | null; execution_id: string | null; issue_number: number | null; send_date: string; subject: string; preheader: string | null; status: string; scheduled_send_at: string | null; sent_at: string | null; recipient_count: number | null; delivery_provider: string | null; error: string | null; created_at: string; updated_at: string }>;
  scheduledSend?: MockResponses['sends'] extends Array<infer R> ? R | null : never;
  lastSent?: { markdown: string | null };
  generateError?: { status: number; code: string; message: string };
  generateSuccess?: { executionId: string; editionId: string };
}

function installMocks(m: MockResponses) {
  setApiFetchImpl((path: string, options?: unknown) => {
    if (path === '/api/newsletter/editions') {
      return { success: true, editions: m.editions ?? [] };
    }
    if (path.startsWith('/api/newsletter/editions/') && path.endsWith('/last-sent-markdown')) {
      return { success: true, markdown: m.lastSent?.markdown ?? null };
    }
    if (path === '/api/newsletter/approvals/open') {
      return { success: true, approvals: m.approvals ?? [] };
    }
    if (path === '/api/newsletter/sends?status=scheduled&limit=1') {
      return { success: true, sends: m.scheduledSend ? [m.scheduledSend] : [] };
    }
    if (path === '/api/newsletter/sends?limit=10') {
      return { success: true, sends: m.sends ?? [] };
    }
    if (path === '/api/newsletter/generate' && (options as { method?: string })?.method === 'POST') {
      if (m.generateError) {
        throw new TestApiError(m.generateError.status, m.generateError.code, m.generateError.message);
      }
      if (m.generateSuccess) {
        return { success: true, started: true, ...m.generateSuccess };
      }
      throw new Error('generate not configured');
    }
    throw new Error('Unstubbed path: ' + path);
  });
}

const seedEdition = {
  id: 'ai-news',
  display_name: 'The Workbench',
  subheader: 'Dispatches',
  genre: 'ai',
  description: null,
  newsletter_name: 'A CourseworxAI Weekly',
  primary_color: '#14288c',
  paper_color: '#fbf8f2',
  enabled: true,
  user_id: '+14105914612',
  created_at: '2026-04-25T00:00:00Z',
  updated_at: '2026-04-25T00:00:00Z',
};

// -----------------------------------------------------------------------------
// NewsletterHome
// -----------------------------------------------------------------------------

describe('NewsletterHome', () => {
  it('renders empty state when nothing is in-flight, no approvals, no scheduled, no runs', async () => {
    installMocks({});
    const NewsletterHome = (await import('../components/newsletter/NewsletterHome')).default;
    renderWithProviders(<NewsletterHome />);

    expect(await screen.findByRole('heading', { name: /newsletter/i })).toBeInTheDocument();
    expect(await screen.findByText(/no active run/i)).toBeInTheDocument();
    expect(await screen.findByText(/no approvals waiting/i)).toBeInTheDocument();
    expect(await screen.findByText(/nothing scheduled/i)).toBeInTheDocument();
    expect(await screen.findByText(/no newsletters yet/i)).toBeInTheDocument();
  });

  it('lights up the in-flight tile when a recent newsletter.stage event arrives via window CustomEvent', async () => {
    installMocks({ editions: [seedEdition] });
    const NewsletterHome = (await import('../components/newsletter/NewsletterHome')).default;
    renderWithProviders(<NewsletterHome />);

    // Wait for the editions query so the tile can render the badge.
    await screen.findByText(/no active run/i);

    // Dispatch a non-terminal stage event scoped to ai-news. Same shape
    // AppShell.tsx re-emits onto window after parsing the SSE payload.
    act(() => {
      window.dispatchEvent(new CustomEvent('newsletter-stage', {
        detail: {
          userId: '+14105914612',
          executionId: 'exec-42',
          editionId: 'ai-news',
          stage: 'gathering',
          detail: 'started ingestion search',
          ts: new Date().toISOString(),
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getByText(/started ingestion search/)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /resume/i })).toHaveAttribute(
      'href',
      '/newsletter/execution/exec-42',
    );
  });

  it('clears the in-flight tile when a `saved` stage arrives for the same execution', async () => {
    installMocks({ editions: [seedEdition] });
    const NewsletterHome = (await import('../components/newsletter/NewsletterHome')).default;
    renderWithProviders(<NewsletterHome />);
    await screen.findByText(/no active run/i);

    // Light it up first.
    act(() => {
      window.dispatchEvent(new CustomEvent('newsletter-stage', {
        detail: {
          userId: '+14105914612',
          executionId: 'exec-42',
          editionId: 'ai-news',
          stage: 'gathering',
          detail: 'started',
          ts: new Date().toISOString(),
        },
      }));
    });
    await waitFor(() => expect(screen.getByText('started')).toBeInTheDocument());

    // Then send `saved` for the same execution and assert it disappears.
    act(() => {
      window.dispatchEvent(new CustomEvent('newsletter-stage', {
        detail: {
          userId: '+14105914612',
          executionId: 'exec-42',
          editionId: 'ai-news',
          stage: 'saved',
          detail: 'issue scheduled',
          ts: new Date().toISOString(),
        },
      }));
    });
    await waitFor(() => expect(screen.getByText(/no active run/i)).toBeInTheDocument());
  });

  it('shows pending-approvals tile with up to 3 rows + "see all" link when more', async () => {
    const approvals = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      token: `tok-${i}`,
      execution_id: `exec-${i}`,
      stage: (i % 2 === 0 ? 'stories' : 'subject_line') as 'stories' | 'subject_line',
      created_at: '',
      expires_at: '',
      approval_url: null,
    }));
    installMocks({ approvals });
    const NewsletterHome = (await import('../components/newsletter/NewsletterHome')).default;
    renderWithProviders(<NewsletterHome />);

    await waitFor(() => expect(screen.getAllByText(/Review/i).length).toBe(3));
    expect(screen.getByText(/See all 5/)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// NewsletterGenerate
// -----------------------------------------------------------------------------

describe('NewsletterGenerate', () => {
  // Helper — the submit button is disabled until the editions query loads
  // and the useEffect picks the first edition. Wait for that before
  // clicking so test-time async doesn't leak into the assertions.
  async function waitForSubmitEnabled(): Promise<HTMLButtonElement> {
    await waitFor(() => {
      const b = screen.getByRole('button', { name: /generate newsletter/i }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
    });
    return screen.getByRole('button', { name: /generate newsletter/i }) as HTMLButtonElement;
  }

  it('disables submit while the generate request is in flight', async () => {
    let resolveGenerate!: (v: unknown) => void;
    setApiFetchImpl((path: string, options?: unknown) => {
      if (path === '/api/newsletter/editions') return Promise.resolve({ success: true, editions: [seedEdition] });
      if (path.endsWith('/last-sent-markdown')) return Promise.resolve({ success: true, markdown: null });
      if (path === '/api/newsletter/generate' && (options as { method?: string })?.method === 'POST') {
        return new Promise((resolve) => { resolveGenerate = resolve; });
      }
      return Promise.reject(new Error('Unstubbed path: ' + path));
    });

    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);
    const submit = await waitForSubmitEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /starting/i })).toBeDisabled();
    });

    // Resolve to clean up
    resolveGenerate({ success: true, started: true, executionId: 'exec-99', editionId: 'ai-news' });
  });

  it('navigates to /newsletter/execution/:id after a successful generate', async () => {
    installMocks({
      editions: [seedEdition],
      generateSuccess: { executionId: 'exec-go', editionId: 'ai-news' },
    });

    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);
    const submit = await waitForSubmitEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/newsletter/execution/exec-go');
    });
  });

  it('renders a 400 validation error inline without navigating', async () => {
    installMocks({
      editions: [seedEdition],
      generateError: { status: 400, code: 'VALIDATION_ERROR', message: 'send_date must be YYYY-MM-DD' },
    });
    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);
    const submit = await waitForSubmitEnabled();
    fireEvent.click(submit);

    expect(await screen.findByRole('alert')).toHaveTextContent(/send_date must be YYYY-MM-DD/i);
    expect(navigateMock).not.toHaveBeenCalled();
    // After the error, submit returns to enabled so the user can fix + retry.
    await waitFor(() => expect(screen.getByRole('button', { name: /generate newsletter/i })).not.toBeDisabled());
  });

  // The Preview button is disabled until editions load + the useEffect
  // picks the first edition. Wait for that before clicking.
  async function waitForPreviewEnabled(): Promise<HTMLButtonElement> {
    await waitFor(() => {
      const b = screen.getByRole('button', { name: /preview template/i }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
    });
    return screen.getByRole('button', { name: /preview template/i }) as HTMLButtonElement;
  }

  it('Preview button renders default template in a modal iframe (T4)', async () => {
    setApiFetchImpl((path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.endsWith('/last-sent-markdown')) return { success: true, markdown: null };
      if (path.startsWith('/api/newsletter/templates?edition_id=ai-news')) {
        return {
          success: true,
          templates: [
            { id: 'tpl-default', name: 'The Workbench (default)', description: null, edition_id: 'ai-news', user_id: null, source_type: 'system', sample_data: {}, is_default: true, active: true, created_at: '', updated_at: '' },
          ],
        };
      }
      if (path === '/api/newsletter/templates/tpl-default/preview') {
        return { success: true, html: '<html><body><h1>Preview body</h1></body></html>', warnings: [] };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    });

    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);

    const btn = await waitForPreviewEnabled();
    fireEvent.click(btn);

    expect(await screen.findByRole('dialog', { name: /template preview/i })).toBeInTheDocument();

    await waitFor(() => {
      const iframe = screen.getByTitle('Template preview iframe') as HTMLIFrameElement;
      expect(iframe.srcdoc).toContain('Preview body');
    });
  });

  it('Preview button surfaces a clear error when no default template exists for the edition (T4)', async () => {
    setApiFetchImpl((path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.endsWith('/last-sent-markdown')) return { success: true, markdown: null };
      if (path.startsWith('/api/newsletter/templates?edition_id=ai-news')) {
        return { success: true, templates: [] };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    });

    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);
    const btn = await waitForPreviewEnabled();
    fireEvent.click(btn);

    expect(await screen.findByRole('alert')).toHaveTextContent(/No template found/i);
  });

  it('prefills the previous-content textarea from /editions/:id/last-sent-markdown', async () => {
    installMocks({
      editions: [seedEdition],
      lastSent: { markdown: '# Yesterday\n\nbody' },
    });
    const NewsletterGenerate = (await import('../components/newsletter/NewsletterGenerate')).default;
    renderWithProviders(<NewsletterGenerate />);

    const textarea = await screen.findByLabelText(/previous newsletter content/i) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain('# Yesterday'));
  });
});
