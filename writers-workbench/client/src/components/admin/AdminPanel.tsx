import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { UserProfile } from '../../types/database';

export default function AdminPanel() {
  const { profile } = useUser();
  const [activeTab, setActiveTab] = useState<'users' | 'metrics'>('users');

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
        {(['users', 'metrics'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'users' ? 'User Management' : 'System Metrics'}
          </button>
        ))}
      </div>

      {activeTab === 'users' && <UserManagement />}
      {activeTab === 'metrics' && <SystemMetrics />}
    </div>
  );
}

function UserManagement() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users_v2')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as UserProfile[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('users_v2').insert({
        user_id: newPhone,
        phone_number: newPhone,
        display_name: newName.trim(),
        email: newEmail.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setCreating(false);
      setNewPhone('');
      setNewName('');
      setNewEmail('');
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          + Pre-create User
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold">Pre-create User Account</h3>
          <input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="Phone (+14105551234)" className={inputClass} />
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Display Name" className={inputClass} />
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="Email (optional)" className={inputClass} />
          <div className="flex gap-2">
            <button onClick={() => createMutation.mutate()} disabled={!newPhone.trim()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50">Create</button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Email</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Auth Linked</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {users?.map(u => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{u.display_name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.phone_number}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{u.email || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`h-2 w-2 rounded-full inline-block ${u.supabase_auth_uid ? 'bg-green-500' : 'bg-gray-300'}`} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
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
    queryFn: async () => {
      const [usersRes, contentRes, projectsRes] = await Promise.all([
        supabase.from('users_v2').select('id', { count: 'exact', head: true }),
        supabase.from('published_content_v2').select('id', { count: 'exact', head: true }),
        supabase.from('writing_projects_v2').select('id', { count: 'exact', head: true }),
      ]);
      return {
        totalUsers: usersRes.count ?? 0,
        totalContent: contentRes.count ?? 0,
        totalProjects: projectsRes.count ?? 0,
      };
    },
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading...</div>;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MetricCard label="Total Users" value={metrics?.totalUsers ?? 0} />
      <MetricCard label="Total Content" value={metrics?.totalContent ?? 0} />
      <MetricCard label="Total Projects" value={metrics?.totalProjects ?? 0} />
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';
