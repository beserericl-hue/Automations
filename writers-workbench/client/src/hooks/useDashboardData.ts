import { useQuery } from '@tanstack/react-query';
import { supabase } from '../config/supabase';
import { useUser } from '../contexts/UserContext';
import { apiFetch, type ApiEnvelope } from '../lib/api';

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

interface ContentRow {
  id: string;
  title: string;
  content_type: string;
  status: string | null;
  genre_slug: string | null;
  content_text: string | null;
  chapter_number: number | null;
  project_id: string | null;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  title: string;
  status: string | null;
  genre_slug: string | null;
  outline: { story_arc_name?: string } | null;
  updated_at: string;
}

interface ResearchRow {
  id: string;
  topic: string;
  status: string | null;
  genre_slug: string | null;
  content: string | null;
  updated_at: string;
}

interface ImpersonationDashboardPayload {
  target_user_id: string;
  counts: DashboardCounts;
  contentRows: ContentRow[];
  projectRows: ProjectRow[];
  researchRows: ResearchRow[];
  projectMap: Record<string, { title: string; story_arc: string | null }>;
}

function estimateWordCount(text: string | null): number | null {
  if (!text) return null;
  return text.split(/\s+/).filter(Boolean).length;
}

const TYPE_PATHS: Record<string, string> = {
  chapter: '/library?type=chapter',
  short_story: '/library?type=short_story',
  blog_post: '/library?type=blog_post',
  newsletter: '/library?type=newsletter',
};

function buildRecentFromPayload(p: ImpersonationDashboardPayload): RecentItem[] {
  const items: RecentItem[] = [];

  for (const c of p.contentRows) {
    const proj = c.project_id ? p.projectMap[c.project_id] : null;
    items.push({
      id: c.id,
      title: c.title,
      type: c.content_type as RecentItem['type'],
      status: c.status,
      genre_slug: c.genre_slug,
      story_arc: proj?.story_arc ?? null,
      word_count: estimateWordCount(c.content_text),
      chapter_number: c.chapter_number,
      project_title: proj?.title ?? null,
      updated_at: c.updated_at,
      path: TYPE_PATHS[c.content_type] || '/',
    });
  }
  for (const proj of p.projectRows) {
    items.push({
      id: proj.id,
      title: proj.title,
      type: 'project',
      status: proj.status,
      genre_slug: proj.genre_slug,
      story_arc: proj.outline?.story_arc_name ?? null,
      word_count: null,
      chapter_number: null,
      project_title: null,
      updated_at: proj.updated_at,
      path: '/projects',
    });
  }
  for (const r of p.researchRows) {
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

  items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return items.slice(0, 10);
}

/**
 * Returns counts AND recent items in one shot. Used by both
 * useDashboardCounts and useRecentItems via slicing.
 *
 * Sprint 8: when impersonating, fetches via the server proxy
 * (`/api/impersonate/data/dashboard`) so RLS does not filter the
 * superuser's auth.uid() against the target user's rows.
 */
function useDashboardData() {
  const { profile, isImpersonating } = useUser();
  const userId = profile?.user_id;

  return useQuery({
    queryKey: ['dashboard-data', userId, isImpersonating],
    queryFn: async (): Promise<{ counts: DashboardCounts; recent: RecentItem[] }> => {
      if (!userId) return { counts: { projects: 0, drafts: 0, published: 0, research: 0 }, recent: [] };

      if (isImpersonating) {
        const res = await apiFetch<ApiEnvelope<ImpersonationDashboardPayload>>('/api/impersonate/data/dashboard');
        const p = res.data;
        if (!p) return { counts: { projects: 0, drafts: 0, published: 0, research: 0 }, recent: [] };
        return { counts: p.counts, recent: buildRecentFromPayload(p) };
      }

      // Non-impersonating: original direct-Supabase path.
      const [projectsRes, draftsRes, publishedRes, researchRes, contentRes, projectsListRes, researchListRes] = await Promise.all([
        supabase.from('writing_projects_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null),
        supabase.from('published_content_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'draft').is('deleted_at', null),
        supabase.from('published_content_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'published').is('deleted_at', null),
        supabase.from('research_reports_v2').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('deleted_at', null),
        supabase.from('published_content_v2')
          .select('id, title, content_type, status, genre_slug, content_text, chapter_number, project_id, updated_at')
          .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(10),
        supabase.from('writing_projects_v2')
          .select('id, title, status, genre_slug, outline, updated_at')
          .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(5),
        supabase.from('research_reports_v2')
          .select('id, topic, status, genre_slug, content, updated_at')
          .eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(5),
      ]);

      const counts: DashboardCounts = {
        projects: projectsRes.count ?? 0,
        drafts: draftsRes.count ?? 0,
        published: publishedRes.count ?? 0,
        research: researchRes.count ?? 0,
      };

      const projectIds = new Set<string>();
      for (const c of (contentRes.data ?? []) as ContentRow[]) {
        if (c.project_id) projectIds.add(c.project_id);
      }
      const projectMap: Record<string, { title: string; story_arc: string | null }> = {};
      if (projectIds.size > 0) {
        const { data: projects } = await supabase
          .from('writing_projects_v2')
          .select('id, title, outline')
          .in('id', Array.from(projectIds));
        if (projects) {
          for (const p of projects as ProjectRow[]) {
            projectMap[p.id] = { title: p.title, story_arc: p.outline?.story_arc_name ?? null };
          }
        }
      }

      const payload: ImpersonationDashboardPayload = {
        target_user_id: userId,
        counts,
        contentRows: (contentRes.data ?? []) as ContentRow[],
        projectRows: (projectsListRes.data ?? []) as ProjectRow[],
        researchRows: (researchListRes.data ?? []) as ResearchRow[],
        projectMap,
      };

      return { counts, recent: buildRecentFromPayload(payload) };
    },
    enabled: !!userId,
    refetchInterval: 30_000,
  });
}

export function useDashboardCounts() {
  const q = useDashboardData();
  return {
    ...q,
    data: q.data?.counts ?? { projects: 0, drafts: 0, published: 0, research: 0 },
  };
}

export function useRecentItems() {
  const q = useDashboardData();
  return {
    ...q,
    data: q.data?.recent ?? [],
  };
}
