import { useQuery } from '@tanstack/react-query';
import { supabase } from '../config/supabase';
import { useUser } from '../contexts/UserContext';

export interface DashboardCounts {
  projects: number;
  drafts: number;
  published: number;
  research: number;
}

export interface RecentItem {
  id: string;
  title: string;
  type: 'project' | 'chapter' | 'short_story' | 'blog_post' | 'newsletter' | 'research';
  status: string | null;
  genre_slug: string | null;
  updated_at: string;
}

export function useDashboardCounts() {
  const { profile } = useUser();
  const userId = profile?.user_id;

  return useQuery({
    queryKey: ['dashboard-counts', userId],
    queryFn: async (): Promise<DashboardCounts> => {
      if (!userId) return { projects: 0, drafts: 0, published: 0, research: 0 };

      const [projectsRes, draftsRes, publishedRes, researchRes] = await Promise.all([
        supabase
          .from('writing_projects_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId),
        supabase
          .from('published_content_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'draft'),
        supabase
          .from('published_content_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'published'),
        supabase
          .from('research_reports_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId),
      ]);

      return {
        projects: projectsRes.count ?? 0,
        drafts: draftsRes.count ?? 0,
        published: publishedRes.count ?? 0,
        research: researchRes.count ?? 0,
      };
    },
    enabled: !!userId,
  });
}

export function useRecentItems() {
  const { profile } = useUser();
  const userId = profile?.user_id;

  return useQuery({
    queryKey: ['dashboard-recent', userId],
    queryFn: async (): Promise<RecentItem[]> => {
      if (!userId) return [];

      // Fetch recent content and projects in parallel, then merge & sort
      const [contentRes, projectsRes, researchRes] = await Promise.all([
        supabase
          .from('published_content_v2')
          .select('id, title, content_type, status, genre_slug, updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(10),
        supabase
          .from('writing_projects_v2')
          .select('id, title, status, genre_slug, updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(5),
        supabase
          .from('research_reports_v2')
          .select('id, topic, status, genre_slug, updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(5),
      ]);

      const items: RecentItem[] = [];

      if (contentRes.data) {
        for (const c of contentRes.data) {
          items.push({
            id: c.id,
            title: c.title,
            type: c.content_type as RecentItem['type'],
            status: c.status,
            genre_slug: c.genre_slug,
            updated_at: c.updated_at,
          });
        }
      }

      if (projectsRes.data) {
        for (const p of projectsRes.data) {
          items.push({
            id: p.id,
            title: p.title,
            type: 'project',
            status: p.status,
            genre_slug: p.genre_slug,
            updated_at: p.updated_at,
          });
        }
      }

      if (researchRes.data) {
        for (const r of researchRes.data) {
          items.push({
            id: r.id,
            title: r.topic,
            type: 'research',
            status: r.status,
            genre_slug: r.genre_slug,
            updated_at: r.updated_at,
          });
        }
      }

      // Sort by updated_at descending, take top 10
      items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return items.slice(0, 10);
    },
    enabled: !!userId,
  });
}
