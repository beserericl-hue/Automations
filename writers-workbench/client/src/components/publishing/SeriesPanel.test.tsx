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

  describe('where each book ends', () => {
    const renderBreaks = (onPlanWithBreaks = vi.fn(), breaksByAuthor = false) => {
      renderWithProviders(
        <SeriesPanel
          projectId="p1"
          series={SERIES}
          planned
          planning={false}
          onPlan={() => {}}
          onPlanWithBreaks={onPlanWithBreaks}
          breaksByAuthor={breaksByAuthor}
          stateKey={['publishing', 'p1']}
        />,
      );
      return onPlanWithBreaks;
    };

    it('shows the current break and where the next book begins', () => {
      renderBreaks();
      expect(screen.getByLabelText('Book 1 ends after chapter')).toHaveValue(30);
      expect(screen.getByText('Book 2 begins at chapter 31')).toBeInTheDocument();
      // Nothing changed yet, so there is nothing to re-plan.
      expect(screen.getByRole('button', { name: 'Use these breaks' })).toBeDisabled();
    });

    it('re-plans with the chapters the author typed', () => {
      const onPlan = renderBreaks();
      fireEvent.change(screen.getByLabelText('Book 1 ends after chapter'), { target: { value: '28' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add a break' }));
      fireEvent.change(screen.getByLabelText('Book 2 ends after chapter'), { target: { value: '59' } });
      fireEvent.click(screen.getByRole('button', { name: 'Use these breaks' }));
      expect(onPlan).toHaveBeenCalledWith([28, 59]);
    });

    it('refuses breaks out of order', () => {
      renderBreaks();
      fireEvent.click(screen.getByRole('button', { name: 'Add a break' }));
      fireEvent.change(screen.getByLabelText('Book 2 ends after chapter'), { target: { value: '12' } });
      expect(screen.getByText('Each book must end after the one before it.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use these breaks' })).toBeDisabled();
    });

    it('removing every break makes one book again', () => {
      const onPlan = renderBreaks();
      fireEvent.click(screen.getByRole('button', { name: 'Remove this break' }));
      fireEvent.click(screen.getByRole('button', { name: 'Use these breaks' }));
      expect(onPlan).toHaveBeenCalledWith(null);
    });

    it('hands the choice back to the planner only when the author made it', () => {
      const onPlan = renderBreaks(vi.fn(), true);
      fireEvent.click(screen.getByRole('button', { name: 'Let the planner choose' }));
      expect(onPlan).toHaveBeenCalledWith(null);
    });

    it('has no planner hand-back while the planner chose', () => {
      renderBreaks();
      expect(screen.queryByRole('button', { name: 'Let the planner choose' })).toBeNull();
    });
  });
});

