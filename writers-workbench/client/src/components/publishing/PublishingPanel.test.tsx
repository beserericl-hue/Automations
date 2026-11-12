/**
 * The Publish tab's copy assistant: "Draft all missing" shows its total first, drafts only the empty
 * fields, and the author's save sends the listing to the listing route and the subtitle / inside flap
 * to book_copy_v2. Fails on the code before this change (no such button, no subtitle or flap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent, within } from '../../test/test-utils';
import PublishingPanel from './PublishingPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('./PrintCopies', () => ({ default: () => null }));
const mockFetch = vi.mocked(apiFetch);

const SETTINGS = {
  trim: '6x9', paper: 'cream', volume_count: null, why_this_book: '', publisher: '', isbns: {}, dedication: '', epigraph: '',
  epigraph_attribution: '', authors_note: '', acknowledgements: '', body_size: 11, breaks: null, cover_image_id: null, cover_image_ids: {},
};
const STATE = {
  project: { id: 'p1', title: 'The Clockwork Rebellion', genre_slug: 'political-scifi' },
  settings: SETTINGS,
  volume_plan: null,
  series: { name: 'The Clockwork Rebellion', name_is_default: true, description: null, suggested_at: null, books: [] },
  // The author already wrote the description; everything else in the package is empty.
  marketing: { '1': { blurb: 'My own description.', keywords: [], categories: [], comparable_titles: [] } },
  marketing_history: [],
  author: { pen_name: 'R. T. Testwell', bio: '', bio_source: null, profile_why_this_book: '' },
  chapters: { total: 21, approved: 3 },
  cover_art: null,
  cover_options: [],
  trim_options: [{ trim: '6x9', w: 6, h: 9 }],
  paper_options: ['cream', 'white'],
};
const field = (label: string, kind: 'text' | 'list' = 'text', limit = 4000, max_items: number | null = null) => ({ label, kind, limit, max_items, free: false });
const COPY = {
  books: {},
  also_by: [],
  assist: {
    price: 3,
    charged: true,
    package_fields: ['blurb', 'back_cover', 'hook', 'keywords', 'categories', 'comparable_titles', 'subtitle', 'inside_flap'],
    fields: {
      blurb: field('Description'), back_cover: field('Back cover', 'text', 1000), hook: field('Hook', 'text', 200),
      keywords: field('Keywords', 'list', 50, 7), categories: field('Categories', 'list', 150, 3), comparable_titles: field('Comparable titles', 'list', 200, 6),
      subtitle: field('Subtitle', 'text', 175), inside_flap: field('Inside flap', 'text', 1800),
      dedication: field('Dedication', 'text', 300), epigraph: field('Epigraph', 'text', 400), authors_note: field("Author's note", 'text', 6000),
      acknowledgements: field('Acknowledgements', 'text', 3000), why_this_book: field('Why this book', 'text', 1500),
      author_bio: field('About the author', 'text', 1500), also_by: { ...field('Also by', 'list', 200, 20), free: true },
    },
  },
};
const drafted = (value: string, items: string[] = []) => ({ field: '', value, items, chars: value.length, limit: 4000, over_limit: false, warnings: [], credits_charged: 3 });

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (p, o) => {
    const path = String(p);
    const method = (o as { method?: string } | undefined)?.method ?? 'GET';
    if (path === '/api/publishing/project/p1') return { success: true, data: STATE } as never;
    if (path.endsWith('/readiness')) return { success: true, data: { ready: false, blockers: [], gaps: [], volume_count: 1, trim: '6x9' } } as never;
    if (path === '/api/copy-assist/project/p1/copy') return { success: true, data: COPY } as never;
    if (path.endsWith('/assist/all') && method === 'POST') {
      return {
        success: true,
        data: {
          results: {
            back_cover: drafted('Cogwheel wakes.'),
            hook: drafted('A machine built to obey.'),
            keywords: drafted('steampunk\nvictorian london', ['steampunk', 'victorian london']),
            subtitle: drafted('A Novel'),
            inside_flap: drafted('London, 1888.'),
            categories: drafted('Fiction > Steampunk', ['Fiction > Steampunk']),
            comparable_titles: drafted('The Difference Engine by William Gibson and Bruce Sterling', ['The Difference Engine by William Gibson and Bruce Sterling']),
          },
          errors: {},
          credits_charged: 21,
          credits_remaining: 79,
        },
      } as never;
    }
    return { success: true, data: {} } as never;
  });
});

const calls = (suffix: string, method: string) =>
  mockFetch.mock.calls.filter(([p, o]) => String(p).endsWith(suffix) && (o as { method?: string } | undefined)?.method === method);

describe('Publish tab — Draft all missing', () => {
  it('shows the total for the EMPTY fields first, drafts only those, and saves to both stores on Save', async () => {
    renderWithProviders(<PublishingPanel projectId="p1" userId="u1" />);
    fireEvent.click(await screen.findByTestId('draft-all-missing'));

    const confirm = await screen.findByTestId('draft-all-confirm');
    // 8 package fields, the description already written: 7 x 3 credits.
    expect(within(confirm).getByTestId('draft-all-total')).toHaveTextContent('21 credits');
    expect(confirm).not.toHaveTextContent('Description');
    expect(calls('/assist/all', 'POST')).toHaveLength(0);

    fireEvent.click(within(confirm).getByTestId('draft-all-go'));
    await waitFor(() => expect(screen.getByLabelText('Hook')).toHaveValue('A machine built to obey.'));
    const body = JSON.parse(String((calls('/assist/all', 'POST')[0][1] as { body: string }).body));
    expect(body).toEqual({ volume_index: null, fields: ['back_cover', 'hook', 'keywords', 'categories', 'comparable_titles', 'subtitle', 'inside_flap'], expected_cost: 21 });
    // The author's description is untouched; nothing has been saved yet.
    expect(screen.getByLabelText('Description')).toHaveValue('My own description.');
    expect(calls('/marketing', 'PUT')).toHaveLength(0);

    // Undo works on a batch-drafted field too.
    fireEvent.click(screen.getByTestId('ai-undo-hook'));
    expect(screen.getByLabelText('Hook')).toHaveValue('');

    fireEvent.click(screen.getByText('Save my version'));
    await waitFor(() => expect(calls('/copy-assist/project/p1/copy', 'PUT')).toHaveLength(1));
    const listing = JSON.parse(String((calls('/marketing', 'PUT')[0][1] as { body: string }).body));
    expect(listing).toMatchObject({ blurb: 'My own description.', hook: '', keywords: ['steampunk', 'victorian london'] });
    const copy = JSON.parse(String((calls('/copy-assist/project/p1/copy', 'PUT')[0][1] as { body: string }).body));
    expect(copy).toEqual({ volume_index: null, subtitle: 'A Novel', inside_flap: 'London, 1888.', generated: ['subtitle', 'inside_flap'] });
  });

  it('every front- and back-matter field the author writes has the assistant', async () => {
    renderWithProviders(<PublishingPanel projectId="p1" userId="u1" />);
    for (const f of ['dedication', 'epigraph', 'authors_note', 'acknowledgements', 'why_this_book', 'also_by', 'author_bio']) {
      expect(await screen.findByTestId(`ai-draft-${f}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('ai-draft-also_by')).toHaveTextContent('Fill from my projects');
  });
});

describe('Publish tab — the missing-description blocker', () => {
  it('takes the author to the description box: one button on the blocker opens the editor', async () => {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (p, o) => {
      const path = String(p);
      if (path === '/api/publishing/project/p1') return { success: true, data: { ...STATE, marketing: {} } } as never;
      if (path.endsWith('/readiness')) {
        return { success: true, data: { ready: false, blockers: ['no listing copy — KDP will not accept a book with no description'], gaps: [], volume_count: 1, trim: '6x9' } } as never;
      }
      return base(p, o);
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    renderWithProviders(<PublishingPanel projectId="p1" userId="u1" />);
    expect(screen.queryByTestId('listing-editor')).toBeNull();
    fireEvent.click(await screen.findByTestId('write-description'));
    const editor = await screen.findByTestId('listing-editor');
    expect(within(editor).getByLabelText('Description')).toHaveValue('');
  });
});
