import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { GeneratedImage } from '../../types/database';

interface ImageGalleryProps {
  projectId?: string;
  onSelectImage?: (image: GeneratedImage) => void; // Picker mode (cover image selector)
}

const IMAGE_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'cover_art', label: 'Cover Art' },
  { value: 'chapter_art', label: 'Chapter Art' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'newsletter_section', label: 'Newsletter' },
] as const;

export function getImageUrl(storagePath: string): string {
  // Build URL manually — Supabase getPublicUrl can mangle paths with special chars like +
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const encodedPath = storagePath.split('/').map(s => encodeURIComponent(s)).join('/');
  return `${supabaseUrl}/storage/v1/object/public/cover-images/${encodedPath}`;
}

export default function ImageGallery({ projectId, onSelectImage }: ImageGalleryProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const navigate = useNavigate();
  const [typeFilter, setTypeFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');

  const { data: images, isLoading } = useQuery({
    queryKey: ['generated-images', userId, projectId, typeFilter, genreFilter],
    queryFn: async () => {
      let query = supabase
        .from('generated_images_v2')
        .select('*')
        .eq('user_id', userId!)
        .order('created_at', { ascending: false });

      if (projectId) query = query.eq('project_id', projectId);
      if (typeFilter) query = query.eq('image_type', typeFilter);
      if (genreFilter) query = query.eq('genre_slug', genreFilter);

      const { data, error } = await query;
      if (error) throw error;
      return data as GeneratedImage[];
    },
    enabled: !!userId,
  });

  const { data: genres } = useQuery({
    queryKey: ['image-genres', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generated_images_v2')
        .select('genre_slug')
        .eq('user_id', userId!)
        .not('genre_slug', 'is', null);
      if (error) throw error;
      const slugs = [...new Set((data || []).map((d: { genre_slug: string }) => d.genre_slug))];
      return slugs.sort();
    },
    enabled: !!userId,
  });

  const handleClick = (image: GeneratedImage) => {
    if (onSelectImage) {
      // Picker mode — select and return
      onSelectImage(image);
    } else {
      // Gallery mode — navigate to detail page
      navigate(`/images/${image.id}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {/* Header with filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Cover Art & Images</h2>

        <div className="ml-auto flex items-center gap-3">
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          >
            {IMAGE_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>

          {genres && genres.length > 0 && (
            <select
              value={genreFilter}
              onChange={e => setGenreFilter(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              <option value="">All Genres</option>
              {genres.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}

          <span className="text-sm text-gray-400">
            {images?.length ?? 0} image{images?.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Empty state */}
      {(!images || images.length === 0) && (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-12 text-center dark:border-gray-700">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No images yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Use the chat or Eve to generate cover art, or click a chapter's cover art button.
          </p>
        </div>
      )}

      {/* Thumbnail grid */}
      {images && images.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {images.map(image => (
            <div
              key={image.id}
              className="group cursor-pointer overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-all hover:shadow-lg hover:border-brand-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-brand-600"
              onClick={() => handleClick(image)}
            >
              <div className="aspect-video overflow-hidden bg-gray-100 dark:bg-gray-800">
                <img
                  src={getImageUrl(image.thumbnail_path || image.storage_path)}
                  alt={image.original_prompt?.substring(0, 100) || 'Generated image'}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
              </div>
              <div className="p-2">
                <p className="truncate text-xs font-medium text-gray-700 dark:text-gray-300">
                  {(image.metadata as Record<string, string>)?.title || (image.metadata as Record<string, string>)?.story_title || image.image_type.replace('_', ' ')}
                </p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-400">
                    {new Date(image.created_at).toLocaleDateString()}
                  </span>
                  {image.genre_slug && (
                    <span className="rounded bg-gray-100 px-1 py-0.5 text-[9px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {image.genre_slug.replace(/-/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
