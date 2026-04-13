import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import GenreForm from './GenreForm';
import ConfirmDialog from '../shared/ConfirmDialog';
import Pagination from '../shared/Pagination';
import type { GenreConfig } from '../../types/database';

export default function GenreList() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();
  const [editingGenre, setEditingGenre] = useState<GenreConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingGenre, setDeletingGenre] = useState<GenreConfig | null>(null);
  const [deleteCascadeInfo, setDeleteCascadeInfo] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data: genres, isLoading, isError, error } = useQuery({
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['genres', userId] }),
  });

  const handleDeleteClick = async (genre: GenreConfig) => {
    const info: string[] = [];
    const { count: projectCount } = await supabase
      .from('writing_projects_v2')
      .select('id', { count: 'exact', head: true })
      .eq('genre_slug', genre.genre_slug)
      .eq('user_id', userId!)
      .is('deleted_at', null);
    if (projectCount) info.push(`${projectCount} project(s) reference this genre`);

    const { count: contentCount } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('genre_slug', genre.genre_slug)
      .eq('user_id', userId!)
      .is('deleted_at', null);
    if (contentCount) info.push(`${contentCount} content item(s) reference this genre`);

    setDeleteCascadeInfo(info);
    setDeletingGenre(genre);
  };

  const publicGenres = genres?.filter(g => g.user_id === null) || [];
  const privateGenres = genres?.filter(g => g.user_id !== null) || [];

  const paginatedPublicGenres = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return publicGenres.slice(start, start + pageSize);
  }, [publicGenres, currentPage, pageSize]);

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
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load genres: {error?.message || 'Unknown error'}</p>
        </div>
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
                    onDelete={() => handleDeleteClick(genre)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Public genres */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Public Genres ({publicGenres.length})</h2>
            <div className="space-y-3">
              {paginatedPublicGenres.map(genre => (
                <GenreCard key={genre.id} genre={genre} editable={false} />
              ))}
            </div>
            <div className="mt-4">
              <Pagination
                currentPage={currentPage}
                totalItems={publicGenres.length}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
              />
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!deletingGenre}
        onClose={() => { setDeletingGenre(null); setDeleteCascadeInfo([]); }}
        onConfirm={() => {
          if (deletingGenre) deleteMutation.mutate(deletingGenre.id);
          setDeletingGenre(null);
          setDeleteCascadeInfo([]);
        }}
        title="Delete Genre"
        message={`Are you sure you want to delete "${deletingGenre?.genre_name}"? This cannot be undone.`}
        cascadeInfo={deleteCascadeInfo.length > 0 ? [...deleteCascadeInfo, 'These items will NOT be deleted but will lose their genre reference.'] : undefined}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
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
  const { profile } = useUser();

  const { data: refCount } = useQuery({
    queryKey: ['genre-ref-count', genre.genre_slug, profile?.user_id],
    queryFn: async () => {
      const { count } = await supabase
        .from('writing_projects_v2')
        .select('id', { count: 'exact', head: true })
        .eq('genre_slug', genre.genre_slug)
        .eq('user_id', profile!.user_id)
        .is('deleted_at', null);
      return count ?? 0;
    },
    enabled: !!profile?.user_id,
    staleTime: 60_000,
  });

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
          <div className="mt-1 flex flex-wrap gap-2">
            {refCount != null && refCount > 0 && <span className="text-[10px] text-brand-600 dark:text-brand-400">{refCount} project{refCount !== 1 ? 's' : ''}</span>}
            {genre.rss_feed_urls.length > 0 && <span className="text-[10px] text-gray-400">{genre.rss_feed_urls.length} RSS feeds</span>}
            {genre.source_urls.length > 0 && <span className="text-[10px] text-gray-400">{genre.source_urls.length} sources</span>}
            {genre.subreddit_names.length > 0 && <span className="text-[10px] text-gray-400">{genre.subreddit_names.length} subreddits</span>}
          </div>
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
