import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useMemo, useEffect, useRef } from 'react';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import RichTextEditor from '../editor/RichTextEditor';
import ConfirmDialog from '../shared/ConfirmDialog';
import VersionHistory from './VersionHistory';
import ImageGallery from '../images/ImageGallery';
import { contentToHtml } from '../../lib/content-utils';
import QAReportPanel from './QAReportPanel';
import ProvenancePanel from './ProvenancePanel';
import type { PublishedContent, GeneratedImage } from '../../types/database';

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
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [showImagePicker, setShowImagePicker] = useState(false);

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
      // Clear schedule_date when unscheduling
      if (newStatus !== 'scheduled' && item?.status === 'scheduled') {
        const meta = { ...(item.metadata || {}) };
        delete meta.schedule_date;
        updates.metadata = meta;
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

  // Schedule mutation
  const scheduleMutation = useMutation({
    mutationFn: async (dateStr: string) => {
      const meta = { ...(item?.metadata || {}), schedule_date: dateStr };
      const { error } = await supabase
        .from('published_content_v2')
        .update({
          status: 'scheduled',
          metadata: meta,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      setShowSchedulePicker(false);
      setScheduleDate('');
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

  // Cover image mutation
  const coverImageMutation = useMutation({
    mutationFn: async (imagePath: string | null) => {
      const { error } = await supabase
        .from('published_content_v2')
        .update({ cover_image_path: imagePath, updated_at: new Date().toISOString() })
        .eq('id', id!)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-detail', id] });
      setShowImagePicker(false);
    },
  });

  const handleSelectCoverImage = (image: GeneratedImage) => {
    coverImageMutation.mutate(image.storage_path);
  };

  const handleDeleteClick = async () => {
    // Get cascade count (content versions)
    const { count } = await supabase
      .from('content_versions_v2')
      .select('id', { count: 'exact', head: true })
      .eq('content_id', id!);
    setVersionCount(count ?? 0);
    setShowDeleteConfirm(true);
  };

  const latestContentRef = useRef<string | null>(null);

  const handleSave = useCallback((html: string) => {
    latestContentRef.current = html;
    saveMutation.mutate(html);
  }, [saveMutation]);

  // Ctrl+S / Cmd+S to save immediately
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (latestContentRef.current) {
          saveMutation.mutate(latestContentRef.current);
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [saveMutation]);

  // Convert markdown/plain text to HTML for TipTap on first load
  // Must be before early returns to maintain consistent hook order
  const editorContent = useMemo(() => contentToHtml(item?.content_text ?? null), [item?.content_text]);

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

          {/* Schedule button — available for draft and approved content */}
          {item.status !== 'scheduled' && item.status !== 'published' && (
            <button
              onClick={() => setShowSchedulePicker(!showSchedulePicker)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium border border-yellow-300 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-700 dark:text-yellow-400 dark:hover:bg-yellow-950"
            >
              Schedule
            </button>
          )}

          <button
            onClick={handleDeleteClick}
            className="rounded-lg px-3 py-1.5 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Cover image banner */}
      {item.cover_image_path ? (
        <div className="relative overflow-hidden rounded-lg">
          <img
            src={supabase.storage.from('cover-images').getPublicUrl(item.cover_image_path).data.publicUrl}
            alt={`Cover for ${item.title}`}
            className="h-48 w-full object-cover"
          />
          <div className="absolute bottom-2 right-2 flex gap-1">
            <button
              onClick={() => setShowImagePicker(true)}
              className="rounded bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/80"
            >
              Change Cover
            </button>
            <button
              onClick={() => coverImageMutation.mutate(null)}
              className="rounded bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/80"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 py-3 dark:border-gray-700">
          <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
          <span className="text-sm text-gray-500">No cover image</span>
          <button
            onClick={() => setShowImagePicker(true)}
            className="ml-auto rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Choose from Gallery
          </button>
        </div>
      )}

      {/* Image picker modal */}
      {showImagePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowImagePicker(false)}>
          <div className="max-h-[80vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-6 shadow-2xl dark:bg-gray-900" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Select Cover Image</h3>
              <button onClick={() => setShowImagePicker(false)} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <ImageGallery onSelectImage={handleSelectCoverImage} />
          </div>
        </div>
      )}

      {/* Scheduled date display */}
      {item.status === 'scheduled' && typeof item.metadata?.schedule_date === 'string' && (
        <div className="flex items-center gap-2 rounded-lg bg-yellow-50 border border-yellow-200 px-4 py-2 dark:bg-yellow-900/20 dark:border-yellow-800">
          <span className="text-xs text-yellow-700 dark:text-yellow-400">
            Scheduled for: {new Date(item.metadata.schedule_date).toLocaleString()}
          </span>
        </div>
      )}

      {/* Schedule date picker */}
      {showSchedulePicker && (
        <div className="flex items-center gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 dark:bg-yellow-900/20 dark:border-yellow-800">
          <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Publish on:</label>
          <input
            type="datetime-local"
            value={scheduleDate}
            onChange={e => setScheduleDate(e.target.value)}
            min={new Date().toISOString().slice(0, 16)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          />
          <button
            onClick={() => { if (scheduleDate) scheduleMutation.mutate(new Date(scheduleDate).toISOString()); }}
            disabled={!scheduleDate || scheduleMutation.isPending}
            className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-700 disabled:opacity-50"
          >
            {scheduleMutation.isPending ? 'Scheduling...' : 'Confirm Schedule'}
          </button>
          <button
            onClick={() => { setShowSchedulePicker(false); setScheduleDate(''); }}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Q/A Report (for chapters) */}
      {item.content_type === 'chapter' && (
        <QAReportPanel metadata={item.metadata} />
      )}

      {/* Sources / Provenance */}
      <ProvenancePanel contentId={id!} />

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
