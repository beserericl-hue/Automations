/**
 * Finding real photographs for a project, and putting them in its image archive.
 *
 * Everything else here invents a picture. This one looks for pictures that were actually taken,
 * which only has value if each one can be traced to the institution holding the original — so every
 * result shows the archive, the photographer, the date, the catalogue reference and the licence,
 * with a link to the record itself.
 *
 * The rights distinction is the whole design. Openly licensed photographs can be saved into the
 * project. Anything whose record does not state an open licence is shown with its catalogue link
 * and cannot be saved, because saving means holding a copy and that is a decision to take with the
 * archive rather than on the author's behalf. Hiding those results would be worse: knowing a
 * photograph exists, and where, is most of the research.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

type ArchiveId = 'wikimedia' | 'loc' | 'smithsonian';

interface ArchiveImage {
  source: ArchiveId;
  source_id: string;
  title: string;
  description: string;
  creator: string;
  date_taken: string;
  institution: string;
  collection_ref: string;
  license: string;
  license_url: string;
  source_page_url: string;
  image_url: string;
  thumb_url: string;
  width: number | null;
  height: number | null;
  reuse: 'open' | 'check';
}

interface SearchResult {
  images: ArchiveImage[];
  sources: { source: ArchiveId; searched: boolean; found: number; note?: string }[];
}

const ARCHIVE_LABELS: Record<ArchiveId, string> = {
  wikimedia: 'Wikimedia Commons',
  loc: 'Library of Congress',
  smithsonian: 'Smithsonian',
};

export default function ArchiveImageSearch({
  projectId,
  suggestions = [],
}: {
  projectId: string;
  suggestions?: string[];
}) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const search = useMutation({
    mutationFn: async (q: string) => {
      const res = await apiFetch<ApiEnvelope<SearchResult>>(
        `/api/publishing/project/${projectId}/image-search`,
        { method: 'POST', body: JSON.stringify({ q }) },
      );
      return res.data!;
    },
    onSuccess: (data) => setResult(data),
    onError: (err: Error) => addToast(err.message || 'Search failed', 'error'),
  });

  const save = useMutation({
    mutationFn: async (image: ArchiveImage) => {
      await apiFetch(`/api/publishing/project/${projectId}/images`, {
        method: 'POST',
        body: JSON.stringify({
          source: image.source,
          source_id: image.source_id,
          image_url: image.image_url,
          title: image.title,
          description: image.description,
          creator: image.creator,
          date_taken: image.date_taken,
          institution: image.institution,
          collection_ref: image.collection_ref,
          license: image.license,
          license_url: image.license_url,
          source_page_url: image.source_page_url,
          reuse: image.reuse,
        }),
      });
      return image.source_id;
    },
    onSuccess: (id) => {
      setSaved((s) => new Set(s).add(id));
      void queryClient.invalidateQueries({ queryKey: ['project-images'] });
      void queryClient.invalidateQueries({ queryKey: ['images'] });
      addToast('Saved to the project image archive', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not save', 'error'),
  });

  const run = (q: string): void => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setQuery(trimmed);
    search.mutate(trimmed);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 dark:border-gray-800 dark:bg-gray-900">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Find real photographs
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Searches named archives for photographs that were actually taken — not generated. Each
            result shows who holds the original, who took it, when, and under what licence.
          </p>
        </div>

        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run(query);
            }}
            placeholder="Turkey Tayac Piscataway"
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          />
          <button
            onClick={() => run(query)}
            disabled={search.isPending || query.trim().length < 2}
            className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {search.isPending ? 'Searching…' : 'Search archives'}
          </button>
        </div>

        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => run(s)}
                className="rounded-full border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Which archives answered. An archive that failed must not look like one with no results. */}
        {result && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {result.sources.map((s) => (
              <span key={s.source}>
                <span className="font-medium">{ARCHIVE_LABELS[s.source]}:</span>{' '}
                {!s.searched ? (
                  <span className="text-amber-700 dark:text-amber-400">not searched — {s.note}</span>
                ) : s.note ? (
                  <span className="text-red-600 dark:text-red-400">{s.note}</span>
                ) : (
                  `${s.found} result${s.found === 1 ? '' : 's'}`
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* A standing caveat, not a per-search one. The Smithsonian's search API serves museum
          objects and specimens; its ARCHIVES — where photographs of people usually are — are not in
          it, with or without a key. Saying so here saves the author concluding a photograph does
          not exist when it does. */}
      {result?.sources.some((s) => s.source === 'smithsonian' && s.searched) && (
        <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
          The Smithsonian results above are <strong>museum objects</strong>. Its archives — the
          National Anthropological Archives, the Eliot Elisofon Photographic Archives, the Human
          Studies Film Archives — are not in this API and have to be searched by hand at{' '}
          <a
            href="https://sova.si.edu"
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 underline dark:text-brand-400"
          >
            sova.si.edu
          </a>
          . That is where photo lots of people generally live.
        </p>
      )}

      {result && result.images.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nothing in those archives matched. That is an answer about the archives, not about the
          subject — a photograph can exist and not be catalogued online.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {(result?.images ?? []).map((img) => {
          const isSaved = saved.has(img.source_id);
          return (
            <div
              key={`${img.source}:${img.source_id}`}
              className="flex gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
            >
              {img.thumb_url ? (
                <img
                  src={img.thumb_url}
                  alt={img.title}
                  loading="lazy"
                  className="h-24 w-24 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] text-gray-400 dark:bg-gray-800">
                  no preview
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-xs font-semibold text-gray-900 dark:text-white">
                  {img.title}
                </p>
                <dl className="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-400">
                  {img.institution && <Row label="Held by" value={img.institution} />}
                  {img.collection_ref && <Row label="Collection" value={img.collection_ref} />}
                  {img.creator && <Row label="By" value={img.creator} />}
                  {img.date_taken && <Row label="Date" value={img.date_taken} />}
                </dl>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      img.reuse === 'open'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                    }`}
                  >
                    {img.license || 'licence not stated'}
                  </span>
                  {img.source_page_url && (
                    <a
                      href={img.source_page_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-600 underline hover:text-brand-700 dark:text-brand-400"
                    >
                      catalogue record
                    </a>
                  )}
                </div>
                <div className="mt-2">
                  {img.reuse === 'open' ? (
                    <button
                      onClick={() => save.mutate(img)}
                      disabled={isSaved || save.isPending}
                      className="rounded border border-brand-300 px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
                    >
                      {isSaved ? 'In the archive ✓' : 'Add to project archive'}
                    </button>
                  ) : (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      Permission needed before this can be stored or printed — ask the holding
                      institution, then add it with the licence they give you.
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}
