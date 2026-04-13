import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import type { ContentIndex } from '../../types/database';

type SourceFilter = 'all' | 'RSS' | 'Reddit' | 'Book' | 'other';

export default function SourceBrowser() {
  const [genreFilter, setGenreFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<SourceFilter>('all');

  const { data: sources, isLoading } = useQuery({
    queryKey: ['source-browser', genreFilter, typeFilter],
    queryFn: async () => {
      let query = supabase
        .from('content_index')
        .select('*')
        .order('scraped_at', { ascending: false })
        .limit(100);

      if (genreFilter) {
        query = query.eq('genre_slug', genreFilter);
      }
      if (typeFilter !== 'all') {
        query = query.eq('source_type', typeFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as ContentIndex[];
    },
  });

  // Get unique genres for filter dropdown
  const { data: genres } = useQuery({
    queryKey: ['source-genres'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('content_index')
        .select('genre_slug')
        .limit(500);
      if (error) throw error;
      const unique = [...new Set((data || []).map((d: { genre_slug: string }) => d.genre_slug))].filter(Boolean).sort();
      return unique as string[];
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Source Browser</h1>
        <span className="text-sm text-gray-400">{sources?.length ?? 0} sources</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <select
          value={genreFilter}
          onChange={(e) => setGenreFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        >
          <option value="">All genres</option>
          {genres?.map((g) => (
            <option key={g} value={g}>{g.replace(/-/g, ' ')}</option>
          ))}
        </select>

        <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
          {(['all', 'RSS', 'Reddit', 'Book'] as SourceFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                typeFilter === t
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {t === 'all' ? 'All Types' : t}
            </button>
          ))}
        </div>
      </div>

      {/* Source list */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32 text-sm text-gray-500">Loading sources...</div>
      ) : !sources?.length ? (
        <div className="flex items-center justify-center h-32 text-sm text-gray-400">No sources found</div>
      ) : (
        <div className="space-y-2">
          {sources.map((src) => (
            <div
              key={src.id}
              className="rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{src.title}</p>
                  {src.summary && (
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{src.summary}</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {src.source_type}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {src.genre_slug?.replace(/-/g, ' ')}
                    </span>
                    {src.feed_name && (
                      <span className="text-[10px] text-gray-400">{src.feed_name}</span>
                    )}
                    <span className="text-[10px] text-gray-400">
                      {new Date(src.scraped_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                {src.source_url && (
                  <a
                    href={src.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs text-brand-600 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
                  >
                    Open
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
