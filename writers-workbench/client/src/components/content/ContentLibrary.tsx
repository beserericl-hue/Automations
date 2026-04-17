import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import ConfirmDialog from '../shared/ConfirmDialog';
import Pagination from '../shared/Pagination';
import type { PublishedContent } from '../../types/database';

type ContentType = 'all' | 'chapter' | 'short_story' | 'blog_post' | 'newsletter';
type SortField = 'updated_at' | 'title' | 'status' | 'content_type';

const contentTypeLabels: Record<string, string> = {
  chapter: 'Chapter',
  short_story: 'Short Story',
  blog_post: 'Blog Post',
  newsletter: 'Newsletter',
};

const statusColors: Record<string, string> = {
  published: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  scheduled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
};

export default function ContentLibrary() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [searchParams, setSearchParams] = useSearchParams();

  // Filters from URL params or defaults
  const [typeFilter, setTypeFilter] = useState<ContentType>(
    (searchParams.get('type') as ContentType) || 'all'
  );
  const [statusFilter, setStatusFilter] = useState('all');
  const [genreFilter, setGenreFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('updated_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Fetch all content
  const { data: items, isLoading, isError, error } = useQuery({
    queryKey: ['content-library', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('published_content_v2')
        .select('*')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as PublishedContent[];
    },
    enabled: !!userId,
  });

  // Fetch projects for filter dropdown
  const { data: projects } = useQuery({
    queryKey: ['projects-filter', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('id, title')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('title');
      if (error) throw error;
      return data as { id: string; title: string }[];
    },
    enabled: !!userId,
  });

  // Extract unique genres from content
  const genres = useMemo(() => {
    if (!items) return [];
    const set = new Set(items.map(i => i.genre_slug).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [items]);

  // Client-side filtering and sorting
  const filtered = useMemo(() => {
    if (!items) return [];
    let result = items;

    if (typeFilter !== 'all') {
      result = result.filter(i => i.content_type === typeFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter(i => i.status === statusFilter);
    }
    if (genreFilter !== 'all') {
      result = result.filter(i => i.genre_slug === genreFilter);
    }
    if (projectFilter !== 'all') {
      result = result.filter(i => i.project_id === projectFilter);
    }

    result = [...result].sort((a, b) => {
      const aVal = a[sortField] ?? '';
      const bVal = b[sortField] ?? '';
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [items, typeFilter, statusFilter, genreFilter, projectFilter, sortField, sortAsc]);

  // Paginate
  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, currentPage, pageSize]);


  // Bulk actions
  const bulkApproveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from('published_content_v2')
        .update({ status: 'approved' })
        .in('id', ids)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-library'] });
      setSelectedIds(new Set());
    },
  });

  const bulkPublishMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from('published_content_v2')
        .update({ status: 'published', published_at: new Date().toISOString() })
        .in('id', ids)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-library'] });
      setSelectedIds(new Set());
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from('published_content_v2')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['content-library'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      setSelectedIds(new Set());
      setShowBulkDelete(false);
    },
  });

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortIndicator = (field: SortField) => {
    if (field !== sortField) return '';
    return sortAsc ? ' \u2191' : ' \u2193';
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(i => i.id)));
    }
  };

  const handleTypeChange = (type: ContentType) => {
    setTypeFilter(type);
    if (type === 'all') {
      searchParams.delete('type');
    } else {
      searchParams.set('type', type);
    }
    setSearchParams(searchParams, { replace: true });
  };

  const selectedArray = Array.from(selectedIds);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Content Library</h1>
        {items && (
          <span className="text-sm text-gray-400">{filtered.length} of {items.length} items</span>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={typeFilter}
          onChange={(e) => handleTypeChange(e.target.value as ContentType)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          <option value="all">All types</option>
          <option value="chapter">Chapters</option>
          <option value="short_story">Short Stories</option>
          <option value="blog_post">Blog Posts</option>
          <option value="newsletter">Newsletters</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="published">Published</option>
          <option value="rejected">Rejected</option>
          <option value="scheduled">Scheduled</option>
        </select>

        <select
          value={genreFilter}
          onChange={(e) => setGenreFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          <option value="all">All genres</option>
          {genres.map(g => (
            <option key={g} value={g}>{g.replace(/-/g, ' ')}</option>
          ))}
        </select>

        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        >
          <option value="all">All projects</option>
          {projects?.map(p => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>

        {(typeFilter !== 'all' || statusFilter !== 'all' || genreFilter !== 'all' || projectFilter !== 'all') && (
          <button
            onClick={() => {
              handleTypeChange('all');
              setStatusFilter('all');
              setGenreFilter('all');
              setProjectFilter('all');
            }}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-brand-50 px-4 py-2 dark:bg-brand-950">
          <span className="text-sm font-medium text-brand-700 dark:text-brand-300">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => bulkApproveMutation.mutate(selectedArray)}
            disabled={bulkApproveMutation.isPending}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => bulkPublishMutation.mutate(selectedArray)}
            disabled={bulkPublishMutation.isPending}
            className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Publish
          </button>
          <button
            onClick={() => setShowBulkDelete(true)}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Delete
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
          >
            Deselect all
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading...</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-600 dark:text-red-400">
            Failed to load content: {error?.message || 'Unknown error'}
          </div>
        ) : paginatedItems.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            {items?.length ? 'No items match the current filters.' : 'No content yet. Use the chat or Eve to create content.'}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filtered.length && filtered.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                </th>
                <th
                  onClick={() => handleSort('title')}
                  className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Title{sortIndicator('title')}
                </th>
                <th
                  onClick={() => handleSort('content_type')}
                  className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Type{sortIndicator('content_type')}
                </th>
                <th
                  onClick={() => handleSort('status')}
                  className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Status{sortIndicator('status')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Genre
                </th>
                <th
                  onClick={() => handleSort('updated_at')}
                  className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Updated{sortIndicator('updated_at')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {paginatedItems.map((item) => (
                <tr
                  key={item.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors ${
                    selectedIds.has(item.id) ? 'bg-brand-50/50 dark:bg-brand-950/30' : ''
                  }`}
                >
                  <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                    />
                  </td>
                  <td className="px-4 py-3" onClick={() => navigate(`/content/${item.id}`)}>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{item.title}</span>
                    {item.chapter_number != null && (
                      <span className="ml-2 text-xs text-gray-400">Ch. {item.chapter_number}</span>
                    )}
                  </td>
                  <td className="px-4 py-3" onClick={() => navigate(`/content/${item.id}`)}>
                    <span className="text-xs text-gray-500">
                      {contentTypeLabels[item.content_type] || item.content_type}
                    </span>
                  </td>
                  <td className="px-4 py-3" onClick={() => navigate(`/content/${item.id}`)}>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[item.status] || ''}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500" onClick={() => navigate(`/content/${item.id}`)}>
                    {item.genre_slug?.replace(/-/g, ' ') || '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400" onClick={() => navigate(`/content/${item.id}`)}>
                    {new Date(item.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <Pagination
        currentPage={currentPage}
        totalItems={filtered.length}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={showBulkDelete}
        onClose={() => setShowBulkDelete(false)}
        onConfirm={() => bulkDeleteMutation.mutate(selectedArray)}
        title="Delete Selected Content"
        message={`Are you sure you want to delete ${selectedIds.size} item(s)?`}
        confirmLabel="Delete All"
        variant="danger"
        loading={bulkDeleteMutation.isPending}
      />
    </div>
  );
}
