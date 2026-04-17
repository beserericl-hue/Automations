import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { SocialPost, GeneratedImage } from '../../types/database';

interface SocialMediaPanelProps {
  projectId?: string;
}

const PLATFORMS = [
  { value: '', label: 'All Platforms', icon: '' },
  { value: 'twitter', label: 'Twitter / X', icon: '𝕏' },
  { value: 'linkedin', label: 'LinkedIn', icon: 'in' },
  { value: 'instagram', label: 'Instagram', icon: '📷' },
  { value: 'facebook', label: 'Facebook', icon: 'f' },
] as const;

const platformColors: Record<string, string> = {
  twitter: 'bg-black text-white',
  linkedin: 'bg-blue-700 text-white',
  instagram: 'bg-gradient-to-r from-purple-500 to-pink-500 text-white',
  facebook: 'bg-blue-600 text-white',
};

function getImageUrl(storagePath: string): string {
  const { data } = supabase.storage.from('social-images').getPublicUrl(storagePath);
  return data.publicUrl;
}

export default function SocialMediaPanel({ projectId }: SocialMediaPanelProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [platformFilter, setPlatformFilter] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: posts, isLoading } = useQuery({
    queryKey: ['social-posts', userId, projectId, platformFilter],
    queryFn: async () => {
      let query = supabase
        .from('social_posts_v2')
        .select('*')
        .eq('user_id', userId!)
        .order('created_at', { ascending: false });

      if (projectId) query = query.eq('project_id', projectId);
      if (platformFilter) query = query.eq('platform', platformFilter);

      const { data, error } = await query;
      if (error) throw error;
      return data as SocialPost[];
    },
    enabled: !!userId,
  });

  // Fetch images linked to posts
  const imageIds = [...new Set((posts || []).filter(p => p.image_id).map(p => p.image_id!))];
  const { data: images } = useQuery({
    queryKey: ['social-post-images', imageIds],
    queryFn: async () => {
      if (imageIds.length === 0) return [];
      const { data, error } = await supabase
        .from('generated_images_v2')
        .select('*')
        .in('id', imageIds);
      if (error) throw error;
      return data as GeneratedImage[];
    },
    enabled: imageIds.length > 0,
  });

  const imageMap = new Map((images || []).map(img => [img.id, img]));

  const handleCopy = async (post: SocialPost) => {
    const text = post.hashtags.length > 0
      ? `${post.post_text}\n\n${post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : post.post_text;
    await navigator.clipboard.writeText(text);
    setCopiedId(post.id);
    setTimeout(() => setCopiedId(null), 2000);
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
      {/* Platform filter tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PLATFORMS.map(p => (
          <button
            key={p.value}
            onClick={() => setPlatformFilter(p.value)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              platformFilter === p.value
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500">
          {posts?.length ?? 0} post{posts?.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Empty state */}
      {(!posts || posts.length === 0) && (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-12 text-center dark:border-gray-700">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No social posts yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Use the chat or Eve to repurpose content for social media. Try: "Repurpose [title] for social media"
          </p>
        </div>
      )}

      {/* Post cards */}
      {posts && posts.length > 0 && (
        <div className="space-y-3">
          {posts.map(post => {
            const linkedImage = post.image_id ? imageMap.get(post.image_id) : null;
            return (
              <div
                key={post.id}
                className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
              >
                <div className="flex items-start gap-3">
                  {/* Platform badge */}
                  <span className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${platformColors[post.platform] || 'bg-gray-500 text-white'}`}>
                    {PLATFORMS.find(p => p.value === post.platform)?.icon || '?'}
                  </span>

                  <div className="min-w-0 flex-1">
                    {/* Post text */}
                    <p className="whitespace-pre-wrap text-sm text-gray-900 dark:text-gray-100">
                      {post.post_text}
                    </p>

                    {/* Hashtags */}
                    {post.hashtags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {post.hashtags.map((tag, i) => (
                          <span key={i} className="text-xs text-brand-600 dark:text-brand-400">
                            {tag.startsWith('#') ? tag : `#${tag}`}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Image thumbnail */}
                    {linkedImage && (
                      <div className="mt-2">
                        <img
                          src={getImageUrl(linkedImage.thumbnail_path || linkedImage.storage_path)}
                          alt="Post image"
                          className="h-20 w-20 rounded object-cover"
                          loading="lazy"
                        />
                      </div>
                    )}

                    {/* Footer */}
                    <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                      <span>{new Date(post.created_at).toLocaleDateString()}</span>
                      <span className={`rounded px-1.5 py-0.5 ${
                        post.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400' :
                        post.status === 'scheduled' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400' :
                        'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {post.status}
                      </span>
                      {post.scheduled_at && (
                        <span>Scheduled: {new Date(post.scheduled_at).toLocaleString()}</span>
                      )}
                    </div>
                  </div>

                  {/* Copy button */}
                  <button
                    onClick={() => handleCopy(post)}
                    className="flex-shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                    title="Copy to clipboard"
                  >
                    {copiedId === post.id ? (
                      <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
