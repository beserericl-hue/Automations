import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import GenreForm from './GenreForm';
import type { GenreConfig } from '../../types/database';

export default function GenreList() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();
  const [editingGenre, setEditingGenre] = useState<GenreConfig | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: genres, isLoading } = useQuery({
    queryKey: ['genres', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('genre_config_v2')
        .select('*')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order('genre_name');
      if (error) throw error;
      return data as GenreConfig[];
    },
    enabled: !!userId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('genre_config_v2').delete().eq('id', id).eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['genres'] }),
  });

  const publicGenres = genres?.filter(g => g.user_id === null) || [];
  const privateGenres = genres?.filter(g => g.user_id !== null) || [];

  if (editingGenre || creating) {
    return (
      <GenreForm
        genre={editingGenre}
        onClose={() => { setEditingGenre(null); setCreating(false); }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Genres</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + New Genre
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : (
        <>
          {/* Private genres */}
          {privateGenres.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Your Genres</h2>
              <div className="space-y-3">
                {privateGenres.map(genre => (
                  <GenreCard
                    key={genre.id}
                    genre={genre}
                    editable
                    onEdit={() => setEditingGenre(genre)}
                    onDelete={() => { if (confirm(`Delete "${genre.genre_name}"?`)) deleteMutation.mutate(genre.id); }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Public genres */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Public Genres ({publicGenres.length})</h2>
            <div className="space-y-3">
              {publicGenres.map(genre => (
                <GenreCard key={genre.id} genre={genre} editable={false} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GenreCard({
  genre, editable, onEdit, onDelete,
}: {
  genre: GenreConfig;
  editable: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">{genre.genre_name}</span>
            <span className="text-xs text-gray-400">{genre.genre_slug}</span>
            {!genre.active && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">Inactive</span>}
          </div>
          <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{genre.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {editable && (
            <>
              <button onClick={(e) => { e.stopPropagation(); onEdit?.(); }} className="text-xs text-brand-600 hover:text-brand-700">Edit</button>
              <button onClick={(e) => { e.stopPropagation(); onDelete?.(); }} className="text-xs text-red-500 hover:text-red-600">Delete</button>
            </>
          )}
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-200 px-4 py-3 space-y-3 dark:border-gray-700">
          <DetailRow label="Keywords" value={genre.keywords.join(', ') || '—'} />
          <DetailRow label="RSS Feeds" value={genre.rss_feed_urls.length ? genre.rss_feed_urls.join('\n') : '—'} pre />
          <DetailRow label="Source URLs" value={genre.source_urls.length ? genre.source_urls.join('\n') : '—'} pre />
          <DetailRow label="Subreddits" value={genre.subreddit_names.join(', ') || '—'} />
          <DetailRow label="Goodreads" value={genre.goodreads_shelves.join(', ') || '—'} />
          <DetailRow label="Writing Guidelines" value={genre.writing_guidelines} />
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div>
      <span className="text-xs font-medium text-gray-500 uppercase">{label}</span>
      {pre ? (
        <pre className="mt-0.5 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{value}</pre>
      ) : (
        <p className="mt-0.5 text-xs text-gray-700 dark:text-gray-300 leading-relaxed">{value}</p>
      )}
    </div>
  );
}
