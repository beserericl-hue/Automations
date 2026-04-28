/**
 * Newsletter Templates Sprint — T3 client tests.
 *
 * Asserts the list page filters + delete flow, and the editor's save
 * path + sample-data validation. Mock surface: apiFetch (programmable
 * per path), useNavigate, UserContext (mirrors the pattern from
 * newsletter-pages.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';

const { apiFetchImplRef, TestApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(public status: number, public code: string, message: string, public body?: unknown) {
      super(message);
      this.name = 'ApiError';
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

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigateMock,
    // Make :id available without driving real history. The list test doesn't
    // need params; the editor tests pass `/new` (create) so useParams()
    // returns {} (no id) — matching production behavior.
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
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// TemplatesList
// ---------------------------------------------------------------------------

describe('TemplatesList', () => {
  it('renders rows with default badge + source pill', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.startsWith('/api/newsletter/templates')) {
        return {
          success: true,
          templates: [
            { id: 't1', name: 'The Workbench (default)', description: null, edition_id: 'ai-news', user_id: null, source_type: 'system', sample_data: {}, is_default: true,  active: true,  created_at: '', updated_at: '2026-04-28T12:00:00Z' },
            { id: 't2', name: 'My experiment',           description: null, edition_id: 'ai-news', user_id: '+14105914612', source_type: 'user',  sample_data: {}, is_default: false, active: true,  created_at: '', updated_at: '2026-04-28T13:00:00Z' },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const TemplatesList = (await import('../components/newsletter/TemplatesList')).default;
    renderWithProviders(<TemplatesList />);

    expect(await screen.findByText('The Workbench (default)')).toBeInTheDocument();
    expect(screen.getByText('My experiment')).toBeInTheDocument();
    // default badge appears once (only on t1)
    expect(screen.getAllByText(/^default$/).length).toBe(1);
    // source pills
    expect(screen.getByText('system')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('refuses to delete an active default and shows an inline error', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.startsWith('/api/newsletter/templates')) {
        return {
          success: true,
          templates: [
            { id: 't1', name: 'Default', description: null, edition_id: 'ai-news', user_id: null, source_type: 'system', sample_data: {}, is_default: true, active: true, created_at: '', updated_at: '' },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const TemplatesList = (await import('../components/newsletter/TemplatesList')).default;
    renderWithProviders(<TemplatesList />);

    const del = await screen.findByRole('button', { name: /delete/i });
    fireEvent.click(del);

    expect(await screen.findByRole('alert')).toHaveTextContent(/active default/i);
  });

  it('calls DELETE for non-default rows and re-queries the list', async () => {
    let deleted = false;
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.startsWith('/api/newsletter/templates') && (options as { method?: string })?.method === 'DELETE') {
        deleted = true;
        return { success: true };
      }
      if (path.startsWith('/api/newsletter/templates')) {
        return {
          success: true,
          templates: deleted ? [] : [
            { id: 't1', name: 'Mine', description: null, edition_id: 'ai-news', user_id: '+14105914612', source_type: 'user', sample_data: {}, is_default: false, active: true, created_at: '', updated_at: '' },
          ],
        };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const TemplatesList = (await import('../components/newsletter/TemplatesList')).default;
    renderWithProviders(<TemplatesList />);

    const del = await screen.findByRole('button', { name: /delete/i });
    fireEvent.click(del);

    await waitFor(() => expect(deleted).toBe(true));
  });

  it('builds the right query string when filters are set', async () => {
    const calls: string[] = [];
    apiFetchImplRef.current = (path: string) => {
      calls.push(path);
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path.startsWith('/api/newsletter/templates')) return { success: true, templates: [] };
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const TemplatesList = (await import('../components/newsletter/TemplatesList')).default;
    renderWithProviders(<TemplatesList />);

    // Wait for the initial /templates fetch so the editions select has rendered.
    await waitFor(() => expect(calls.some((c) => c.startsWith('/api/newsletter/templates'))).toBe(true));

    // Toggle the inactive checkbox first — that produces a clearly-keyed
    // re-fetch we can wait on. The edition filter triggers the same
    // useQuery key change, but assertion gets simpler with the toggle.
    fireEvent.click(screen.getByLabelText(/show inactive/i));

    await waitFor(() => {
      expect(calls.some((c) => c.includes('include_inactive=true'))).toBe(true);
    });

    // Now change the edition filter — this is a separate query key change.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ai-news' } });

    await waitFor(() => {
      expect(calls.some((c) => c.includes('edition_id=ai-news'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// TemplateEditor — covers create-mode validation + save flow
// ---------------------------------------------------------------------------

describe('TemplateEditor (create mode)', () => {
  it('surfaces a JSON parse error inline below the sample_data textarea', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      return Promise.reject(new Error('unstubbed: ' + path));
    };

    const TemplateEditor = (await import('../components/newsletter/TemplateEditor')).default;
    renderWithProviders(<TemplateEditor />);

    // Wait for the editor to render (editions query resolved).
    const sampleField = await screen.findByLabelText(/sample data json/i);
    fireEvent.change(sampleField, { target: { value: '{ this is not valid json' } });

    // The inline alert lives below the textarea; useMemo + useEffect drive it.
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      const json = alerts.find((a) => /JSON|json|expected/i.test(a.textContent || ''));
      expect(json).toBeTruthy();
    });
  });

  it('does not POST when sample_data is invalid JSON', async () => {
    let posted = false;
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/templates' && (options as { method?: string })?.method === 'POST') {
        posted = true;
        return { success: true, template: { id: 'tnew' } };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };

    const TemplateEditor = (await import('../components/newsletter/TemplateEditor')).default;
    renderWithProviders(<TemplateEditor />);

    fireEvent.change(await screen.findByLabelText(/^name$/i), { target: { value: 'My new template' } });
    fireEvent.change(screen.getByLabelText(/sample data json/i), { target: { value: '{ broken' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Wait a tick for state updates to flush, then assert no POST happened.
    await new Promise((r) => setTimeout(r, 50));
    expect(posted).toBe(false);
  });

  it('POSTs valid create payload and navigates to the saved row', async () => {
    apiFetchImplRef.current = (path: string, options?: unknown) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      if (path === '/api/newsletter/templates' && (options as { method?: string })?.method === 'POST') {
        const body = JSON.parse(((options as { body?: string })?.body) ?? '{}') as { name: string; html: string };
        if (!body.name || !body.html) throw new Error('bad payload');
        return { success: true, template: { id: 'tnew', name: body.name, html: body.html, sample_data: {}, is_default: false, active: true, source_type: 'user', user_id: '+14105914612', edition_id: 'ai-news', description: null, created_at: '', updated_at: '' } };
      }
      return Promise.reject(new Error('unstubbed: ' + path));
    };

    const TemplateEditor = (await import('../components/newsletter/TemplateEditor')).default;
    renderWithProviders(<TemplateEditor />);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Quick template' } });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/newsletter/templates/tnew'));
  });

  it('blocks save when name or html is empty', async () => {
    apiFetchImplRef.current = (path: string) => {
      if (path === '/api/newsletter/editions') return { success: true, editions: [seedEdition] };
      return Promise.reject(new Error('unstubbed: ' + path));
    };
    const TemplateEditor = (await import('../components/newsletter/TemplateEditor')).default;
    renderWithProviders(<TemplateEditor />);

    // Wipe the starter HTML so save fails name-or-html guard.
    const html = screen.getByLabelText(/template html source/i);
    fireEvent.change(html, { target: { value: '' } });
    // Leave name blank.
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Name and HTML are required/i);
  });
});
