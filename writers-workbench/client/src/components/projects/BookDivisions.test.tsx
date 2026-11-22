import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import { apiFetch } from '../../lib/api';
import { BookHeaderRow, BookEndControls, ChapterBookBanner, bookOf } from './BookDivisions';
import type { SeriesBook } from '../publishing/SeriesPanel';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const book = (index: number, first: number, last: number, extra: Partial<SeriesBook> = {}): SeriesBook => ({
  index, first_chapter: first, last_chapter: last, title: `Book ${index} title`, title_source: 'edited', title_stale: false,
  suggestions: [], ending_draft: null, ...extra,
});
const BOOKS = [book(1, 0, 29, { estimated_pages: 598 }), book(2, 30, 59), book(3, 60, 95)];

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ jobId: 'j1' } as never);
});

describe('book divisions in the chapter list', () => {
  it('finds the book a chapter is in, including the prologue', () => {
    expect(bookOf(BOOKS, 0)?.index).toBe(1);
    expect(bookOf(BOOKS, 30)?.index).toBe(2);
    expect(bookOf(BOOKS, 95)?.index).toBe(3);
    expect(bookOf(BOOKS, 999)).toBeUndefined();
  });

  it('shows each book with its title, range and size', () => {
    renderWithProviders(<table><tbody><BookHeaderRow book={BOOKS[0]} total={3} colSpan={7} /></tbody></table>);
    const row = screen.getByTestId('book-header-1');
    expect(row).toHaveTextContent('Book 1 of 3');
    expect(row).toHaveTextContent('Book 1 title');
    expect(row).toHaveTextContent('chapters 0 to 29');
    expect(row).toHaveTextContent('about 598 pages');
  });

  it('offers Review ending on the chapter that ends a book, and not on the last book', () => {
    renderWithProviders(
      <>
        <BookEndControls projectId="p1" chapterNumber={29} books={BOOKS} trackJob={vi.fn()} />
        <BookEndControls projectId="p1" chapterNumber={95} books={BOOKS} trackJob={vi.fn()} />
      </>,
    );
    expect(screen.getByTestId('review-ending-1')).toHaveAttribute('href', '/projects/p1/books/1/ending');
    expect(screen.queryByTestId('break-toggle-95')).toBeNull();
  });

  it('asks before ending a book at another chapter, then re-plans with every break', async () => {
    const trackJob = vi.fn();
    renderWithProviders(
      <>
        <BookEndControls projectId="p1" chapterNumber={40} books={BOOKS} trackJob={trackJob} />
      </>,
    );
    fireEvent.click(screen.getByTestId('break-toggle-40'));
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('break-confirm-40'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [path, init] = mockFetch.mock.calls[0];
    expect(String(path)).toBe('/api/publishing/project/p1/volumes/plan');
    expect(JSON.parse(String((init as { body: string }).body))).toEqual({ breaks: [29, 40, 59], judge_endings: true });
    await waitFor(() => expect(trackJob).toHaveBeenCalledWith('p1:volumes', 'j1', expect.any(Array)));
  });

  it('removes a break when asked to stop ending a book where it ends', async () => {
    renderWithProviders(
      <>
        <BookEndControls projectId="p1" chapterNumber={59} books={BOOKS} trackJob={vi.fn()} />
      </>,
    );
    fireEvent.click(screen.getByTestId('break-toggle-59'));
    fireEvent.click(screen.getByTestId('break-confirm-59'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(JSON.parse(String((mockFetch.mock.calls[0][1] as { body: string }).body)).breaks).toEqual([29]);
  });
});

describe('the book banner on a chapter\'s own page', () => {
  const serve = () =>
    mockFetch.mockImplementation(async (path: string) =>
      String(path) === '/api/publishing/project/p1' ? ({ success: true, data: { series: { name: 'S', books: BOOKS } } } as never) : ({ jobId: 'j1' } as never),
    );

  it('says which book the chapter is in, and offers to end a book here', async () => {
    serve();
    renderWithProviders(<ChapterBookBanner projectId="p1" chapterNumber={12} />);
    const banner = await screen.findByTestId('chapter-book-banner');
    expect(banner).toHaveTextContent('Book 1 of 3');
    expect(banner).toHaveTextContent('Book 1 title');
    expect(banner).toHaveTextContent('chapters 0 to 29');
    expect(screen.getByTestId('break-toggle-12')).toBeInTheDocument();
    expect(screen.queryByTestId('review-ending-1')).toBeNull();
  });

  it('on the last chapter of a book, says so and links to the ending review', async () => {
    serve();
    renderWithProviders(<ChapterBookBanner projectId="p1" chapterNumber={29} />);
    const banner = await screen.findByTestId('chapter-book-banner');
    expect(banner).toHaveTextContent('this chapter ends the book');
    expect(screen.getByTestId('review-ending-1')).toHaveAttribute('href', '/projects/p1/books/1/ending');
  });

  it('shows nothing for a manuscript that is one book', async () => {
    mockFetch.mockImplementation(async () => ({ success: true, data: { series: { name: 'S', books: [BOOKS[0]] } } }) as never);
    const { container } = renderWithProviders(<ChapterBookBanner projectId="p1" chapterNumber={12} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="chapter-book-banner"]')).toBeNull();
  });
});
