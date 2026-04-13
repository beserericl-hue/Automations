import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useMemo } from 'react';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import RichTextEditor from '../editor/RichTextEditor';
import ConfirmDialog from '../shared/ConfirmDialog';
import { contentToHtml } from '../../lib/content-utils';
import type { ResearchReport } from '../../types/database';

export default function ResearchDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: report, isLoading, isError, error } = useQuery({
    queryKey: ['research-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('research_reports_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .single();
      if (error) throw error;
      return data as ResearchReport;
    },
    enabled: !!id && !!userId,
  });

  const saveMutation = useMutation({
    mutationFn: async (html: string) => {
      setSaveStatus('saving');
      const { error } = await supabase
        .from('research_reports_v2')
        .update({
          content: html,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      setSaveStatus('saved');
      queryClient.invalidateQueries({ queryKey: ['research-detail', id] });
      setTimeout(() => setSaveStatus(null), 3000);
    },
    onError: () => {
      setSaveStatus('error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('research_reports_v2')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['research'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      navigate('/research');
    },
  });

  const handleSave = useCallback((html: string) => {
    saveMutation.mutate(html);
  }, [saveMutation]);

  const editorContent = useMemo(() => contentToHtml(report?.content ?? null), [report?.content]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-red-600 dark:text-red-400">
        Failed to load research report: {error?.message || 'Unknown error'}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <p className="text-sm text-gray-500">Research report not found.</p>
        <button onClick={() => navigate('/research')} className="text-sm text-brand-600 hover:text-brand-700">Back to Research</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <button onClick={() => navigate('/research')} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to Research</button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white truncate">{report.topic}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-400">
            {report.genre_slug && <span className="capitalize">{report.genre_slug.replace(/-/g, ' ')}</span>}
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">{report.status}</span>
            <span>Updated {new Date(report.updated_at).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {saveStatus === 'saving' && <span className="text-xs text-gray-400">Saving...</span>}
          {saveStatus === 'saved' && <span className="text-xs text-green-500">Saved</span>}
          {saveStatus === 'error' && <span className="text-xs text-red-500">Save failed</span>}

          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="rounded-lg px-3 py-1.5 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <RichTextEditor
          content={editorContent}
          onChange={handleSave}
        />
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete Research Report"
        message={`Are you sure you want to delete "${report.topic}"?`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
