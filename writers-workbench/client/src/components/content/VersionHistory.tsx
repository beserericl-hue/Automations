import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import { diffWords } from 'diff';
import type { ContentVersion } from '../../types/database';

interface VersionHistoryProps {
  contentId: string;
  onRestore: (html: string) => void;
}

type ViewMode = 'list' | 'view' | 'compare';

export default function VersionHistory({ contentId, onRestore }: VersionHistoryProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedVersion, setSelectedVersion] = useState<ContentVersion | null>(null);
  const [compareVersions, setCompareVersions] = useState<[string, string]>(['', '']);

  const { data: versions, isLoading } = useQuery({
    queryKey: ['content-versions', contentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('content_versions_v2')
        .select('*')
        .eq('content_id', contentId)
        .order('version_number', { ascending: false });
      if (error) throw error;
      return data as ContentVersion[];
    },
    enabled: open,
  });

  const restoreMutation = useMutation({
    mutationFn: async (version: ContentVersion) => {
      // Update the content with the old version's text
      const { error: updateError } = await supabase
        .from('published_content_v2')
        .update({
          content_text: version.content_text,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId)
        .eq('user_id', userId!);
      if (updateError) throw updateError;

      // Create a new version snapshot
      const nextVersion = (versions?.[0]?.version_number ?? 0) + 1;
      const { error: insertError } = await supabase
        .from('content_versions_v2')
        .insert({
          user_id: userId!,
          content_id: contentId,
          version_number: nextVersion,
          content_text: version.content_text,
          changed_by: 'web_editor',
          change_note: `Restored from version ${version.version_number}`,
        });
      if (insertError) throw insertError;
    },
    onSuccess: (_, version) => {
      queryClient.invalidateQueries({ queryKey: ['content-versions', contentId] });
      queryClient.invalidateQueries({ queryKey: ['content-detail', contentId] });
      onRestore(version.content_text);
      setViewMode('list');
      setSelectedVersion(null);
    },
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
      >
        <HistoryIcon />
        History
      </button>
    );
  }

  const renderDiff = (oldText: string, newText: string) => {
    // Strip HTML tags for cleaner diff
    const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const changes = diffWords(strip(oldText), strip(newText));

    return (
      <div className="text-xs leading-relaxed whitespace-pre-wrap font-mono p-3 bg-gray-50 dark:bg-gray-800 rounded-lg max-h-96 overflow-y-auto">
        {changes.map((change, i) => (
          <span
            key={i}
            className={
              change.added
                ? 'bg-green-200 dark:bg-green-900 text-green-900 dark:text-green-200'
                : change.removed
                ? 'bg-red-200 dark:bg-red-900 text-red-900 dark:text-red-200 line-through'
                : 'text-gray-700 dark:text-gray-300'
            }
          >
            {change.value}
          </span>
        ))}
      </div>
    );
  };

  const getCompareVersions = () => {
    if (!versions) return null;
    const v1 = versions.find(v => v.id === compareVersions[0]);
    const v2 = versions.find(v => v.id === compareVersions[1]);
    if (!v1 || !v2) return null;
    return { older: v1.version_number < v2.version_number ? v1 : v2, newer: v1.version_number > v2.version_number ? v1 : v2 };
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 w-80 shrink-0">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Version History
        </h3>
        <button
          onClick={() => { setOpen(false); setViewMode('list'); }}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Close
        </button>
      </div>

      <div className="p-3 max-h-[600px] overflow-y-auto">
        {viewMode === 'list' && (
          <>
            {isLoading ? (
              <p className="text-xs text-gray-500">Loading versions...</p>
            ) : !versions?.length ? (
              <p className="text-xs text-gray-500">No version history yet.</p>
            ) : (
              <>
                <div className="mb-3">
                  <button
                    onClick={() => setViewMode('compare')}
                    disabled={!versions || versions.length < 2}
                    className="text-xs text-brand-600 hover:text-brand-700 disabled:text-gray-400 disabled:cursor-not-allowed"
                  >
                    Compare versions
                  </button>
                </div>
                <div className="space-y-2">
                  {versions.map(version => (
                    <div
                      key={version.id}
                      className="rounded-lg border border-gray-100 p-2.5 dark:border-gray-700"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-900 dark:text-white">
                          v{version.version_number}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(version.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {version.changed_by}
                        {version.change_note && <span> &mdash; {version.change_note}</span>}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => { setSelectedVersion(version); setViewMode('view'); }}
                          className="text-xs text-brand-600 hover:text-brand-700"
                        >
                          View
                        </button>
                        <button
                          onClick={() => restoreMutation.mutate(version)}
                          disabled={restoreMutation.isPending}
                          className="text-xs text-yellow-600 hover:text-yellow-700"
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {viewMode === 'view' && selectedVersion && (
          <div>
            <button
              onClick={() => { setViewMode('list'); setSelectedVersion(null); }}
              className="text-xs text-gray-400 hover:text-gray-600 mb-2"
            >
              &larr; Back to list
            </button>
            <h4 className="text-xs font-medium text-gray-900 dark:text-white mb-2">
              Version {selectedVersion.version_number}
            </h4>
            <div
              className="prose prose-sm dark:prose-invert max-h-96 overflow-y-auto rounded-lg border border-gray-100 p-3 text-xs dark:border-gray-700"
              dangerouslySetInnerHTML={{ __html: selectedVersion.content_text }}
            />
          </div>
        )}

        {viewMode === 'compare' && (
          <div>
            <button
              onClick={() => setViewMode('list')}
              className="text-xs text-gray-400 hover:text-gray-600 mb-2"
            >
              &larr; Back to list
            </button>
            <div className="space-y-2 mb-3">
              <label className="block">
                <span className="text-xs text-gray-500">Older version</span>
                <select
                  value={compareVersions[0]}
                  onChange={e => setCompareVersions([e.target.value, compareVersions[1]])}
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">Select...</option>
                  {versions?.map(v => (
                    <option key={v.id} value={v.id}>v{v.version_number} - {new Date(v.created_at).toLocaleString()}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Newer version</span>
                <select
                  value={compareVersions[1]}
                  onChange={e => setCompareVersions([compareVersions[0], e.target.value])}
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">Select...</option>
                  {versions?.map(v => (
                    <option key={v.id} value={v.id}>v{v.version_number} - {new Date(v.created_at).toLocaleString()}</option>
                  ))}
                </select>
              </label>
            </div>
            {(() => {
              const pair = getCompareVersions();
              if (!pair) return <p className="text-xs text-gray-400">Select two versions to compare.</p>;
              return (
                <div>
                  <p className="text-xs text-gray-500 mb-2">
                    v{pair.older.version_number} &rarr; v{pair.newer.version_number}
                  </p>
                  {renderDiff(pair.older.content_text, pair.newer.content_text)}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
