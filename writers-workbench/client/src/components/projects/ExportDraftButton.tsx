/**
 * Export Draft: a hard copy of the outline or of the whole manuscript, as a Word document.
 *
 * Not a publishing export. The outline draft has the premise, characters, every chapter and every
 * chapter's outline. The manuscript draft lists the chapter titles, then every chapter in full,
 * whatever its status.
 */
import { useState } from 'react';
import type { SeriesBook } from '../publishing/SeriesPanel';
import { supabase } from '../../config/supabase';
import { useToast } from '../../contexts/ToastContext';

export type DraftPart = 'outline' | 'manuscript';

/** The file name the server sent, or a fallback. */
function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  return m ? m[1] : fallback;
}

export default function ExportDraftButton({ projectId, part, books = [] }: { projectId: string; part: DraftPart; books?: SeriesBook[] }) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const what = part === 'outline' ? 'outline' : 'manuscript';

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);

  /** Build and download the draft; `only` limits the manuscript to those books of the series. */
  const run = async (only: number[] = []) => {
    setBusy(true);
    setOpen(false);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/export/project/${projectId}/draft/${part}${only.length ? `?books=${only.join(',')}` : ''}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
        throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || 'Could not build the draft');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameOf(res.headers.get('Content-Disposition'), `${part}_draft.docx`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast(
        only.length ? `${only.length === 1 ? `Book ${only[0]}` : `Books ${only.join(', ')}`} is downloading as a Word document.` : `The ${what} draft is downloading as a Word document.`,
        'success',
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not build the draft', 'error');
    } finally {
      setBusy(false);
    }
  };

  const label = busy ? 'Building the document…' : 'Export Draft';
  const btn =
    'rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';

  // Outline, or a manuscript that is a single book: one button.
  if (part === 'outline' || books.length < 2) {
    return (
      <button
        type="button"
        data-testid={`export-draft-${part}`}
        onClick={() => run()}
        disabled={busy}
        title={
          part === 'outline'
            ? 'Download the complete outline and every chapter outline as a Word document'
            : 'Download the chapter titles and the complete manuscript as a Word document'
        }
        className={btn}
      >
        {label}
      </button>
    );
  }

  // A series: the whole manuscript, one book, or any set of books.
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
  return (
    <div className="relative">
      <button type="button" data-testid="export-draft-manuscript" onClick={() => setOpen((o) => !o)} disabled={busy} aria-expanded={open} className={btn}>
        {label} ▾
      </button>
      {open && (
        <div
          data-testid="export-draft-menu"
          className="absolute right-0 z-20 mt-1 w-96 rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <button
            type="button"
            data-testid="export-draft-all"
            onClick={() => run()}
            className="w-full rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900"
          >
            Whole manuscript (all {books.length} books)
          </button>
          <p className="mt-3 text-xs font-medium text-gray-500 dark:text-gray-400">Or pick books. Tick one or more, or export a single book.</p>
          <ul className="mt-1 max-h-72 space-y-1 overflow-y-auto">
            {books.map((b) => (
              <li key={b.index} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-gray-800">
                <input
                  type="checkbox"
                  id={`draft-book-${b.index}`}
                  data-testid={`export-draft-book-${b.index}`}
                  checked={picked.includes(b.index)}
                  onChange={() => toggle(b.index)}
                />
                <label htmlFor={`draft-book-${b.index}`} className="min-w-0 flex-1 cursor-pointer text-xs text-gray-700 dark:text-gray-300">
                  <span className="font-medium">Book {b.index}</span>
                  {b.title ? `: ${b.title}` : ''}
                  <span className="block text-gray-500 dark:text-gray-400">
                    Chapters {b.first_chapter}–{b.last_chapter}
                  </span>
                </label>
                <button
                  type="button"
                  data-testid={`export-draft-only-${b.index}`}
                  onClick={() => run([b.index])}
                  className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Export this book
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-gray-500 underline" onClick={() => setPicked(picked.length === books.length ? [] : books.map((b) => b.index))}>
              {picked.length === books.length ? 'Clear' : 'Select all'}
            </button>
            <button
              type="button"
              data-testid="export-draft-selected"
              disabled={!picked.length}
              onClick={() => run(picked)}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {picked.length ? `Export ${picked.length} selected book${picked.length === 1 ? '' : 's'}` : 'Export selected books'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
