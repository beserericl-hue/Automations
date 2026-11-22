import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import BookEndingReview from './BookEndingReview';
import { apiFetch } from '../../lib/api';
import type { SeriesView } from './SeriesPanel';

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'p1', index: '1' }),
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../../config/supabase', () => {
  const row = { data: { id: 'c29', title: 'Stratum X', content_text: '<p>The light went pewter over the river. Nobody spoke.</p>' }, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve(row);
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } } };
});
const mockFetch = vi.mocked(apiFetch);

const CODA = { chapter_number: 29, chapter_title: 'Stratum X', text: 'Adaeze set the pen down.', words: 5, new_names: [], drafted_at: 'x' };
const book = (extra: object = {}) => ({
  index: 1, first_chapter: 0, last_chapter: 29, title: 'The Color of Old Pewter', title_source: 'edited', title_stale: false,
  suggestions: [], ending_draft: null, ending_reason: 'Settles the survey, leaves the report open', ...extra,
});
const SERIES = (b: object): SeriesView =>
  ({ name: 'The Ossuary', name_is_default: false, description: null, suggested_at: null, books: [b, { ...book(), index: 2, first_chapter: 30, last_chapter: 59 }] }) as never;

function serve(b: object) {
  mockFetch.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p === '/api/publishing/project/p1') return { success: true, data: { series: SERIES(b) } } as never;
    if (p.endsWith('/cliffhangers')) return { jobId: 'j1' } as never;
    if (p.endsWith('/humanize')) return { success: true, data: { text: 'Adaeze put the pen down.', changed: true } } as never;
    return { success: true, data: { series: SERIES(b) } } as never;
  });
}
beforeEach(() => mockFetch.mockReset());

describe('reviewing how a book ends', () => {
  it('shows how the book ends now, from the last chapter, without markup', async () => {
    serve(book());
    renderWithProviders(<BookEndingReview />);
    expect(await screen.findByTestId('ending-tail')).toHaveTextContent('The light went pewter over the river. Nobody spoke.');
    expect(screen.getByTestId('ending-tail').textContent).not.toContain('<p>');
    expect(screen.getByText(/Settles the survey/)).toBeInTheDocument();
  });

  it('asks the engine to recommend cliffhangers and lists what comes back, with what each leaves alone', async () => {
    serve(book({ cliffhangers: { options: [{ title: 'A decision', hook: 'Will she file?', scene: 'Adaeze alone.', uses: 'ch 25', avoid: 'ch 35 hearing', new_names: ['Quill'], problems: ['chapter 65 shows this email first'] }] } }));
    renderWithProviders(<BookEndingReview />);
    fireEvent.click(await screen.findByTestId('recommend'));
    await waitFor(() => expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/books/1/cliffhangers'))).toBe(true));
    expect(screen.getByTestId('cliffhanger-option')).toHaveTextContent('Leaves alone: ch 35 hearing');
    expect(screen.getByTestId('cliffhanger-option')).toHaveTextContent('Names not in the book yet: Quill');
    expect(screen.getByTestId('option-problems')).toHaveTextContent('chapter 65 shows this email first');
  });

  it('drafts the closing scene from the chosen cliffhanger', async () => {
    serve(book({ cliffhangers: { options: [{ title: 'A decision', hook: 'h', scene: 'Adaeze alone at her desk.', uses: 'u', avoid: 'a' }] } }));
    renderWithProviders(<BookEndingReview />);
    fireEvent.click(await screen.findByTestId('use-direction'));
    const box = await screen.findByDisplayValue('Adaeze alone at her desk.');
    expect(box).toBeInTheDocument();
  });

  it('runs the draft through the humanizer and puts the result in the draft only on request', async () => {
    serve(book({ coda_draft: CODA }));
    renderWithProviders(<BookEndingReview />);
    const run = await screen.findByText('Run the draft through the humanizer');
    await waitFor(() => expect(run).not.toBeDisabled());
    fireEvent.click(run);
    expect(await screen.findByTestId('humanized-result')).toHaveTextContent('Adaeze put the pen down.');
    expect(mockFetch.mock.calls.some(([p, o]) => String(p).endsWith('/books/1/coda') && (o as { method?: string })?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByText('Use this wording'));
    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([p, o]) => String(p).endsWith('/books/1/coda') && (o as { method?: string })?.method === 'PUT');
      expect(JSON.parse(String((put![1] as { body: string }).body))).toEqual({ text: 'Adaeze put the pen down.' });
    });
  });

  it('says the last book has no next book to hand the reader to', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, data: { series: { ...SERIES(book()), books: [{ ...book(), index: 1 }] } } }) as never);
    renderWithProviders(<BookEndingReview />);
    expect(await screen.findByText(/closes the story/)).toBeInTheDocument();
  });
});
