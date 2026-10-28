/**
 * Cover — which picture the book is printed with.
 *
 * Every cover generated for the project lands in its gallery. Without a choice the newest one is
 * used, so a picture made to try an idea out would quietly become the cover. Here the author picks
 * one for the whole book and, in a series, one per book; the KDP package, the print files, the EPUB
 * and the landing page all use the choice.
 */

import { Link } from 'react-router-dom';

export interface CoverOption {
  id: string;
  created_at: string;
  url: string | null;
  prompt: string | null;
}

interface Props {
  projectId: string;
  options: CoverOption[];
  /** The whole book's chosen picture, or null for "the newest". */
  chosen: string | null;
  /** Each book's own picture, keyed by volume index as a string. */
  chosenByBook: Record<string, string>;
  /** Book titles in order; one entry means the book is not a series. */
  books: { index: number; title: string }[];
  saving: boolean;
  onChoose: (patch: { cover_image_id?: string | null; cover_image_ids?: Record<string, string | null> }) => void;
}

export default function CoverChooser({ projectId, options, chosen, chosenByBook, books, saving, onChoose }: Props) {
  const effective = chosen ?? options[0]?.id ?? null;
  const isSeries = books.length > 1;

  if (!options.length) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        No cover pictures yet. Generate some from the project’s{' '}
        <Link to={`/projects/${projectId}?tab=outline`} className="text-brand-600 underline">
          Outline
        </Link>{' '}
        (Generate cover art) — they all land in the Art gallery, and you choose one here.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          {chosen
            ? isSeries
              ? 'Chosen for the whole series. A book can have its own below.'
              : 'Chosen. The package, the printed copies, the EPUB and the book’s page use it.'
            : 'Nothing chosen — the newest picture (marked) is used. Click one to choose it.'}
        </p>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Book cover">
          {options.map((o, i) => {
            const selected = o.id === effective;
            return (
              <button
                key={o.id}
                role="radio"
                aria-checked={selected}
                aria-label={`Cover picture from ${new Date(o.created_at).toLocaleString()}`}
                title={o.prompt ?? undefined}
                onClick={() => onChoose({ cover_image_id: o.id })}
                disabled={saving}
                className={`relative w-28 overflow-hidden rounded-lg border-2 text-left disabled:opacity-60 ${
                  selected ? 'border-brand-600 ring-2 ring-brand-300' : 'border-gray-200 hover:border-brand-300 dark:border-gray-700'
                }`}
              >
                {o.url ? (
                  <img src={o.url} alt="" className="aspect-[2/3] w-full object-cover" loading="lazy" />
                ) : (
                  <div className="aspect-[2/3] w-full bg-gray-100 dark:bg-gray-800" />
                )}
                <span className="block px-1.5 py-1 text-[10px] text-gray-500 dark:text-gray-400">
                  {new Date(o.created_at).toLocaleDateString()}
                  {i === 0 ? ' · newest' : ''}
                  {selected ? (chosen ? ' · chosen' : ' · in use') : ''}
                </span>
              </button>
            );
          })}
        </div>
        {chosen ? (
          <button
            onClick={() => onChoose({ cover_image_id: null })}
            disabled={saving}
            className="mt-2 text-xs text-gray-500 underline hover:text-brand-600"
          >
            Clear the choice (use the newest)
          </button>
        ) : null}
      </div>

      {isSeries ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Each book’s cover</h3>
          {books.map((b) => {
            const key = String(b.index);
            const own = chosenByBook[key] ?? '';
            return (
              <label key={key} className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="w-56 truncate">
                  Book {b.index}
                  {b.title ? `: ${b.title}` : ''}
                </span>
                <select
                  aria-label={`Cover for book ${b.index}`}
                  value={own}
                  disabled={saving}
                  onChange={(e) => onChoose({ cover_image_ids: { [key]: e.target.value || null } })}
                  className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">Same as the series</option>
                  {options.map((o, i) => (
                    <option key={o.id} value={o.id}>
                      Picture {options.length - i} · {new Date(o.created_at).toLocaleDateString()}
                      {o.prompt ? ` · ${o.prompt.slice(0, 40)}` : ''}
                    </option>
                  ))}
                </select>
                {own ? (
                  <img
                    src={options.find((o) => o.id === own)?.url ?? ''}
                    alt=""
                    className="h-12 w-8 rounded object-cover"
                  />
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
