import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from '../../contexts/UserContext';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../config/supabase';
import type { UserProfile } from '../../types/database';

interface AdminUser extends UserProfile {
  content_count: number;
  project_count: number;
}

interface AdminMetrics {
  totalUsers: number;
  totalContent: number;
  totalProjects: number;
  totalResearch: number;
  totalImages: number;
  totalSocialPosts: number;
  contentByStatus: Record<string, number>;
  contentByType: Record<string, number>;
}

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Request failed');
  return json.data;
}

export default function AdminPanel() {
  const { profile } = useUser();
  const [activeTab, setActiveTab] = useState<'users' | 'metrics' | 'workflows'>('users');

  if (!profile?.isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-gray-500">You do not have admin access.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Admin Panel</h1>

      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-800">
        {(['users', 'metrics', 'workflows'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'users' ? 'User Management' : tab === 'metrics' ? 'System Metrics' : 'Workflows'}
          </button>
        ))}
      </div>

      {activeTab === 'users' && <UserManagement />}
      {activeTab === 'metrics' && <SystemMetrics />}
      {activeTab === 'workflows' && <WorkflowStatus />}
    </div>
  );
}

function UserManagement() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<string>('user');

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminFetch<AdminUser[]>('/users'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      adminFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ phone: newPhone, display_name: newName, email: newEmail, role: newRole }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setCreating(false);
      setNewPhone('');
      setNewName('');
      setNewEmail('');
      setNewRole('user');
      addToast('User created successfully', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      adminFetch(`/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditingId(null);
      addToast('Role updated', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (userId: string) =>
      adminFetch(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      addToast('User deactivated', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const filtered = (users || []).filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.display_name?.toLowerCase().includes(q) ||
      u.phone_number?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users..."
          className={inputClass + ' flex-1'}
        />
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + Pre-create User
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Pre-create User Account</h3>
          <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (+14105551234)" className={inputClass} />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Display Name" className={inputClass} />
          <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" className={inputClass} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className={inputClass}>
            <option value="user">User</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!newPhone.trim() || !newName.trim() || !newEmail.trim() || createMutation.isPending}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <UserTableSkeleton />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Email</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Role</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Content</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Projects</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((u) => (
                <tr key={u.user_id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{u.display_name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.phone_number}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.email || '—'}</td>
                  <td className="px-4 py-3">
                    {editingId === u.user_id ? (
                      <select
                        defaultValue={u.role}
                        onChange={(e) => updateRoleMutation.mutate({ userId: u.user_id, role: e.target.value })}
                        onBlur={() => setEditingId(null)}
                        autoFocus
                        className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                      >
                        <option value="user">user</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                        <option value="admin">admin</option>
                      </select>
                    ) : (
                      <button
                        onClick={() => setEditingId(u.user_id)}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadge[u.role] || roleBadge.user}`}
                        title="Click to change role"
                      >
                        {u.role}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.content_count}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.project_count}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => {
                        if (confirm(`Deactivate ${u.display_name || u.phone_number}? This sets their role to viewer.`)) {
                          deactivateMutation.mutate(u.user_id);
                        }
                      }}
                      className="text-xs text-red-600 hover:text-red-800 dark:text-red-400"
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                    {search ? 'No users match your search.' : 'No users found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SystemMetrics() {
  const { data: metrics, isLoading } = useQuery({
    queryKey: ['admin-metrics'],
    queryFn: () => adminFetch<AdminMetrics>('/metrics'),
  });

  if (isLoading) return <MetricsSkeleton />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard label="Users" value={metrics?.totalUsers ?? 0} />
        <MetricCard label="Content" value={metrics?.totalContent ?? 0} />
        <MetricCard label="Projects" value={metrics?.totalProjects ?? 0} />
        <MetricCard label="Research" value={metrics?.totalResearch ?? 0} />
        <MetricCard label="Images" value={metrics?.totalImages ?? 0} />
        <MetricCard label="Social Posts" value={metrics?.totalSocialPosts ?? 0} />
      </div>

      {metrics?.contentByStatus && Object.keys(metrics.contentByStatus).length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Content by Status</h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(metrics.contentByStatus).map(([status, count]) => (
              <div key={status} className="flex items-center gap-2">
                <StatusIcon status={status} />
                <span className="text-sm text-gray-600 dark:text-gray-400 capitalize">{status}</span>
                <span className="text-sm font-semibold text-gray-900 dark:text-white">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {metrics?.contentByType && Object.keys(metrics.contentByType).length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Content by Type</h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(metrics.contentByType).map(([type, count]) => (
              <div key={type} className="rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-2">
                <span className="text-xs text-gray-500 capitalize">{type.replace('_', ' ')}</span>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{count}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowStatus() {
  const { data: executions, isLoading, error } = useQuery({
    queryKey: ['admin-workflows'],
    queryFn: () => adminFetch<Array<{ id: string; workflowId: string; finished: boolean; mode: string; startedAt: string; stoppedAt: string | null; status: string; workflowData?: { name?: string } }>>('/workflows'),
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading workflow executions...</div>;
  if (error) return <div className="text-sm text-red-500">Failed to load workflows: {(error as Error).message}</div>;

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Workflow</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Mode</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Started</th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {(executions || []).map((exec) => {
            const duration = exec.stoppedAt && exec.startedAt
              ? Math.round((new Date(exec.stoppedAt).getTime() - new Date(exec.startedAt).getTime()) / 1000)
              : null;
            return (
              <tr key={exec.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">
                  {exec.workflowData?.name || exec.workflowId}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    exec.status === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300' :
                    exec.status === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300' :
                    exec.status === 'running' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300' :
                    'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                  }`}>
                    {exec.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{exec.mode}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{new Date(exec.startedAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{duration !== null ? `${duration}s` : '—'}</td>
              </tr>
            );
          })}
          {(!executions || executions.length === 0) && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">No recent executions.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const cls = 'h-3 w-3 rounded-full inline-block';
  switch (status) {
    case 'published': return <span className={`${cls} bg-green-500`} />;
    case 'approved': return <span className={`${cls} bg-blue-500`} />;
    case 'draft': return <span className={`${cls} bg-gray-400`} />;
    case 'rejected': return <span className={`${cls} bg-red-500`} />;
    case 'scheduled': return <span className={`${cls} bg-yellow-500`} />;
    default: return <span className={`${cls} bg-gray-300`} />;
  }
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

function UserTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ))}
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ))}
    </div>
  );
}

const roleBadge: Record<string, string> = {
  admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  editor: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  viewer: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  user: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
};

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';
