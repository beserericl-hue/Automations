import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useMemo } from 'react';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import RichTextEditor from '../editor/RichTextEditor';
import ConfirmDialog from '../shared/ConfirmDialog';
import VersionHistory from './VersionHistory';
import { contentToHtml } from '../../lib/content-utils';
import type { PublishedContent } from '../../types/database';

export default function ContentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [versionCount, setVersionCount] = useState(0);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  const { data: item, isLoading, isError, error } = useQuery({
    queryKey: ['content-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .single();
      if (error) throw error;
      return data as PublishedContent;
    },
    enabled: !!id && !!userId,
  });

  // Save content mutation
  const saveMutation = useMutation({
    mutationFn: async (html: string) => {
      setSaveStatus('saving');
      const { error } = await supabase
        .from('published_content_v2')
        .update({
          content_text: html,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;

      // Create version snapshot
      const { data: versions } = await supabase
        .from('content_versions_v2')
        .select('version_number')
        .eq('content_id', id!)
        .order('version_number', { ascending: false })
        .limit(1);

      const nextVersion = (versions?.[0]?.version_number ?? 0) + 1;

      await supabase.from('content_versions_v2').insert({
        user_id: userId!,
        content_id: id!,
        version_number: nextVersion,
        content_text: html,
        changed_by: 'web_editor',
        change_note: 'Auto-saved from editor',
      });
    },
    onSuccess: () => {
      setSaveStatus('saved');
      queryClient.invalidateQueries({ queryKey: ['content-detail', id] });
      setTimeout(() => setSaveStatus(null), 3000);
    },
    onError: () => {
      setSaveStatus('error');
    },
  });

  // Status change mutation
  const statusMutation = useMutation({
    mutationFn: async (newStatus: string) => {
      const updates: Record<string, unknown> = {
        status: newStatus,
        updated_at: new Date().toISOString(),
      };
      if (newStatus === 'published') {
        updates.published_at = new Date().toISOString();
      }
      const { error } = await supabase
        .from('published_content_v2')
        .update(updates)
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['content-list'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-recent'] });
    },
  });

  // Soft delete mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('published_content_v2')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-list'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-recent'] });
      navigate(-1);
    },
  });

  const handleDeleteClick = async () => {
    // Get cascade count (content versions)
    const { count } = await supabase
      .from('content_versions_v2')
      .select('id', { count: 'exact', head: true })
      .eq('content_id', id!);
    setVersionCount(count ?? 0);
    setShowDeleteConfirm(true);
  };

  const handleSave = useCallback((html: string) => {
    saveMutation.mutate(html);
  }, [saveMutation]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-red-600 dark:text-red-400">
        Failed to load content: {error?.message || 'Unknown error'}
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <p className="text-sm text-gray-500">Content not found.</p>
        <button onClick={() => navigate(-1)} className="text-sm text-brand-600 hover:text-brand-700">Go back</button>
      </div>
    );
  }

  const statusActions = getStatusActions(item.status);

  // Convert markdown/plain text to HTML for TipTap on first load
  const editorContent = useMemo(() => contentToHtml(item.content_text), [item.content_text]);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <button onClick={() => navigate(-1)} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back</button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white truncate">{item.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-400">
            <span className="capitalize">{item.content_type.replace('_', ' ')}</span>
            {item.genre_slug && <span>{item.genre_slug.replace(/-/g, ' ')}</span>}
            {item.chapter_number != null && <span>Chapter {item.chapter_number}</span>}
            <span>Updated {new Date(item.updated_at).toLocaleDateString()}</span>
          </div>
        </div>

        {/* Status + actions */}
        <div className="flex items-center gap-2 shrink-0">
          {saveStatus === 'saving' && <span className="text-xs text-gray-400">Saving...</span>}
          {saveStatus === 'saved' && <span className="text-xs text-green-500">Saved</span>}
          {saveStatus === 'error' && <span className="text-xs text-red-500">Save failed</span>}

          <StatusBadge status={item.status} />

          {statusActions.map((action) => (
            <button
              key={action.status}
              onClick={() => {
                if (action.needsConfirm) {
                  setPendingStatus(action.status);
                } else {
                  statusMutation.mutate(action.status);
                }
              }}
              disabled={statusMutation.isPending}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${action.className}`}
            >
              {action.label}
            </button>
          ))}

          <button
            onClick={handleDeleteClick}
            className="rounded-lg px-3 py-1.5 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Editor + Version History */}
      <div className="flex flex-1 min-h-0 gap-4">
        <div className="flex-1 min-w-0">
          <RichTextEditor
            content={editorContent}
            onChange={handleSave}
          />
        </div>
        <VersionHistory
          contentId={id!}
          onRestore={() => {
            queryClient.invalidateQueries({ queryKey: ['content-detail', id] });
          }}
        />
      </div>

      <ConfirmDialog
        open={!!pendingStatus}
        onClose={() => setPendingStatus(null)}
        onConfirm={() => {
          if (pendingStatus) statusMutation.mutate(pendingStatus);
          setPendingStatus(null);
        }}
        title="Change Status"
        message={`Are you sure you want to ${pendingStatus === 'rejected' ? 'reject' : pendingStatus === 'approved' ? 'unpublish' : 'unschedule'} "${item.title}"?`}
        confirmLabel="Confirm"
        variant="warning"
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete Content"
        message={`Are you sure you want to delete "${item.title}"?`}
        cascadeInfo={versionCount > 0 ? [`${versionCount} version history entries will be deleted`] : undefined}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteMutation.isPending}
      />
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
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${colors[status] || ''}`}>
      {status}
    </span>
  );
}

interface StatusAction {
  label: string;
  status: string;
  className: string;
  needsConfirm?: boolean;
}

function getStatusActions(currentStatus: string): StatusAction[] {
  switch (currentStatus) {
    case 'draft':
      return [
        { label: 'Approve', status: 'approved', className: 'bg-blue-600 text-white hover:bg-blue-700' },
        { label: 'Reject', status: 'rejected', className: 'border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400', needsConfirm: true },
      ];
    case 'approved':
      return [
        { label: 'Publish', status: 'published', className: 'bg-green-600 text-white hover:bg-green-700' },
        { label: 'Back to Draft', status: 'draft', className: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400' },
      ];
    case 'published':
      return [
        { label: 'Unpublish', status: 'approved', className: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400', needsConfirm: true },
      ];
    case 'rejected':
      return [
        { label: 'Back to Draft', status: 'draft', className: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400' },
      ];
    case 'scheduled':
      return [
        { label: 'Unschedule', status: 'draft', className: 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400', needsConfirm: true },
        { label: 'Publish Now', status: 'published', className: 'bg-green-600 text-white hover:bg-green-700' },
      ];
    default:
      return [];
  }
}
