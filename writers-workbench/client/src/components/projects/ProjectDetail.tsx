import { useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import ExportDialog from '../export/ExportDialog';
import ConfirmDialog from '../shared/ConfirmDialog';
import type { WritingProject, PublishedContent, StoryBibleEntry, ResearchReport, OutlineCharacter, OutlineChapter } from '../../types/database';

const TABS = ['overview', 'outline', 'chapters', 'bible', 'art', 'research', 'cost', 'export'] as const;
type Tab = typeof TABS[number];

const tabLabels: Record<Tab, string> = {
  overview: 'Overview',
  outline: 'Outline',
  chapters: 'Chapters',
  bible: 'Story Bible',
  art: 'Art',
  research: 'Research',
  cost: 'Cost',
  export: 'Export',
};

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [cascadeInfo, setCascadeInfo] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const userId = profile?.user_id;

  const activeTab = (searchParams.get('tab') as Tab) || 'overview';
  const setActiveTab = (tab: Tab) => {
    setSearchParams({ tab }, { replace: true });
  };

  // Project data
  const { data: project, isLoading, isError, error } = useQuery({
    queryKey: ['project-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .single();
      if (error) throw error;
      return data as WritingProject;
    },
    enabled: !!id && !!userId,
  });

  // Chapters
  const { data: chapters } = useQuery({
    queryKey: ['project-chapters', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('id, title, chapter_number, status, content_text, updated_at')
        .eq('project_id', id!)
        .eq('user_id', userId!)
        .eq('content_type', 'chapter')
        .is('deleted_at', null)
        .order('chapter_number', { ascending: true });
      if (error) throw error;
      return data as (Pick<PublishedContent, 'id' | 'title' | 'chapter_number' | 'status' | 'updated_at'> & { content_text: string | null })[];
    },
    enabled: !!id && !!userId,
  });

  // Story Bible entries
  const { data: bibleEntries } = useQuery({
    queryKey: ['project-bible', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('story_bible_v2')
        .select('*')
        .eq('project_id', id!)
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('entry_type')
        .order('name');
      if (error) throw error;
      return data as StoryBibleEntry[];
    },
    enabled: !!id && !!userId && (activeTab === 'bible' || activeTab === 'overview'),
  });

  // Research reports filtered by genre
  const { data: researchReports } = useQuery({
    queryKey: ['project-research', id, project?.genre_slug],
    queryFn: async () => {
      let query = supabase
        .from('research_reports_v2')
        .select('*')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (project?.genre_slug) {
        query = query.eq('genre_slug', project.genre_slug);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as ResearchReport[];
    },
    enabled: !!id && !!userId && !!project && activeTab === 'research',
  });

  // Soft delete
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('writing_projects_v2')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-projects'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      navigate('/projects');
    },
  });

  const handleDeleteClick = async () => {
    const info: string[] = [];
    const { count: chapterCount } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', id!)
      .is('deleted_at', null);
    if (chapterCount) info.push(`${chapterCount} chapter(s) will be orphaned`);

    const { count: bibleCount } = await supabase
      .from('story_bible_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', id!)
      .is('deleted_at', null);
    if (bibleCount) info.push(`${bibleCount} story bible entry/entries will be deleted`);

    const { count: outlineVersionCount } = await supabase
      .from('outline_versions_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', id!);
    if (outlineVersionCount) info.push(`${outlineVersionCount} outline version(s) will be deleted`);

    setCascadeInfo(info);
    setShowDeleteConfirm(true);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>;
  }
  if (isError) {
    return <div className="flex items-center justify-center h-64 text-sm text-red-600 dark:text-red-400">Failed to load project: {error?.message}</div>;
  }
  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <p className="text-sm text-gray-500">Project not found.</p>
        <button onClick={() => navigate('/projects')} className="text-sm text-brand-600">Back to projects</button>
      </div>
    );
  }

  const outline = project.outline;
  const writtenChapters = chapters?.length ?? 0;
  const outlinedChapters = outline?.chapters?.length ?? 0;

  // Word count across all chapters
  const totalWords = chapters?.reduce((sum, ch) => {
    if (!ch.content_text) return sum;
    return sum + ch.content_text.split(/\s+/).filter(Boolean).length;
  }, 0) ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <button onClick={() => navigate('/projects')} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to Projects</button>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{project.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-500">
              {project.genre_slug && <span className="capitalize">{project.genre_slug.replace(/-/g, ' ')}</span>}
              <span>{project.project_type}</span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">{project.status}</span>
              {outline?.story_arc_name && <span className="text-xs text-brand-600">Arc: {outline.story_arc_name}</span>}
            </div>
          </div>
          <button
            onClick={handleDeleteClick}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete Project
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-0 -mb-px overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {tabLabels[tab]}
              {tab === 'chapters' && chapters ? ` (${writtenChapters})` : ''}
              {tab === 'bible' && bibleEntries ? ` (${bibleEntries.length})` : ''}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'overview' && (
          <OverviewTab
            project={project}
            outline={outline}
            writtenChapters={writtenChapters}
            outlinedChapters={outlinedChapters}
            totalWords={totalWords}
            bibleCount={bibleEntries?.length ?? 0}
          />
        )}
        {activeTab === 'outline' && <OutlineTab outline={outline} />}
        {activeTab === 'chapters' && <ChaptersTab chapters={chapters} />}
        {activeTab === 'bible' && <BibleTab entries={bibleEntries} projectId={id!} />}
        {activeTab === 'art' && <PlaceholderTab message="Image gallery coming in Sprint 4." />}
        {activeTab === 'research' && <ResearchTab reports={researchReports} genreSlug={project.genre_slug} />}
        {activeTab === 'cost' && <PlaceholderTab message="Token usage tracking coming in Sprint 5." />}
        {activeTab === 'export' && (
          <ExportTab
            projectId={id!}
            projectTitle={project.title}
            chapters={chapters}
            totalWords={totalWords}
            exportOpen={exportOpen}
            setExportOpen={setExportOpen}
          />
        )}
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete Project"
        message={`Are you sure you want to delete "${project.title}"?`}
        cascadeInfo={cascadeInfo.length > 0 ? cascadeInfo : undefined}
        confirmLabel="Delete Project"
        variant="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  );
}

