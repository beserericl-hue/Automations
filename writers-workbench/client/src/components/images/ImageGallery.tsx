import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { GeneratedImage } from '../../types/database';

interface ImageGalleryProps {
  projectId?: string;
  onSelectImage?: (image: GeneratedImage) => void;
}

const IMAGE_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'cover_art', label: 'Cover Art' },
  { value: 'chapter_art', label: 'Chapter Art' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'newsletter_section', label: 'Newsletter' },
] as const;

function getImageUrl(storagePath: string): string {
  const { data } = supabase.storage.from('cover-images').getPublicUrl(storagePath);
  return data.publicUrl;
}

export default function ImageGallery({ projectId, onSelectImage }: ImageGalleryProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [typeFilter, setTypeFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);

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

  const handleDownload = async (image: GeneratedImage) => {
    const url = getImageUrl(image.storage_path);
    const response = await fetch(url);
    const blob = await response.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${image.storage_path.split('/').pop() || 'image'}.${image.image_format || 'png'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
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
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
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

        <span className="ml-auto text-sm text-gray-500">
          {images?.length ?? 0} image{images?.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Empty state */}
      {(!images || images.length === 0) && (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-12 text-center dark:border-gray-700">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No images yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Use the chat or Eve to generate cover art. Try: "Generate cover art for [project name]"
          </p>
        </div>
      )}

      {/* Grid */}
      {images && images.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map(image => (
            <div
              key={image.id}
              className="group cursor-pointer overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-900"
              onClick={() => setSelectedImage(image)}
            >
              <div className="aspect-square overflow-hidden bg-gray-100 dark:bg-gray-800">
                <img
                  src={getImageUrl(image.thumbnail_path || image.storage_path)}
                  alt={image.original_prompt || 'Generated image'}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
              </div>
              <div className="p-2">
                <span className="inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {image.image_type.replace('_', ' ')}
                </span>
                {image.genre_slug && (
                  <span className="ml-1 inline-block rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900/20 dark:text-brand-300">
                    {image.genre_slug}
                  </span>
                )}
                <p className="mt-1 truncate text-xs text-gray-500">
                  {new Date(image.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full-size modal */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="relative max-h-[90vh] max-w-4xl overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-gray-900"
            onClick={e => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute right-2 top-2 z-10 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <img
              src={getImageUrl(selectedImage.storage_path)}
              alt={selectedImage.original_prompt || 'Generated image'}
              className="max-h-[70vh] w-full object-contain"
            />

            <div className="border-t border-gray-200 p-4 dark:border-gray-700">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {selectedImage.original_prompt && (
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Prompt:</span> {selectedImage.original_prompt}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                    <span>{selectedImage.image_type.replace('_', ' ')}</span>
                    {selectedImage.genre_slug && <span>| {selectedImage.genre_slug}</span>}
                    {selectedImage.width && selectedImage.height && (
                      <span>| {selectedImage.width}x{selectedImage.height}</span>
                    )}
                    <span>| {new Date(selectedImage.created_at).toLocaleDateString()}</span>
                    <span>| {selectedImage.generation_model}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {onSelectImage && (
                    <button
                      onClick={() => { onSelectImage(selectedImage); setSelectedImage(null); }}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      Select
                    </button>
                  )}
                  <button
                    onClick={() => handleDownload(selectedImage)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
