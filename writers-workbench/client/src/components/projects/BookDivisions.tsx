/**
 * Where the books divide, shown in the chapter list, and the controls to move them.
 *
 * A long manuscript is sold as several books, and where one ends is the author's call: the last chapter
 * of a book is where the reader decides whether to buy the next. So the divisions are shown where the
 * chapters are, each book with its title, chapter range and size, the chapter that ends it marked, and a
 * way to end a book at a different chapter or open that ending for review.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';
import type { SeriesBook, SeriesView } from '../publishing/SeriesPanel';

interface PublishingSlice {
  series?: SeriesView;
  settings?: { breaks?: number[] | null };
}

/** The project's books, from the same query the Publish tab uses, so the two never disagree. */
export function useBooks(projectId: string) {
  const { data } = useQuery({
    queryKey: ['publishing', projectId],
    queryFn: async () => (await apiFetch<ApiEnvelope<PublishingSlice>>(`/api/publishing/project/${projectId}`)).data!,
  });
  const books = data?.series?.books ?? [];
  return { books: books.length > 1 ? books : [], seriesName: data?.series?.name ?? '' };
}

export function bookOf(books: SeriesBook[], chapterNumber: number | null | undefined): SeriesBook | undefined {
  if (chapterNumber == null) return undefined;
  return books.find((b) => chapterNumber >= b.first_chapter && chapterNumber <= b.last_chapter);
}

export function BookHeaderRow({ book, total, colSpan }: { book: SeriesBook; total: number; colSpan: number }) {
  const coda = book.coda_draft;
  const codaState = !coda ? null : coda.applied_at ? 'closing scene added' : 'closing scene drafted';
  return (
    <tr data-testid={`book-header-${book.index}`} className="bg-brand-50 dark:bg-brand-950/40">
      <td colSpan={colSpan} className="px-4 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
            Book {book.index} of {total}
          </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-white">{book.title || 'Untitled book'}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            chapters {book.first_chapter} to {book.last_chapter}
            {book.estimated_pages ? ` · about ${book.estimated_pages.toLocaleString()} pages` : ''}
            {codaState ? ` · ${codaState}` : ''}
          </span>
        </div>
      </td>
    </tr>
  );
}

/**
 * On a chapter row: whether a book ends here, to end one here instead, and to review how it ends.
 * Moving a break re-plans the books and re-reads each ending, so it asks first.
 */
export function BookEndControls({
  projectId,
  chapterNumber,
  books,
  userId,
  trackJob,
}: {
  projectId: string;
  chapterNumber: number;
  books: SeriesBook[];
  userId?: string;
  trackJob: (key: string, jobId: string, invalidate?: (readonly unknown[])[]) => void;
}) {
  const { addToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const breaks = books.slice(0, -1).map((b) => b.last_chapter);
  const endsBook = books.find((b) => b.last_chapter === chapterNumber);
  const isLast = books[books.length - 1]?.last_chapter === chapterNumber;

  const replan = useMutation({
    mutationFn: async (next: number[]) =>
      (
        await apiFetch<{ jobId?: string }>(`/api/publishing/project/${projectId}/volumes/plan`, {
          method: 'POST',
          body: JSON.stringify({ breaks: next, judge_endings: true }),
        })
      ).jobId,
    onSuccess: (jobId) => {
      setConfirming(false);
      if (jobId) trackJob(`${projectId}:volumes`, jobId, [['publishing', projectId], ['publishing-readiness', projectId], ['project-chapters', projectId]]);
      addToast('Re-planning the books and reading each ending. The list updates when it finishes.', 'info');
    },
    onError: (err: Error) => addToast(err.message || 'Could not move the break', 'error'),
  });

  void userId;
  if (isLast) return null;
  const next = endsBook ? breaks.filter((b) => b !== chapterNumber) : [...breaks, chapterNumber].sort((a, b) => a - b);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {endsBook && (
        <Link
          to={`/projects/${projectId}/books/${endsBook.index}/ending`}
          data-testid={`review-ending-${endsBook.index}`}
          className="rounded-lg border border-violet-300 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 whitespace-nowrap dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950"
          title="Read this book's ending, get recommended text and a cliffhanger, and run it through the humanizer"
        >
          Review ending
        </Link>
      )}
      {confirming ? (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          {endsBook ? `Stop Book ${endsBook.index} ending here?` : 'End a book here?'} This re-plans the books.
          <button
            data-testid={`break-confirm-${chapterNumber}`}
            disabled={replan.isPending || (!endsBook && breaks.length >= 7)}
            onClick={() => replan.mutate(next)}
            className="rounded-lg bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {replan.isPending ? 'Starting…' : 'Yes'}
          </button>
          <button onClick={() => setConfirming(false)} className="rounded-lg border border-gray-300 px-2 py-1 text-xs dark:border-gray-600">
            No
          </button>
        </span>
      ) : (
        <button
          data-testid={`break-toggle-${chapterNumber}`}
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 whitespace-nowrap dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          title={endsBook ? `Book ${endsBook.index} ends at this chapter. Stop ending it here.` : 'End a book at this chapter'}
        >
          {endsBook ? `Ends Book ${endsBook.index} · change` : 'End a book here'}
        </button>
      )}
    </div>
  );
}

/**
 * On the chapter's own page: which book it is in, and, when it is the book's last chapter, how that book
 * ends. The same controls as the chapter list, so the author can decide where a book ends and review
 * how it ends from the chapter they are reading.
 */
export function ChapterBookBanner({ projectId, chapterNumber, userId }: { projectId: string; chapterNumber: number; userId?: string }) {
  const { books } = useBooks(projectId);
  const { trackJob } = useEngineJobQueue(userId, projectId);
  const book = bookOf(books, chapterNumber);
  if (!book) return null;
  const endsBook = book.last_chapter === chapterNumber && book.index < books.length;
  return (
    <div
      data-testid="chapter-book-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs dark:border-brand-900 dark:bg-brand-950/40"
    >
      <span className="font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
        Book {book.index} of {books.length}
      </span>
      <span className="font-medium text-gray-900 dark:text-white">{book.title || 'Untitled book'}</span>
      <span className="text-gray-500 dark:text-gray-400">
        chapters {book.first_chapter} to {book.last_chapter}
        {endsBook ? ' · this chapter ends the book' : ''}
      </span>
      <BookEndControls projectId={projectId} chapterNumber={chapterNumber} books={books} userId={userId} trackJob={trackJob} />
    </div>
  );
}
