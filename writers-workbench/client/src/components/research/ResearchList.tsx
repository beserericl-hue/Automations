import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import ConfirmDialog from '../shared/ConfirmDialog';
import Pagination from '../shared/Pagination';
import type { ResearchReport } from '../../types/database';

export default function ResearchList() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();
  const [deletingReport, setDeletingReport] = useState<ResearchReport | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data: reports, isLoading, isError, error } = useQuery({
    queryKey: ['research', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('research_reports_v2')
        .select('*')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as ResearchReport[];
    },
    enabled: !!userId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const { error } = await supabase
        .from('research_reports_v2')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', reportId)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-recent'] });
      setDeletingReport(null);
    },
  });

  const paginatedReports = useMemo(() => {
    if (!reports) return [];
    const start = (currentPage - 1) * pageSize;
    return reports.slice(start, start + pageSize);
  }, [reports, currentPage, pageSize]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Research Reports</h1>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading...</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-600 dark:text-red-400">
            Failed to load research reports: {error?.message || 'Unknown error'}
          </div>
        ) : !reports?.length ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No research reports yet. Ask Eve or use the chat to research a topic.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Topic</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Genre</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Updated</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {paginatedReports.map((report) => (
                <tr key={report.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors">
                  <td className="px-6 py-3 text-sm font-medium text-gray-900 dark:text-white">{report.topic}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{report.genre_slug || '—'}</td>
                  <td className="px-6 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {report.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-400">
                    {new Date(report.updated_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingReport(report); }}
                      className="text-xs text-red-500 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        currentPage={currentPage}
        totalItems={reports?.length ?? 0}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
      />

      <ConfirmDialog
        open={!!deletingReport}
        onClose={() => setDeletingReport(null)}
        onConfirm={() => { if (deletingReport) deleteMutation.mutate(deletingReport.id); }}
        title="Delete Research Report"
        message={`Are you sure you want to delete "${deletingReport?.topic}"?`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
