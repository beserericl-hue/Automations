import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import ExportDialog from '../export/ExportDialog';
import type { WritingProject, PublishedContent, OutlineCharacter, OutlineChapter } from '../../types/database';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useUser();
  const [exportOpen, setExportOpen] = useState(false);
  const userId = profile?.user_id;

  const { data: project, isLoading, isError, error } = useQuery({
    queryKey: ['project-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .single();
      if (error) throw error;
      return data as WritingProject;
    },
    enabled: !!id && !!userId,
  });

  // Fetch chapters for this project
  const { data: chapters } = useQuery({
    queryKey: ['project-chapters', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('id, title, chapter_number, status, updated_at')
        .eq('project_id', id!)
        .eq('user_id', userId!)
        .eq('content_type', 'chapter')
        .order('chapter_number', { ascending: true });
      if (error) throw error;
      return data as Pick<PublishedContent, 'id' | 'title' | 'chapter_number' | 'status' | 'updated_at'>[];
    },
    enabled: !!id && !!userId,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-red-600 dark:text-red-400">
        Failed to load project: {error?.message || 'Unknown error'}
      </div>
    );
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <button onClick={() => navigate('/projects')} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to Projects</button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{project.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-500">
          {project.genre_slug && <span className="capitalize">{project.genre_slug.replace(/-/g, ' ')}</span>}
          <span>{project.project_type}</span>
          <span>{project.chapter_count} chapters</span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">{project.status}</span>
          {outline?.story_arc_name && <span className="text-xs text-brand-600">Arc: {outline.story_arc_name}</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Outline */}
        <div className="lg:col-span-2 space-y-6">
          {/* Premise & Themes */}
          {outline && (outline.premise || outline.themes) && (
            <Section title="Premise & Themes">
              {outline.premise && <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{outline.premise}</p>}
              {outline.themes && outline.themes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {outline.themes.map((theme, i) => (
                    <span key={i} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                      {theme}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Characters */}
          {outline?.characters && outline.characters.length > 0 && (
            <Section title="Characters">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {outline.characters.map((char: OutlineCharacter, i: number) => (
                  <div key={i} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">{char.name}</span>
                      {char.age && <span className="text-xs text-gray-400">({char.age})</span>}
                    </div>
                    <span className="text-xs text-brand-600 dark:text-brand-400">{char.role}</span>
                    <p className="mt-1 text-xs text-gray-500 leading-relaxed">{char.description}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Chapter Outline */}
          {outline?.chapters && outline.chapters.length > 0 && (
            <Section title="Chapter Outline">
              <div className="space-y-2">
                {outline.chapters.map((ch: OutlineChapter, i: number) => (
                  <div key={i} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-gray-400 w-8 shrink-0">
                        {typeof ch.number === 'string' ? ch.number : `Ch ${ch.number}`}
                      </span>
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{ch.title}</span>
                    </div>
                    <p className="mt-1 ml-10 text-xs text-gray-500 leading-relaxed">{ch.brief}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* Right column: Chapters & Story Bible link */}
        <div className="space-y-6">
          {/* Written Chapters */}
          <Section title="Written Chapters">
            {!chapters?.length ? (
              <p className="text-sm text-gray-400">No chapters written yet.</p>
            ) : (
              <div className="space-y-1">
                {chapters.map((ch) => (
                  <Link
                    key={ch.id}
                    to={`/content/${ch.id}`}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <span className="text-gray-900 dark:text-white">
                      {ch.chapter_number != null ? `Ch. ${ch.chapter_number}` : ''} {ch.title}
                    </span>
                    <StatusDot status={ch.status} />
                  </Link>
                ))}
              </div>
            )}
          </Section>

          {/* Quick links */}
          <Section title="Tools">
            <div className="space-y-2">
              <Link
                to={`/projects/${id}/bible`}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <BookIcon />
                Story Bible
              </Link>
              <button
                onClick={() => setExportOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <DownloadIcon />
                Export to Word
              </button>
            </div>
          </Section>

          <ExportDialog
            projectId={id!}
            projectTitle={project.title}
            open={exportOpen}
            onClose={() => setExportOpen(false)}
          />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{title}</h2>
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-500',
    approved: 'bg-blue-500',
    draft: 'bg-gray-400',
    rejected: 'bg-red-500',
    scheduled: 'bg-yellow-500',
  };
  return (
    <span className={`h-2 w-2 rounded-full ${colors[status] || 'bg-gray-400'}`} title={status} />
  );
}

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.331 0 4.472.89 6.064 2.346m0-14.304a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.346" />
    </svg>
  );
}
