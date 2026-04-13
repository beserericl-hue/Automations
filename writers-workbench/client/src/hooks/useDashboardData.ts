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
  story_arc: string | null;
  word_count: number | null;
  chapter_number: number | null;
  project_title: string | null;
  updated_at: string;
  path: string; // navigation path
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
          .eq('user_id', userId)
          .is('deleted_at', null),
        supabase
          .from('published_content_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'draft')
          .is('deleted_at', null),
        supabase
          .from('published_content_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('status', 'published')
          .is('deleted_at', null),
        supabase
          .from('research_reports_v2')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .is('deleted_at', null),
      ]);

      return {
        projects: projectsRes.count ?? 0,
        drafts: draftsRes.count ?? 0,
        published: publishedRes.count ?? 0,
        research: researchRes.count ?? 0,
      };
    },
    enabled: !!userId,
    refetchInterval: 30_000, // Auto-refresh every 30 seconds
  });
}

function estimateWordCount(text: string | null): number | null {
  if (!text) return null;
  return text.split(/\s+/).filter(Boolean).length;
}

export function useRecentItems() {
  const { profile } = useUser();
  const userId = profile?.user_id;

  return useQuery({
    queryKey: ['dashboard-recent', userId],
    queryFn: async (): Promise<RecentItem[]> => {
      if (!userId) return [];

      const [contentRes, projectsRes, researchRes] = await Promise.all([
        supabase
          .from('published_content_v2')
          .select('id, title, content_type, status, genre_slug, content_text, chapter_number, project_id, updated_at')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .limit(10),
        supabase
          .from('writing_projects_v2')
          .select('id, title, status, genre_slug, outline, updated_at')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .limit(5),
        supabase
          .from('research_reports_v2')
          .select('id, topic, status, genre_slug, content, updated_at')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .limit(5),
      ]);

      // Build a map of project_id -> project title & arc for content items
      const projectIds = new Set<string>();
      if (contentRes.data) {
        for (const c of contentRes.data) {
          if (c.project_id) projectIds.add(c.project_id);
        }
      }

      let projectMap: Record<string, { title: string; story_arc: string | null }> = {};
      if (projectIds.size > 0) {
        const { data: projects } = await supabase
          .from('writing_projects_v2')
          .select('id, title, outline')
          .in('id', Array.from(projectIds));
        if (projects) {
          for (const p of projects) {
            projectMap[p.id] = {
              title: p.title,
              story_arc: p.outline?.story_arc_name || null,
            };
          }
        }
      }

      const items: RecentItem[] = [];

      if (contentRes.data) {
        for (const c of contentRes.data) {
          const proj = c.project_id ? projectMap[c.project_id] : null;
          const typePaths: Record<string, string> = {
            chapter: '/library?type=chapter',
            short_story: '/library?type=short_story',
            blog_post: '/library?type=blog_post',
            newsletter: '/library?type=newsletter',
          };
          items.push({
            id: c.id,
            title: c.title,
            type: c.content_type as RecentItem['type'],
            status: c.status,
            genre_slug: c.genre_slug,
            story_arc: proj?.story_arc || null,
            word_count: estimateWordCount(c.content_text),
            chapter_number: c.chapter_number,
            project_title: proj?.title || null,
            updated_at: c.updated_at,
            path: typePaths[c.content_type] || '/',
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
            story_arc: p.outline?.story_arc_name || null,
            word_count: null,
            chapter_number: null,
            project_title: null,
            updated_at: p.updated_at,
            path: '/projects',
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
            story_arc: null,
            word_count: estimateWordCount(r.content),
            chapter_number: null,
            project_title: null,
            updated_at: r.updated_at,
            path: '/research',
          });
        }
      }

      items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return items.slice(0, 10);
    },
    enabled: !!userId,
    refetchInterval: 30_000, // Auto-refresh every 30 seconds
  });
}
