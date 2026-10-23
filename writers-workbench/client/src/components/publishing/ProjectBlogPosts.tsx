/**
 * The blog posts written about this project, listed where they were written.
 *
 * They were landing in the Content Library and nowhere else. The Library is the right home for
 * everything, which makes it the wrong place to go looking for the two posts about one book —
 * filtered by type, mixed in with every other project's. A post written from the Promotion tab is
 * about this project, so it belongs on this project.
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import { apiFetch, type ApiEnvelope } from '../../lib/api';

interface BlogPost {
  id: string;
  title: string | null;
  content_text: string | null;
  status: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

/** The first real paragraph, for a preview that says what the post is rather than what it is called. */
function openingOf(markdown: string): string {
  for (const block of (markdown || '').split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    return line.replace(/[*_`]/g, '');
  }
  return '';
}

export default function ProjectBlogPosts({ projectId }: { projectId: string }) {
  const { profile, isImpersonating } = useUser();
  const userId = profile?.user_id;

  const { data: posts, isLoading } = useQuery({
    queryKey: ['project-blog-posts', userId, projectId, isImpersonating],
    queryFn: async () => {
      if (isImpersonating) {
        const res = await apiFetch<ApiEnvelope<BlogPost[]>>(
          `/api/impersonate/data/content?project_id=${projectId}&content_type=blog_post`,
        );
        return res.data ?? [];
      }
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('id, title, content_text, status, created_at, metadata')
        .eq('user_id', userId!)
        .eq('project_id', projectId)
        .eq('content_type', 'blog_post')
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as BlogPost[];
    },
    enabled: !!userId,
  });

  if (isLoading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }

  if (!posts?.length) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
        <p className="text-sm font-medium text-gray-900 dark:text-white">No blog posts yet</p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Write one above and it appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => {
        const words = (post.content_text || '').split(/\s+/).filter(Boolean).length;
        const opening = openingOf(post.content_text || '');
        return (
          <div
            key={post.id}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/content/${post.id}`}
                  className="text-sm font-semibold text-gray-900 hover:text-brand-600 dark:text-white dark:hover:text-brand-400"
                >
                  {post.title || 'Untitled'}
                </Link>
                {opening ? (
                  <p className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">{opening}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                  <span>{new Date(post.created_at).toLocaleDateString()}</span>
                  <span>{words.toLocaleString()} words</span>
                  <span
                    className={`rounded px-1.5 py-0.5 ${
                      post.status === 'published'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}
                  >
                    {post.status || 'draft'}
                  </span>
                  {/* Set when the post refers to the author by a pronoun they never supplied. It is
                      a claim about a real person, so it travels with the post rather than living in
                      a log. */}
                  {typeof post.metadata?.pronoun_warning === 'string' ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                      {post.metadata.pronoun_warning as string}
                    </span>
                  ) : null}
                </div>
              </div>
              <Link
                to={`/content/${post.id}`}
                className="shrink-0 rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Open
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
