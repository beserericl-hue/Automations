import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import Pagination from '../shared/Pagination';
import { TableSkeleton, EmptyState } from '../shared/Skeleton';
import type { WritingProject } from '../../types/database';

export default function ProjectList() {
  const navigate = useNavigate();
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data: projects, isLoading, isError, error } = useQuery({
    queryKey: ['projects', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as WritingProject[];
    },
    enabled: !!userId,
  });

  const paginatedProjects = useMemo(() => {
    if (!projects) return [];
    const start = (currentPage - 1) * pageSize;
    return projects.slice(start, start + pageSize);
  }, [projects, currentPage, pageSize]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Projects</h1>

      {isLoading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : isError ? (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 px-6 py-12 text-center text-sm text-red-600 dark:text-red-400">
          Failed to load projects: {error?.message || 'Unknown error'}
        </div>
      ) : !projects?.length ? (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <EmptyState
            title="No projects yet"
            description="Open the chat drawer and tell Eve what you'd like to write. She'll help you brainstorm and outline your story."
          />
        </div>
      ) : (
        <>
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Title</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Genre</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Chapters</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {paginatedProjects.map((project) => (
                <tr key={project.id} onClick={() => navigate(`/projects/${project.id}`)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/projects/${project.id}`); } }} tabIndex={0} role="button" aria-label={`Open project ${project.title}`} className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-inset">
                  <td className="px-6 py-3">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{project.title}</span>
                    {project.outline?.story_arc_name && (
                      <span className="ml-2 text-xs text-gray-400">({project.outline.story_arc_name})</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.genre_slug || '\u2014'}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.project_type}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.chapter_count}</td>
                  <td className="px-6 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {project.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-400">
                    {new Date(project.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination
        currentPage={currentPage}
        totalItems={projects?.length ?? 0}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
      />
        </>
      )}
    </div>
  );
}