// ---- Tab components ----

function OverviewTab({
  project,
  outline,
  writtenChapters,
  outlinedChapters,
  totalWords,
  bibleCount,
}: {
  project: WritingProject;
  outline: WritingProject['outline'];
  writtenChapters: number;
  outlinedChapters: number;
  totalWords: number;
  bibleCount: number;
}) {
  const progressPct = outlinedChapters > 0 ? Math.round((writtenChapters / outlinedChapters) * 100) : 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Progress */}
      <StatCard label="Chapters Written" value={`${writtenChapters} / ${outlinedChapters}`}>
        <div className="mt-2 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            className="h-2 rounded-full bg-brand-600 transition-all"
            style={{ width: `${Math.min(progressPct, 100)}%` }}
          />
        </div>
        <span className="text-xs text-gray-400 mt-1">{progressPct}% complete</span>
      </StatCard>

      <StatCard label="Total Words" value={totalWords.toLocaleString()} />
      <StatCard label="Story Bible Entries" value={String(bibleCount)} />
      <StatCard label="Genre" value={project.genre_slug?.replace(/-/g, ' ') || 'None'} />

      {/* Premise */}
      {outline?.premise && (
        <div className="md:col-span-2 lg:col-span-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Premise</h3>
          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{outline.premise}</p>
          {outline.themes && outline.themes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {outline.themes.map((theme, i) => (
                <span key={i} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                  {theme}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Characters summary */}
      {outline?.characters && outline.characters.length > 0 && (
        <div className="md:col-span-2 lg:col-span-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Characters ({outline.characters.length})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {outline.characters.map((char: OutlineCharacter, i: number) => (
              <div key={i} className="rounded-lg border border-gray-100 p-3 dark:border-gray-700">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{char.name}</span>
                  {char.age && <span className="text-xs text-gray-400">({char.age})</span>}
                </div>
                <span className="text-xs text-brand-600 dark:text-brand-400">{char.role}</span>
                <p className="mt-1 text-xs text-gray-500 leading-relaxed line-clamp-2">{char.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OutlineTab({ outline }: { outline: WritingProject['outline'] }) {
  if (!outline?.chapters?.length) {
    return <EmptyState message="No outline yet. Use the chat or Eve to brainstorm one." />;
  }

  return (
    <div className="space-y-3">
      {outline.chapters.map((ch: OutlineChapter, i: number) => (
        <div key={i} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-gray-400 w-12 shrink-0">
              {typeof ch.number === 'string' ? ch.number : `Ch ${ch.number}`}
            </span>
            <span className="text-sm font-medium text-gray-900 dark:text-white">{ch.title}</span>
          </div>
          <p className="mt-2 ml-14 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{ch.brief}</p>
          {ch.chapter_outline && ch.chapter_outline.length > 0 && (
            <div className="mt-3 ml-14 space-y-1">
              {ch.chapter_outline.map((sub, j) => (
                <div key={j} className="text-xs text-gray-500">
                  <span className="font-medium">{sub.section_number}.</span> {sub.title}
                  {sub.arc_beat && <span className="ml-2 text-gray-400">({sub.arc_beat})</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ChaptersTab({
  chapters,
}: {
  chapters: (Pick<PublishedContent, 'id' | 'title' | 'chapter_number' | 'status' | 'updated_at'> & { content_text: string | null })[] | undefined;
}) {
  if (!chapters?.length) {
    return <EmptyState message="No chapters written yet. Use the chat or Eve to write your first chapter." />;
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 w-16">#</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Title</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Words</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {chapters.map((ch, i) => {
            const wordCount = ch.content_text?.split(/\s+/).filter(Boolean).length ?? 0;
            const prevId = i > 0 ? chapters[i - 1].id : null;
            const nextId = i < chapters.length - 1 ? chapters[i + 1].id : null;
            return (
              <tr key={ch.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <td className="px-4 py-3 text-sm text-gray-500">
                  {ch.chapter_number != null ? ch.chapter_number : '\u2014'}
                </td>
                <td className="px-4 py-3">
                  <Link to={`/content/${ch.id}`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
                    {ch.title}
                  </Link>
                  <div className="flex gap-2 mt-1">
                    {prevId && <Link to={`/content/${prevId}`} className="text-[10px] text-gray-400 hover:text-gray-600">&larr; prev</Link>}
                    {nextId && <Link to={`/content/${nextId}`} className="text-[10px] text-gray-400 hover:text-gray-600">next &rarr;</Link>}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{wordCount.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={ch.status} />
                </td>
                <td className="px-4 py-3 text-sm text-gray-400">{new Date(ch.updated_at).toLocaleDateString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BibleTab({ entries }: { entries: StoryBibleEntry[] | undefined; projectId: string }) {
  if (!entries?.length) {
    return <EmptyState message="No story bible entries yet. They are created automatically when you write chapters." />;
  }

  const grouped = entries.reduce((acc, entry) => {
    if (!acc[entry.entry_type]) acc[entry.entry_type] = [];
    acc[entry.entry_type].push(entry);
    return acc;
  }, {} as Record<string, StoryBibleEntry[]>);

  const typeLabels: Record<string, string> = {
    character: 'Characters',
    location: 'Locations',
    event: 'Events',
    timeline: 'Timeline',
    plot_thread: 'Plot Threads',
    world_rule: 'World Rules',
  };

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([type, items]) => (
        <div key={type}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">{typeLabels[type] || type} ({items.length})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map(entry => (
              <div key={entry.id} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                <span className="text-sm font-medium text-gray-900 dark:text-white">{entry.name}</span>
                {entry.chapter_introduced != null && (
                  <span className="ml-2 text-xs text-gray-400">Ch. {entry.chapter_introduced}</span>
                )}
                <p className="mt-1 text-xs text-gray-500 leading-relaxed line-clamp-3">{entry.description}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResearchTab({ reports, genreSlug }: { reports: ResearchReport[] | undefined; genreSlug: string | null }) {
  if (!reports?.length) {
    return <EmptyState message={`No research reports${genreSlug ? ` for genre "${genreSlug.replace(/-/g, ' ')}"` : ''}. Use the chat or Eve to request research.`} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Showing research reports{genreSlug ? ` filtered by genre: ${genreSlug.replace(/-/g, ' ')}` : ''}.
      </p>
      {reports.map(report => (
        <div key={report.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900 dark:text-white">{report.topic}</span>
            <span className="text-xs text-gray-400">{new Date(report.updated_at).toLocaleDateString()}</span>
          </div>
          {report.content && (
            <p className="mt-2 text-xs text-gray-500 leading-relaxed line-clamp-4">{report.content.substring(0, 300)}...</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ExportTab({
  projectId,
  projectTitle,
  chapters,
  totalWords,
  exportOpen,
  setExportOpen,
}: {
  projectId: string;
  projectTitle: string;
  chapters: (Pick<PublishedContent, 'id' | 'title' | 'chapter_number' | 'status' | 'updated_at'> & { content_text: string | null })[] | undefined;
  totalWords: number;
  exportOpen: boolean;
  setExportOpen: (open: boolean) => void;
}) {
  const exportableChapters = chapters?.filter(ch => ch.status === 'approved' || ch.status === 'published') ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Export to Word (.docx)</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Export your manuscript as a formatted Word document ready for KDP upload. Only chapters with status
          <span className="font-medium text-green-600"> approved</span> or
          <span className="font-medium text-green-600"> published</span> are included,
          ordered: Prologue &rarr; Ch 1-N &rarr; Epilogue.
        </p>
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <span className="text-xs text-gray-500 block">Chapters included</span>
            <span className="text-lg font-bold text-gray-900 dark:text-white">{exportableChapters.length}</span>
            <span className="text-xs text-gray-400"> of {chapters?.length ?? 0}</span>
          </div>
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <span className="text-xs text-gray-500 block">Total words</span>
            <span className="text-lg font-bold text-gray-900 dark:text-white">{totalWords.toLocaleString()}</span>
          </div>
        </div>
        <button
          onClick={() => setExportOpen(true)}
          disabled={exportableChapters.length === 0}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Choose Page Size & Export
        </button>
        {exportableChapters.length === 0 && (
          <p className="mt-2 text-xs text-gray-400">No chapters are approved/published yet. Approve chapters first.</p>
        )}
      </div>

      <ExportDialog
        projectId={projectId}
        projectTitle={projectTitle}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}

// ---- Shared sub-components ----

function StatCard({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <span className="text-xs text-gray-500 block">{label}</span>
      <span className="text-xl font-bold text-gray-900 dark:text-white capitalize">{value}</span>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    draft: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    scheduled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] || ''}`}>
      {status}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}

function PlaceholderTab({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-center">
        <p className="text-sm text-gray-400">{message}</p>
      </div>
    </div>
  );
}