describe('SeriesPanel — the series description has the copy assistant', () => {
  it('drafts into the empty description without saving, and Save sends the author\'s text', async () => {
    const assist = {
      price: 3, charged: true, package_fields: [],
      fields: {
        series_description: { label: 'Series description', kind: 'text', limit: 3000, max_items: null, free: false },
        series_tagline: { label: 'Series tagline', kind: 'text', limit: 200, max_items: null, free: false },
      },
    };
    mockFetch.mockImplementation(async (p) => {
      const path = String(p);
      if (path.endsWith('/copy')) return { success: true, data: { books: {}, also_by: [], assist } } as never;
      if (path.endsWith('/assist')) return { success: true, data: { field: 'series_description', value: 'Three books, one box.', items: [], chars: 21, limit: 3000, over_limit: false, warnings: [], credits_charged: 3 } } as never;
      return { success: true, data: { series: SERIES } } as never;
    });
    render();
    fireEvent.click(await screen.findByTestId('ai-draft-series_description'));
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Three books, one box.'));
    expect(mockFetch.mock.calls.some(([p, o]) => String(p).endsWith('/series') && (o as { method?: string })?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
    await waitFor(() => expect(bodyOf('/series')).toEqual({ description: { text: 'Three books, one box.', tagline: '' } }));
  });
});


describe('closing scene and recap', () => {
  const CODA = {
    chapter_number: 30, chapter_title: 'Winifred', text: 'Renata lifted the binder and read the plot twice.', words: 9, new_names: ['Esteban'],
    hook: 'Someone will lift the binder who is not her.', resolved: 'The secret is no longer Marcus’s alone.', carried: 'What Renata will do.',
    research_topics: ['discovery notice'], drift: { findings: [] }, qa: { story_turn_density: 0.71, character_consistency: 0.95 },
    drafted_at: '2026-11-14T12:00:00Z',
  };
  const WITH_CODA: SeriesView = { ...SERIES, books: [{ ...SERIES.books[0], coda_draft: CODA }, SERIES.books[1]] };

  it('starts the engine job for a closing scene with the author’s direction, and offers a recap only for a later book', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, jobId: 'j1' }) as never);
    render();
    expect(screen.getByTestId('coda-1')).toBeInTheDocument();
    expect(screen.queryByTestId('recap-1')).toBeNull(); // the first book has nothing to recap
    expect(screen.queryByTestId('coda-2')).toBeNull(); // the last book needs no cliffhanger
    expect(screen.getByTestId('recap-2')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('coda-1-direction'), { target: { value: 'End on the survey plot.' } });
    fireEvent.click(screen.getByTestId('coda-1-draft'));
    await waitFor(() => expect(bodyOf('/books/1/coda', 'POST')).toEqual({ direction: 'End on the survey plot.' }));
  });

  it('shows what the engine checked, lets the author edit the words, and adds it to the book only on request', async () => {
    mockFetch.mockImplementation(async (p, o) => {
      const path = String(p);
      const method = (o as { method?: string } | undefined)?.method;
      if (path.endsWith('/coda') && method === 'PUT') return { success: true, data: { series: WITH_CODA } } as never;
      if (path.endsWith('/coda/apply')) return { success: true, data: { series: WITH_CODA } } as never;
      return { success: true, data: { series: SERIES } } as never;
    });
    render(WITH_CODA);
    expect(screen.getByText(/Ends on: Someone will lift the binder/)).toBeInTheDocument();
    expect(screen.getByText(/Researched: discovery notice/)).toBeInTheDocument();
    expect(screen.getByText(/Drift check: no drift found/)).toBeInTheDocument();
    expect(screen.getByText(/Esteban/)).toBeInTheDocument();
    // Nothing is added by drafting; the author's edits must be saved before it can be added.
    const box = screen.getByTestId('coda-1-text');
    fireEvent.change(box, { target: { value: 'Renata lifted the binder. The dead were all on the wrong side of the line.' } });
    expect(screen.getByTestId('coda-1-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('coda-1-save'));
    await waitFor(() =>
      expect(bodyOf('/books/1/coda')).toEqual({ text: 'Renata lifted the binder. The dead were all on the wrong side of the line.' }),
    );
    fireEvent.change(box, { target: { value: CODA.text } });
    fireEvent.click(screen.getByTestId('coda-1-apply'));
    await waitFor(() => expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/books/1/coda/apply'))).toBe(true));
  });

  it('adds a scene the check objects to only after the author confirms having read it', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, data: { series: WITH_CODA } }) as never);
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, problems: ['page 211 does not exist'] } }, SERIES.books[1]] });
    expect(screen.getByTestId('coda-1-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('coda-1-anyway'));
    // Not yet: the confirmation has to be ticked first.
    expect(screen.getByTestId('coda-1-anyway-go')).toBeDisabled();
    fireEvent.click(document.getElementById('coda-1-read-it') as HTMLElement);
    fireEvent.click(screen.getByTestId('coda-1-anyway-go'));
    await waitFor(() => expect(bodyOf('/books/1/coda/apply', 'POST')).toEqual({ override: true }));
  });

  it('shows a closing scene already in the book as read-only', () => {
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, applied_at: '2026-11-14T13:00:00Z' } }, SERIES.books[1]] });
    expect(screen.getByText(/In the book since/)).toBeInTheDocument();
    expect(screen.getByTestId('coda-1-text')).toHaveAttribute('readonly');
    expect(screen.queryByTestId('coda-1-apply')).toBeNull();
  });

  it('says why the engine could not make one, and offers to try again or clear the message', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, jobId: 'j9' }) as never);
    render({ ...SERIES, books: [{ ...SERIES.books[0], coda_draft: { ...CODA, text: '', failed: 'the scene came back 1700 words twice', words: 0 } }, SERIES.books[1]] });
    expect(screen.getByTestId('coda-1-failed')).toHaveTextContent('the scene came back 1700 words twice');
    expect(screen.queryByTestId('coda-1-apply')).toBeNull();
    expect(screen.getByTestId('coda-1-clear')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('coda-1-draft'));
    await waitFor(() => expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/books/1/coda'))).toBe(true));
  });

  it('lists what is already inconsistent in the book, apart from the scene', () => {
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, existing_inconsistencies: ["the lawyer is 'Okafor' in chapter 5 and 'Okonkwo' in chapter 25"] } }, SERIES.books[1]] });
    expect(screen.getByTestId('coda-1-existing')).toHaveTextContent("Okafor' in chapter 5");
    expect(screen.getByTestId('coda-1-existing')).toHaveTextContent('not caused by this scene');
  });

  it('blocks a scene the check objects to, lists what to fix, and offers to check it again', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, jobId: 'jc' }) as never);
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, problems: ['the original journal is not in a sub-basement'] } }, SERIES.books[1]] });
    expect(screen.getByTestId('coda-1-problems')).toHaveTextContent('sub-basement');
    expect(screen.getByTestId('coda-1-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('coda-1-check'));
    await waitFor(() => expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/books/1/coda/check'))).toBe(true));
  });

  it('asks for a check after an edit, and the author must save the edit first', () => {
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, problems: [], needs_check: true } }, SERIES.books[1]] });
    expect(screen.getByTestId('coda-1-unchecked')).toBeInTheDocument();
    expect(screen.getByTestId('coda-1-apply')).toBeDisabled();
    fireEvent.change(screen.getByTestId('coda-1-text'), { target: { value: 'More edits, not yet saved.' } });
    expect(screen.getByTestId('coda-1-check')).toBeDisabled();
  });

  it('lets a checked, clean scene be added', () => {
    render({ ...WITH_CODA, books: [{ ...WITH_CODA.books[0], coda_draft: { ...CODA, problems: [], needs_check: false } }, SERIES.books[1]] });
    expect(screen.queryByTestId('coda-1-check')).toBeNull();
    expect(screen.getByTestId('coda-1-apply')).not.toBeDisabled();
  });
});
