/**
 * Series: titles chosen from suggestions drawn from each book, and an ending read beside its
 * replacement before it goes in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import SeriesPanel, { type SeriesView } from './SeriesPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const SERIES: SeriesView = {
  name: 'The Ossuary',
  name_is_default: true,
  description: null,
  suggested_at: '2026-10-25T12:00:00Z',
  books: [
    {
      index: 1, first_chapter: 0, last_chapter: 30, estimated_pages: 610, ending_score: 0.3, ending_title: 'Winifred',
      ending_reason: 'Stops with the box unopened.', ending_resolves: '', ending_carries: 'What is in the box?',
      title: '', title_source: null, title_stale: false,
      suggestions: [{ title: 'The Pewter Light', phrase: 'the light went pewter', why: 'the dawn the book opens on' }],
      ending_draft: null,
    },
    {
      index: 2, first_chapter: 31, last_chapter: 61, estimated_pages: 592, ending_score: 0.81, title: 'The Fort Post',
      title_source: 'edited', title_stale: true, suggestions: [], ending_draft: null,
    },
  ],
};
const DRAFTED: SeriesView = {
  ...SERIES,
  books: [
    {
      ...SERIES.books[0],
      ending_draft: {
        chapter_number: 30, chapter_title: 'Winifred', current_ending: 'I need to think, he said.', new_ending: 'He opened it.',
        words: 412, replaced_words: 380, resolved: 'He opens the box.', carried: 'The names change the petition.', new_names: ['Esteban'],
        drafted_at: '2026-10-25T12:00:00Z',
      },
    },
    SERIES.books[1],
  ],
};

const bodyOf = (suffix: string, method = 'PUT') => {
  const call = mockFetch.mock.calls.find(([p, o]) => String(p).endsWith(suffix) && (o as { method?: string })?.method === method);
  expect(call, `no ${method} to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body?: string }).body ?? 'null'));
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (p) => {
    const path = String(p);
    if (path.endsWith('/ending')) return { success: true, data: { series: DRAFTED } } as never;
    return { success: true, data: { series: SERIES } } as never;
  });
});

const render = (series = SERIES) =>
  renderWithProviders(
    <SeriesPanel projectId="p1" series={series} planned planning={false} onPlan={() => {}} stateKey={['publishing', 'p1']} />,
  );

describe('SeriesPanel', () => {
  it('takes a suggested title as the book’s title, saying where it came from', async () => {
    render();
    expect(screen.getByText(/from “the light went pewter”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'The Pewter Light' }));
    await waitFor(() => expect(bodyOf('/series')).toEqual({ titles: { '1': 'The Pewter Light' }, from_suggestion: ['1'] }));
    expect(screen.getByLabelText('Title of book 1')).toHaveValue('The Pewter Light');
  });

  it('says when an ending does not land, and when a title was chosen for other chapters', () => {
    render();
    expect(screen.getByTestId('series-book-1')).toHaveTextContent('this ending does not land as the end of a book');
    expect(screen.getByTestId('series-book-1')).toHaveTextContent('Carries forward: What is in the box?');
    expect(screen.getByTestId('series-book-2')).toHaveTextContent('chosen when the book covered different chapters');
  });

  it('shows a drafted ending beside the current one, flags new names, and applies only on request', async () => {
    render();
    fireEvent.click(screen.getAllByRole('button', { name: 'Draft a closing scene' })[0]);
    await waitFor(() => expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/books/1/ending'))).toBe(true));
    // The parent re-renders with the drafted state.
  });

  it('renders the draft for comparison and sends apply', async () => {
    render(DRAFTED);
    const draft = screen.getByTestId('ending-draft-1');
    expect(draft).toHaveTextContent('412 words replacing the last 380');
    expect(draft).toHaveTextContent('I need to think, he said.');
    expect(draft).toHaveTextContent('He opened it.');
    expect(draft).toHaveTextContent('Names that are not in the book yet: Esteban');
    expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/ending/apply'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use this ending' }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([p, o]) => String(p).endsWith('/books/1/ending/apply') && (o as { method?: string }).method === 'POST')).toBe(true));
  });
});
