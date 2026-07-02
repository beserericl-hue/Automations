import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useMemo, useEffect, useRef } from 'react';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import RichTextEditor from '../editor/RichTextEditor';
import ConfirmDialog from '../shared/ConfirmDialog';
import VersionHistory from './VersionHistory';
import ImageGallery from '../images/ImageGallery';
import { contentToHtml } from '../../lib/content-utils';
import QAReportPanel from './QAReportPanel';
import AnnotationsPanel from './AnnotationsPanel';
import ProvenancePanel from './ProvenancePanel';
import RewriteWithResearchModal from './RewriteWithResearchModal';
import { useChapterRepair } from '../../hooks/useChapterRepair';
import type { PublishedContent, GeneratedImage } from '../../types/database';

export default function ContentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile, isImpersonating } = useUser();
  const userId = profile?.user_id;
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [versionCount, setVersionCount] = useState(0);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [showRewriteModal, setShowRewriteModal] = useState(false);

  const { data: item, isLoading, isError, error } = useQuery({
    queryKey: ['content-detail', id, isImpersonating],
    queryFn: async () => {
      if (isImpersonating) {
        const res = await apiFetch<ApiEnvelope<PublishedContent>>(`/api/impersonate/data/content/${id}`);
        if (!res.data) throw new Error('Content not found');
        return res.data;
      }
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .maybeSingle();  // missing/deleted id -> null -> not-found state (no coerce crash)
      if (error) throw error;
      return (data as PublishedContent) ?? null;
    },
    enabled: !!id && !!userId,
  });

  // Save content mutation
  const saveMutation = useMutation({
    mutationFn: async (html: string) => {
      setSaveStatus('saving');

      if (isImpersonating) {
        await apiFetch(`/api/impersonate/write/content/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content_text: html }),
        });
        await apiFetch('/api/impersonate/write/content-versions', {
          method: 'POST',
          body: JSON.stringify({
            content_id: id,
            content_text: html,
            changed_by: 'web_editor_impersonation',
            change_note: 'Auto-saved during superuser impersonation',
          }),
        });
        return;
      }

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
      // Each save snapshots a new content_versions_v2 row — refresh the Version History list too, else
      // the panel shows a stale (cached) version list until a full page reload.
      queryClient.invalidateQueries({ queryKey: ['content-versions', id] });
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

      if (isImpersonating) {
        await apiFetch(`/api/impersonate/write/content/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        });
        return;
      }
      // CR-010 B2: route lifecycle through the engine (library.lifecycle) so the auto-version
      // snapshot + approve/publish/reject/schedule notification email happen — the old direct
      // Supabase status write silently skipped both. Map the target status to a lifecycle action.
      const action =
        newStatus === 'approved' ? 'approve'
        : newStatus === 'published' ? 'publish'
        : newStatus === 'rejected' ? 'reject'
        : newStatus === 'scheduled' ? 'schedule'
        : newStatus === 'draft' && item?.status === 'scheduled' ? 'unschedule'
        : 'draft';
      await apiFetch(`/api/content/${id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
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
      if (isImpersonating) {
        await apiFetch(`/api/impersonate/write/content/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'scheduled', metadata: meta }),
        });
        return;
      }
      // CR-010 B2: schedule through the engine lifecycle op (snapshot is skipped for schedule, but it
      // sends the "scheduled" notification email and records schedule_date) instead of a direct write.
      await apiFetch(`/api/content/${id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action: 'schedule', schedule_date: dateStr }),
      });
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
      if (isImpersonating) {
        await apiFetch(`/api/impersonate/write/content/${id}`, { method: 'DELETE' });
        return;
      }
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
      if (isImpersonating) {
        await apiFetch(`/api/impersonate/write/content/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ cover_image_path: imagePath }),
        });
        return;
      }
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
            <span>Created {new Date(item.created_at).toLocaleDateString()}</span>
            <span>Updated {new Date(item.updated_at).toLocaleString()}</span>
            <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
              ID: {item.id.substring(0, 8)}
            </span>
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

          {item.content_type === 'chapter' && (
            <button
              onClick={() => setShowRewriteModal(true)}
              title="Rewrite this chapter grounded in real research (S12-6)"
              className="rounded-lg px-3 py-1.5 text-xs font-medium border border-purple-300 text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:text-purple-400 dark:hover:bg-purple-950"
            >
              Rewrite with research
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

      {showRewriteModal && item.content_type === 'chapter' && (
        <RewriteWithResearchModal
          contentId={item.id}
          chapterLabel={
            item.chapter_number != null ? `Chapter ${item.chapter_number}` : item.title || 'Chapter'
          }
          hasQaReport={!!(item.metadata as Record<string, unknown> | null | undefined)?.['last_qa_report']}
          projectType={
            (item.metadata as Record<string, unknown> | null | undefined)?.['project_type'] as string | undefined
          }
          onClose={() => setShowRewriteModal(false)}
        />
      )}

      {/* Cover image banner */}
      {item.cover_image_path ? (
        <div className="relative overflow-hidden rounded-lg">
          <img
            src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/cover-images/${item.cover_image_path.split('/').map(s => encodeURIComponent(s)).join('/')}`}
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

      {/* Engine QA/drift (CR-005): the engine stores drift + craft-QA in the chapter metadata. */}
      {item.content_type === 'chapter' && <EngineQaPanel metadata={item.metadata} contentId={id!} />}

      {/* Q/A Report (for chapters) */}
      {item.content_type === 'chapter' && (
        <QAReportPanel
          metadata={item.metadata}
          contentId={id!}
          contentTitle={item.title}
          chapterNumber={item.chapter_number}
          projectId={item.project_id}
          userId={userId!}
        />
      )}

      {/* S12-13 — shared review-annotations panel (drift_scan + genre_eval) */}
      {item.content_type === 'chapter' && <AnnotationsPanel contentId={id!} />}

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

// CR-008 B: surface the engine's per-chapter QA + drift (stored in published_content_v2.metadata by
// CR-005) on the chapter detail page — the old QAReportPanel only reads the n8n last_qa_report field.
// CR-008/009: a "Fix drift" action runs the engine repair op (drift-correct + research + line-edit).
function EngineQaPanel({ metadata, contentId }: { metadata: Record<string, unknown> | null | undefined; contentId: string }) {
  // CR-010 B2: non-blocking Fix Drift + Cancel, shared with the Chapters-table button via the hook —
  // the click queues the engine repair and returns immediately; a background poller refreshes this
  // panel when the new drift scan lands. (Was a blocking while/setTimeout loop.)
  const { state, jobId, queue, cancel, cancelling } = useChapterRepair(contentId, [['content-detail', contentId]]);
  const m = (metadata || {}) as Record<string, unknown>;
  const qa = m.craft_qa as Record<string, number> | null | undefined;
  const drift = m.drift_report as
    | { aligned?: boolean; story_drift?: string[]; character_drift?: string[]; research_gaps?: string[] }
    | null
    | undefined;
  if (!qa && !drift) return null;
  const qaEntries = qa ? Object.entries(qa).filter(([, v]) => typeof v === 'number') : [];
  const qaAvg = qaEntries.length ? qaEntries.reduce((a, [, v]) => a + v, 0) / qaEntries.length : null;
  const story = drift?.story_drift ?? [];
  const chars = drift?.character_drift ?? [];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Engine QA</h3>
        {drift?.aligned != null && (
          <span className={`rounded px-2 py-0.5 text-xs ${drift.aligned
            ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}`}>
            {drift.aligned ? 'Aligned to outline ✓' : 'Drift detected'}
          </span>
        )}
        {qaAvg != null && <span className="text-xs text-gray-500">Craft QA {qaAvg.toFixed(2)}</span>}
        {drift?.aligned === false && (
          <span className="ml-auto inline-flex items-center gap-1">
            <button
              onClick={queue}
              disabled={state === 'queued'}
              title="Queue the engine repair op (correct drift vs outline/roster, weave research, line-edit). Runs in the background — the panel refreshes when it's done."
              className="rounded border border-amber-400 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950"
            >
              {state === 'queued' ? 'Queued — fixing…' : state === 'error' ? 'Retry fix' : 'Fix drift'}
            </button>
            {state === 'queued' && jobId && (
              <button
                onClick={cancel}
                disabled={cancelling}
                title="Cancel this repair job. A queued job is dropped before it runs; a running job stops at its next step. Saved versions are unchanged."
                className="rounded border border-rose-300 px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </span>
        )}
      </div>
      {qaEntries.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          {qaEntries.map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs">
              <span className="text-gray-500">{k.replace(/_/g, ' ')}</span>
              <span className="text-gray-900 dark:text-gray-200">{v.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
      {(story.length > 0 || chars.length > 0) && (
        <div className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-800">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Outstanding drift</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-gray-600 dark:text-gray-400">
            {[...story, ...chars].slice(0, 8).map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}
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
