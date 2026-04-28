import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from '../../contexts/UserContext';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../config/supabase';
import { usePermissions } from '../../hooks/usePermissions';
import PasswordInput from '../shared/PasswordInput';
import type { UserProfile, SubscriptionTier } from '../../types/database';

interface AdminUser extends UserProfile {
  content_count: number;
  project_count: number;
  // Sprint 8 enrichments returned by GET /api/admin/users
  account_status?: 'active' | 'locked' | 'suspended' | 'pending';
  locked_at?: string | null;
  locked_reason?: string | null;
  effective_role?: 'superuser' | 'admin' | 'user';
  subscription?: {
    credits_remaining: number;
    credits_used_this_period: number;
    status: string;
    billing_cycle: string;
    current_period_end: string | null;
    trial_end: string | null;
    tier: { name: string; display_name: string; monthly_credits: number };
  } | null;
}

interface AdminSubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  billing_cycle: string;
  current_period_start: string;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  credits_remaining: number;
  credits_used_this_period: number;
  auto_renew: boolean;
  tier: { id: string; name: string; display_name: string; monthly_credits: number; monthly_price_cents: number; annual_price_cents: number };
}

interface RevenueStats {
  mrr_cents: number;
  arr_cents: number;
  active_paid_subscribers: number;
  active_free_subscribers: number;
  active_trial_subscribers: number;
  expired_trials: number;
  subscribers_by_tier: Record<string, number>;
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

type AdminTab = 'users' | 'subscriptions' | 'revenue' | 'metrics' | 'workflows' | 'queues' | 'bounces';

const TAB_LABELS: Record<AdminTab, string> = {
  users: 'User Management',
  subscriptions: 'Subscriptions',
  revenue: 'Revenue',
  metrics: 'System Metrics',
  workflows: 'Workflows',
  queues: 'Queues',
  bounces: 'Email Bounces',
};

export default function AdminPanel() {
  const { profile } = useUser();
  const [activeTab, setActiveTab] = useState<AdminTab>('users');

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

      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-800">
        {(Object.keys(TAB_LABELS) as AdminTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {activeTab === 'users' && <UserManagement />}
      {activeTab === 'subscriptions' && <SubscriptionsTab />}
      {activeTab === 'revenue' && <RevenueTab />}
      {activeTab === 'metrics' && <SystemMetrics />}
      {activeTab === 'workflows' && <WorkflowStatus />}
      {activeTab === 'queues' && <QueueStatus />}
      {activeTab === 'bounces' && <BounceStatus />}
    </div>
  );
}

function UserManagement() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { isSuperuser } = usePermissions();
  const { startImpersonation, isImpersonating } = useUser();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'locked' | 'suspended'>('all');
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<string>('user');
  const [newTierName, setNewTierName] = useState<string>('standard');
  const [newBilling, setNewBilling] = useState<'monthly' | 'annual' | 'none'>('monthly');
  const [newIsFree, setNewIsFree] = useState(false);
  const [lockTarget, setLockTarget] = useState<AdminUser | null>(null);
  const [creditTarget, setCreditTarget] = useState<AdminUser | null>(null);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [tierTarget, setTierTarget] = useState<AdminUser | null>(null);

  // Sprint 8: admin tier list returns ALL active tiers (including
  // free_full / "Full Access (Comp)" which is admin-provisioned only and
  // therefore filtered out of the public /api/tiers endpoint that powers
  // the signup page).
  const { data: tiers } = useQuery({
    queryKey: ['admin-tiers'],
    queryFn: () => adminFetch<SubscriptionTier[]>('/tiers'),
    staleTime: 60_000,
  });

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminFetch<AdminUser[]>('/users'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      adminFetch('/users-with-subscription', {
        method: 'POST',
        body: JSON.stringify({
          phone: newPhone,
          display_name: newName,
          email: newEmail,
          role: newRole,
          tier_name: newIsFree ? 'free_full' : newTierName,
          billing_cycle: newIsFree ? 'none' : newBilling,
          is_free: newIsFree,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setCreating(false);
      setNewPhone('');
      setNewName('');
      setNewEmail('');
      setNewRole('user');
      setNewTierName('standard');
      setNewBilling('monthly');
      setNewIsFree(false);
      addToast('User and subscription created successfully', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const lockMutation = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) =>
      adminFetch(`/users/${encodeURIComponent(userId)}/lock`, {
        method: 'PUT',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setLockTarget(null);
      addToast('Account locked', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const unlockMutation = useMutation({
    mutationFn: (userId: string) =>
      adminFetch(`/users/${encodeURIComponent(userId)}/unlock`, { method: 'PUT' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      addToast('Account unlocked', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const adjustCreditsMutation = useMutation({
    mutationFn: ({ userId, delta, reason }: { userId: string; delta: number; reason: string }) =>
      adminFetch(`/users/${encodeURIComponent(userId)}/credits`, {
        method: 'POST',
        body: JSON.stringify({ delta, reason }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setCreditTarget(null);
      addToast('Credits adjusted', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  // Hotfix (2026-04-28): full-edit endpoint covers display_name, email,
  // recipient_email, bcc_email, AND password reset. The legacy PUT
  // /admin/users/:id endpoint handled only the first two; the new POST
  // .../:id/full also writes app_config_v2 + invokes the Supabase Auth admin
  // API for the password.
  const editProfileMutation = useMutation({
    mutationFn: ({
      userId,
      updates,
    }: {
      userId: string;
      updates: {
        display_name?: string;
        email?: string;
        recipient_email?: string;
        bcc_email?: string;
        password?: string;
      };
    }) =>
      adminFetch<{ user_id: string; results: Record<string, { ok: boolean; error?: string }> }>(
        `/users/${encodeURIComponent(userId)}/full`,
        { method: 'POST', body: JSON.stringify(updates) },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditTarget(null);
      // Surface partial failures (e.g. Supabase admin password reset failed)
      const fields = (data as { results?: Record<string, { ok: boolean; error?: string }> })?.results ?? {};
      const failed = Object.entries(fields).filter(([, r]) => !r.ok);
      if (failed.length === 0) {
        addToast('User updated', 'success');
      } else {
        addToast(
          `Saved with ${failed.length} issue(s): ${failed.map(([k, r]) => `${k}: ${r.error ?? 'failed'}`).join(', ')}`,
          'error',
        );
      }
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  const assignTierMutation = useMutation({
    mutationFn: ({
      userId,
      tier_name,
      billing_cycle,
      reset_credits,
    }: { userId: string; tier_name: string; billing_cycle: 'monthly' | 'annual' | 'none'; reset_credits: boolean }) =>
      adminFetch(`/users/${encodeURIComponent(userId)}/subscription`, {
        method: 'PUT',
        body: JSON.stringify({ tier_name, billing_cycle, reset_credits }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-subscriptions'] });
      setTierTarget(null);
      addToast('Subscription updated', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  // Sprint 8: role changes go through the dedicated endpoint that writes to
  // `user_role_meta_v2` (the legacy `users_v2.role` CHECK constraint rejects
  // 'superuser', and the meta table is the source of truth for elevation).
  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'user' | 'admin' | 'superuser' }) =>
      adminFetch(`/users/${encodeURIComponent(userId)}/role`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditingId(null);
      addToast('Role updated', 'success');
    },
    onError: (err: Error) => addToast(err.message, 'error'),
  });

  // Sprint 8 replaced legacy "deactivate" (set role=viewer) with proper Lock/Unlock
  // semantics that toggle account_status on user_account_meta_v2. The DELETE
  // /api/admin/users/:id route still exists server-side but is no longer wired
  // into the table; admins use the Lock button instead.

  const filtered = (users || []).filter((u) => {
    if (statusFilter !== 'all' && (u.account_status ?? 'active') !== statusFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.display_name?.toLowerCase().includes(q) ||
      u.phone_number?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q)
    );
  });

  const handleImpersonate = async (userId: string) => {
    try {
      await startImpersonation(userId);
      window.location.assign('/');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to start impersonation', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users..."
          className={inputClass + ' flex-1 min-w-[12rem]'}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className={inputClass}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="locked">Locked</option>
          <option value="suspended">Suspended (trial expired)</option>
        </select>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + Create User
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create User Account</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (+14105551234)" className={inputClass} />
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Display Name" className={inputClass} />
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" className={inputClass} />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className={inputClass}>
              <option value="user">User</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
            <select
              value={newTierName}
              onChange={(e) => setNewTierName(e.target.value)}
              disabled={newIsFree}
              className={inputClass}
            >
              {(tiers ?? []).filter((t) => t.name !== 'free_full').map((t) => (
                <option key={t.id} value={t.name}>
                  {t.display_name} ({(t.monthly_price_cents / 100).toFixed(2)}/mo)
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-sm">
                <input type="radio" checked={newBilling === 'monthly'} onChange={() => setNewBilling('monthly')} disabled={newIsFree} /> Monthly
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input type="radio" checked={newBilling === 'annual'} onChange={() => setNewBilling('annual')} disabled={newIsFree} /> Annual
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={newIsFree} onChange={(e) => setNewIsFree(e.target.checked)} /> Free account (free_full)
              </label>
            </div>
          </div>
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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Tier</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Credits</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((u) => {
                const status = u.account_status ?? 'active';
                const isLocked = status === 'locked' || status === 'suspended';
                const trialDays = u.subscription?.trial_end
                  ? Math.max(0, Math.ceil((new Date(u.subscription.trial_end).getTime() - Date.now()) / (24 * 3600 * 1000)))
                  : null;
                return (
                  <tr key={u.user_id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{u.display_name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono">{u.phone_number}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{u.email || '—'}</td>
                    <td className="px-4 py-3">
                      {editingId === u.user_id ? (
                        <select
                          defaultValue={u.effective_role ?? (u.role === 'admin' ? 'admin' : 'user')}
                          onChange={(e) =>
                            updateRoleMutation.mutate({
                              userId: u.user_id,
                              role: e.target.value as 'user' | 'admin' | 'superuser',
                            })
                          }
                          onBlur={() => setEditingId(null)}
                          autoFocus
                          className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        >
                          <option value="user">user</option>
                          <option value="admin" disabled={!isSuperuser}>
                            admin{!isSuperuser ? ' (superuser only)' : ''}
                          </option>
                          <option value="superuser" disabled={!isSuperuser}>
                            superuser{!isSuperuser ? ' (superuser only)' : ''}
                          </option>
                        </select>
                      ) : (
                        <button
                          onClick={() => setEditingId(u.user_id)}
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadge[u.effective_role ?? u.role] || roleBadge.user}`}
                          title="Click to change role"
                        >
                          {u.effective_role ?? u.role}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge[status]}`}>
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {u.subscription?.tier?.display_name ?? '—'}
                      {trialDays !== null && (
                        <div className="text-xs text-amber-600">{trialDays}d trial left</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-700 dark:text-gray-300">
                      {u.subscription
                        ? `${u.subscription.credits_remaining} / ${u.subscription.tier.monthly_credits}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <button
                          onClick={() => setEditTarget(u)}
                          className="text-xs text-gray-700 hover:text-gray-900 dark:text-gray-300"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setTierTarget(u)}
                          className="text-xs text-purple-700 hover:text-purple-900 dark:text-purple-400"
                          title={u.subscription ? 'Change subscription tier' : 'Assign a subscription tier'}
                        >
                          {u.subscription ? 'Tier' : 'Set Tier'}
                        </button>
                        {isLocked ? (
                          <button
                            onClick={() => unlockMutation.mutate(u.user_id)}
                            className="text-xs text-green-700 hover:text-green-900 dark:text-green-400"
                          >
                            Unlock
                          </button>
                        ) : (
                          <button
                            onClick={() => setLockTarget(u)}
                            className="text-xs text-orange-700 hover:text-orange-900 dark:text-orange-400"
                          >
                            Lock
                          </button>
                        )}
                        <button
                          onClick={() => setCreditTarget(u)}
                          className="text-xs text-blue-700 hover:text-blue-900 dark:text-blue-400"
                          title={u.subscription ? 'Adjust credits (no charge)' : 'User has no subscription — set a tier first'}
                        >
                          Credits
                        </button>
                        {isSuperuser && (
                          <button
                            onClick={() => void handleImpersonate(u.user_id)}
                            disabled={isImpersonating}
                            className="text-xs text-amber-700 hover:text-amber-900 disabled:opacity-50 dark:text-amber-400"
                          >
                            Impersonate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-400">
                    {search || statusFilter !== 'all' ? 'No users match your search.' : 'No users found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {lockTarget && (
        <LockUserDialog
          target={lockTarget}
          onCancel={() => setLockTarget(null)}
          onConfirm={(reason) => lockMutation.mutate({ userId: lockTarget.user_id, reason })}
          submitting={lockMutation.isPending}
        />
      )}

      {creditTarget && (
        <AdjustCreditsDialog
          target={creditTarget}
          onCancel={() => setCreditTarget(null)}
          onConfirm={(delta, reason) =>
            adjustCreditsMutation.mutate({ userId: creditTarget.user_id, delta, reason })
          }
          onAssignTierInstead={() => {
            const t = creditTarget;
            setCreditTarget(null);
            setTierTarget(t);
          }}
          submitting={adjustCreditsMutation.isPending}
        />
      )}

      {editTarget && (
        <EditUserDialog
          target={editTarget}
          onCancel={() => setEditTarget(null)}
          onConfirm={(updates) =>
            editProfileMutation.mutate({ userId: editTarget.user_id, updates })
          }
          submitting={editProfileMutation.isPending}
        />
      )}

      {tierTarget && tiers && (
        <AssignSubscriptionDialog
          target={tierTarget}
          tiers={tiers}
          onCancel={() => setTierTarget(null)}
          onConfirm={(payload) =>
            assignTierMutation.mutate({ userId: tierTarget.user_id, ...payload })
          }
          submitting={assignTierMutation.isPending}
        />
      )}
    </div>
  );
}

function LockUserDialog({
  target,
  onCancel,
  onConfirm,
  submitting,
}: {
  target: AdminUser;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Lock account</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {target.display_name || target.phone_number} will be unable to log in.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (visible to other admins)"
          className={inputClass + ' mt-3 h-24 resize-none'}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={!reason.trim() || submitting}
            onClick={() => onConfirm(reason.trim())}
            className="rounded bg-orange-600 px-3 py-1 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {submitting ? 'Locking…' : 'Lock account'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AdjustCreditsDialog({
  target,
  onCancel,
  onConfirm,
  onAssignTierInstead,
  submitting,
}: {
  target: AdminUser;
  onCancel: () => void;
  onConfirm: (delta: number, reason: string) => void;
  onAssignTierInstead: () => void;
  submitting: boolean;
}) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState('');
  const balance = target.subscription?.credits_remaining ?? 0;
  const hasSubscription = target.subscription !== null && target.subscription !== undefined;

  if (!hasSubscription) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
        <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold">No subscription</h3>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
            <strong>{target.display_name || target.phone_number}</strong> has no active subscription, so there's no
            credit balance to adjust. Assign a tier first — that creates the subscription and seeds the initial
            credit allotment from the tier's monthly cap.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            For comp/full-access (universal) accounts, use the <span className="font-mono">Full Access (Comp)</span>
            {' '}tier — $0 / month, 1000 credits / month, all features unlocked.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Cancel
            </button>
            <button
              onClick={onAssignTierInstead}
              className="rounded bg-purple-600 px-3 py-1 text-sm font-semibold text-white hover:bg-purple-700"
            >
              Assign tier
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Adjust credits</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Current balance: <span className="font-mono">{balance}</span>
          {target.subscription?.tier && (
            <span> on tier <span className="font-mono">{target.subscription.tier.display_name}</span></span>
          )}
        </p>
        <p className="mt-1 text-xs text-green-700 dark:text-green-400">
          No money is charged — this is an admin balance adjustment, not a purchase.
        </p>
        <input
          type="number"
          value={delta}
          onChange={(e) => setDelta(Number(e.target.value))}
          placeholder="Delta (positive to add, negative to deduct)"
          className={inputClass + ' mt-3'}
        />
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason"
          className={inputClass + ' mt-3 h-20 resize-none'}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={delta === 0 || !reason.trim() || submitting}
            onClick={() => onConfirm(delta, reason.trim())}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Adjusting…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditUserUpdates {
  display_name?: string;
  email?: string;
  recipient_email?: string;
  bcc_email?: string;
  password?: string;
}

function EditUserDialog({
  target,
  onCancel,
  onConfirm,
  submitting,
}: {
  target: AdminUser;
  onCancel: () => void;
  onConfirm: (updates: EditUserUpdates) => void;
  submitting: boolean;
}) {
  const [displayName, setDisplayName] = useState(target.display_name ?? '');
  const [email, setEmail] = useState(target.email ?? '');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPasswordSection, setShowPasswordSection] = useState(false);

  // Load app_config email prefs for this user (parallel to what UserSettings shows)
  const { data: prefs, isLoading: prefsLoading } = useQuery({
    queryKey: ['admin-user-email-prefs', target.user_id],
    queryFn: () =>
      adminFetch<{ recipient_email: string | null; bcc_email: string | null }>(
        `/users/${encodeURIComponent(target.user_id)}/email-prefs`,
      ),
    staleTime: 0,
  });

  // Seed the email-pref fields once they arrive.
  const [seeded, setSeeded] = useState(false);
  if (prefs && !seeded) {
    setRecipientEmail(prefs.recipient_email ?? '');
    setBccEmail(prefs.bcc_email ?? '');
    setSeeded(true);
  }

  const initialDisplayName = target.display_name ?? '';
  const initialEmail = target.email ?? '';
  const initialRecipient = prefs?.recipient_email ?? '';
  const initialBcc = prefs?.bcc_email ?? '';

  const profileChanged =
    displayName.trim() !== initialDisplayName || email.trim() !== initialEmail;
  const prefsChanged =
    seeded &&
    (recipientEmail.trim() !== initialRecipient || bccEmail.trim() !== initialBcc);
  const passwordChanged = showPasswordSection && password.length >= 8;
  const isDirty = profileChanged || prefsChanged || passwordChanged;

  const passwordTooShort = showPasswordSection && password.length > 0 && password.length < 8;

  const handleSubmit = () => {
    const updates: EditUserUpdates = {};
    if (displayName.trim() !== initialDisplayName) updates.display_name = displayName.trim();
    if (email.trim() !== initialEmail) updates.email = email.trim();
    if (seeded && recipientEmail.trim() !== initialRecipient) {
      updates.recipient_email = recipientEmail.trim();
    }
    if (seeded && bccEmail.trim() !== initialBcc) {
      updates.bcc_email = bccEmail.trim();
    }
    if (showPasswordSection && password.length >= 8) {
      updates.password = password;
    }
    if (Object.keys(updates).length > 0) onConfirm(updates);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold">Edit user</h3>
        <p className="mt-1 text-xs text-gray-500">
          Phone (<span className="font-mono">{target.phone_number}</span>) is the primary key and cannot be changed.
          Role / lock / credits / tier each have their own dedicated buttons.
        </p>

        {/* Profile */}
        <fieldset className="mt-4 rounded border border-gray-200 p-3 dark:border-gray-700">
          <legend className="px-2 text-xs font-semibold uppercase text-gray-500">Profile</legend>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Display name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={inputClass}
                placeholder="Display name"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Email (contact)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="user@example.com"
              />
            </div>
          </div>
        </fieldset>

        {/* Email delivery prefs (mirror of Settings page) */}
        <fieldset className="mt-3 rounded border border-gray-200 p-3 dark:border-gray-700">
          <legend className="px-2 text-xs font-semibold uppercase text-gray-500">Email delivery</legend>
          {prefsLoading ? (
            <p className="text-xs text-gray-500">Loading current preferences…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Recipient email <span className="text-gray-400">(where writing results are sent)</span>
                </label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  className={inputClass}
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  BCC email <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="email"
                  value={bccEmail}
                  onChange={(e) => setBccEmail(e.target.value)}
                  className={inputClass}
                  placeholder="bcc@example.com"
                />
              </div>
            </div>
          )}
        </fieldset>

        {/* Password reset */}
        <fieldset className="mt-3 rounded border border-gray-200 p-3 dark:border-gray-700">
          <legend className="px-2 text-xs font-semibold uppercase text-gray-500">Password</legend>
          {!showPasswordSection ? (
            <button
              type="button"
              onClick={() => setShowPasswordSection(true)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Reset this user's password
            </button>
          ) : (
            <div className="space-y-2">
              <PasswordInput
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                placeholder="Min 8 characters"
              />
              {passwordTooShort && (
                <p className="text-xs text-red-600">Password must be at least 8 characters</p>
              )}
              <p className="text-xs text-gray-500">
                Goes through Supabase Auth admin API. The user is not notified — share the new password out-of-band
                or have them use Forgot Password to set their own.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowPasswordSection(false);
                  setPassword('');
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel password reset
              </button>
            </div>
          )}
        </fieldset>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={!isDirty || submitting || passwordTooShort}
            onClick={handleSubmit}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignSubscriptionDialog({
  target,
  tiers,
  onCancel,
  onConfirm,
  submitting,
}: {
  target: AdminUser;
  tiers: SubscriptionTier[];
  onCancel: () => void;
  onConfirm: (payload: {
    tier_name: string;
    billing_cycle: 'monthly' | 'annual' | 'none';
    reset_credits: boolean;
  }) => void;
  submitting: boolean;
}) {
  const currentTierName = target.subscription?.tier?.name ?? '';
  const sortedTiers = useMemo(
    () => [...tiers].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [tiers],
  );
  // Default the tier dropdown: keep current tier when changing; default to
  // free_full for users with no subscription (the "comp / universal" path the
  // admin most often wants here).
  const [tierName, setTierName] = useState(
    currentTierName || sortedTiers.find((t) => t.name === 'free_full')?.name || sortedTiers[0]?.name || '',
  );
  const [billing, setBilling] = useState<'monthly' | 'annual' | 'none'>(
    (target.subscription?.billing_cycle as 'monthly' | 'annual' | 'none' | undefined) ?? 'none',
  );
  const [resetCredits, setResetCredits] = useState(true);

  const selectedTier = sortedTiers.find((t) => t.name === tierName);
  const isFreeTier =
    selectedTier !== undefined && selectedTier.monthly_price_cents === 0 && selectedTier.annual_price_cents === 0;

  const handleSubmit = () => {
    if (!tierName) return;
    onConfirm({ tier_name: tierName, billing_cycle: isFreeTier ? 'none' : billing, reset_credits: resetCredits });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold">
          {target.subscription ? 'Change subscription tier' : 'Assign subscription tier'}
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          User: <span className="font-mono">{target.phone_number}</span>
          {target.subscription?.tier && (
            <>
              {' · current: '}
              <span className="font-mono">{target.subscription.tier.display_name}</span>
              {' · '}
              <span className="font-mono">
                {target.subscription.credits_remaining} / {target.subscription.tier.monthly_credits} credits
              </span>
            </>
          )}
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tier</label>
            <select
              value={tierName}
              onChange={(e) => setTierName(e.target.value)}
              className={inputClass}
            >
              {sortedTiers.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.display_name} — {t.monthly_credits} credits / mo
                  {t.monthly_price_cents > 0
                    ? ` · $${(t.monthly_price_cents / 100).toFixed(2)}/mo`
                    : ' · $0 (comp)'}
                </option>
              ))}
            </select>
            {selectedTier?.description && (
              <p className="mt-1 text-xs text-gray-500">{selectedTier.description}</p>
            )}
          </div>

          {!isFreeTier && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Billing cycle</label>
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={billing === 'monthly'}
                    onChange={() => setBilling('monthly')}
                  />
                  Monthly{' '}
                  {selectedTier && (
                    <span className="text-xs text-gray-500">
                      (${(selectedTier.monthly_price_cents / 100).toFixed(2)})
                    </span>
                  )}
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={billing === 'annual'}
                    onChange={() => setBilling('annual')}
                  />
                  Annual{' '}
                  {selectedTier && (
                    <span className="text-xs text-gray-500">
                      (${(selectedTier.annual_price_cents / 100).toFixed(2)})
                    </span>
                  )}
                </label>
              </div>
            </div>
          )}

          {isFreeTier && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200">
              This is a $0 tier. The user will not be billed for credits at this tier — credits replenish to the
              monthly cap each cycle without any charge.
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={resetCredits}
              onChange={(e) => setResetCredits(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Reset credit balance to the new tier's monthly cap
              {selectedTier && (
                <span className="text-xs text-gray-500"> ({selectedTier.monthly_credits} credits)</span>
              )}
              <span className="block text-xs text-gray-500">
                On a brand-new subscription this is forced on.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={!tierName || submitting}
            onClick={handleSubmit}
            className="rounded bg-purple-600 px-3 py-1 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting
              ? 'Saving…'
              : target.subscription
                ? 'Update subscription'
                : 'Create subscription'}
          </button>
        </div>
      </div>
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

interface QueueSnapshot {
  queues: Array<{
    name: string;
    counts: Record<string, number>;
    settings: { concurrency: number; timeoutMs: number };
  }>;
  perUserLimits: { totalPerUser: number; heavyPerUser: number; retryDelayMs: number };
  topUsers: Array<{ user_id: string; active_jobs: number }>;
  totalActive: number;
}

function QueueStatus() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-queues'],
    queryFn: () => adminFetch<QueueSnapshot>('/queues'),
    refetchInterval: 10_000,
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading queue snapshot...</div>;
  if (error) return <div className="text-sm text-red-500">Failed to load queues: {(error as Error).message}</div>;
  if (!data) return <div className="text-sm text-gray-500">No data.</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span>
          Per-user limits: total <strong>{data.perUserLimits.totalPerUser}</strong>, heavy{' '}
          <strong>{data.perUserLimits.heavyPerUser}</strong>
        </span>
        <span>
          Total jobs in flight: <strong>{data.totalActive}</strong>
        </span>
        <span className="text-gray-400">Auto-refresh every 10s</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.queues.map((q) => (
          <div
            key={q.name}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{q.name}</h3>
              <span className="text-xs text-gray-500">
                concurrency {q.settings.concurrency} · timeout {Math.round(q.settings.timeoutMs / 1000)}s
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              <CountCell label="Waiting" value={q.counts.waiting ?? 0} tone="gray" />
              <CountCell label="Active" value={q.counts.active ?? 0} tone="blue" />
              <CountCell label="Delayed" value={q.counts.delayed ?? 0} tone="yellow" />
              <CountCell label="Done" value={q.counts.completed ?? 0} tone="green" />
              <CountCell label="Failed" value={q.counts.failed ?? 0} tone="red" />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
          Top users by active jobs
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Active Jobs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.topUsers.map((u) => (
              <tr key={u.user_id}>
                <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">{u.user_id}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{u.active_jobs}</td>
              </tr>
            ))}
            {data.topUsers.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-400">
                  No active jobs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountCell({ label, value, tone }: { label: string; value: number; tone: 'gray' | 'blue' | 'yellow' | 'green' | 'red' }) {
  const toneClass = {
    gray: 'text-gray-700 dark:text-gray-200',
    blue: 'text-blue-700 dark:text-blue-300',
    yellow: 'text-yellow-700 dark:text-yellow-300',
    green: 'text-green-700 dark:text-green-300',
    red: 'text-red-700 dark:text-red-300',
  }[tone];
  return (
    <div className="rounded border border-gray-100 px-2 py-2 dark:border-gray-800">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
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
  superuser: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
  admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  editor: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  viewer: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  user: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
};

const statusBadge: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  locked: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
};

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

// --------------------------------------------------------------------
// Sprint 8 — Subscriptions tab

function SubscriptionsTab() {
  const [tierFilter, setTierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data: tiers } = useQuery({
    queryKey: ['admin-tiers'],
    queryFn: () => adminFetch<SubscriptionTier[]>('/tiers'),
    staleTime: 60_000,
  });

  const { data: subs, isLoading } = useQuery({
    queryKey: ['admin-subscriptions', tierFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (tierFilter) params.set('tier', tierFilter);
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString() ? `?${params}` : '';
      return adminFetch<AdminSubscriptionRow[]>(`/subscriptions${qs}`);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} className={inputClass}>
          <option value="">All tiers</option>
          {(tiers ?? []).map((t) => (
            <option key={t.id} value={t.name}>{t.display_name}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
          <option value="past_due">Past due</option>
        </select>
      </div>

      {isLoading ? (
        <div className="rounded-lg bg-gray-100 p-8 text-center text-sm text-gray-500 dark:bg-gray-800">Loading…</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left">
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Tier</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Cycle</th>
                <th className="px-4 py-2">Period end</th>
                <th className="px-4 py-2">Trial end</th>
                <th className="px-4 py-2 text-right">Credits</th>
                <th className="px-4 py-2 text-right">Used</th>
              </tr>
            </thead>
            <tbody>
              {(subs ?? []).map((s) => (
                <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 font-mono text-xs">{s.user_id}</td>
                  <td className="px-4 py-2">{s.tier?.display_name ?? '—'}</td>
                  <td className="px-4 py-2">{s.status}</td>
                  <td className="px-4 py-2">{s.billing_cycle}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {s.trial_end ? new Date(s.trial_end).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{s.credits_remaining}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-500">{s.credits_used_this_period}</td>
                </tr>
              ))}
              {(!subs || subs.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    No subscriptions match.
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

// Sprint 8 — Revenue tab

function RevenueTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-revenue'],
    queryFn: () => adminFetch<RevenueStats>('/revenue'),
  });

  if (isLoading) {
    return <div className="rounded-lg bg-gray-100 p-8 text-center text-sm text-gray-500 dark:bg-gray-800">Loading…</div>;
  }
  if (!data) {
    return <div className="text-sm text-gray-500">No revenue data.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="MRR" value={`$${(data.mrr_cents / 100).toFixed(2)}`} />
        <Stat label="ARR" value={`$${(data.arr_cents / 100).toFixed(2)}`} />
        <Stat label="Active paid" value={String(data.active_paid_subscribers)} />
        <Stat label="Active trial" value={String(data.active_trial_subscribers)} />
        <Stat label="Comp (free_full)" value={String(data.active_free_subscribers)} />
        <Stat label="Trials expired" value={String(data.expired_trials)} />
      </div>

      <section>
        <h3 className="text-sm font-semibold uppercase text-gray-500">Subscribers by tier</h3>
        <div className="mt-2 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left">
                <th className="px-4 py-2">Tier</th>
                <th className="px-4 py-2 text-right">Subscribers</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.subscribers_by_tier).map(([name, count]) => (
                <tr key={name} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2">{name}</td>
                  <td className="px-4 py-2 text-right font-mono">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

// --------------------------------------------------------------------
// S11-5 — Email bounces & complaints

interface BounceRow {
  id: string;
  postal_message_id: string | null;
  postal_event_id: string | null;
  event_type: string;
  to_address: string;
  from_address: string | null;
  subject: string | null;
  bounce_type: string | null;
  bounce_reason: string | null;
  occurred_at: string;
  received_at: string;
}

interface BouncePayload {
  bounces: BounceRow[];
  summary: Record<string, number>;
  total: number;
}

function BounceStatus() {
  const [filterType, setFilterType] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');

  const qs: string[] = [];
  if (filterType) qs.push(`event_type=${encodeURIComponent(filterType)}`);
  if (filterTo) qs.push(`to=${encodeURIComponent(filterTo)}`);
  qs.push('limit=100');
  const path = `/bounces?${qs.join('&')}`;

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-bounces', filterType, filterTo],
    queryFn: () => adminFetch<BouncePayload>(path),
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="text-sm text-gray-500">Loading bounces...</div>;
  if (error) return <div className="text-sm text-red-500">Failed to load bounces: {(error as Error).message}</div>;
  if (!data) return <div className="text-sm text-gray-500">No data.</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-2">
          <label className="text-gray-500">Event type:</label>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          >
            <option value="">all</option>
            <option value="MessageBounced">MessageBounced</option>
            <option value="MessageHeld">MessageHeld</option>
            <option value="SpamComplaint">SpamComplaint</option>
            <option value="MessageDeliveryFailed">MessageDeliveryFailed</option>
            <option value="MessageDSNReceived">MessageDSNReceived</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-gray-500">Recipient:</label>
          <input
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            placeholder="to@example.com"
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <span className="text-gray-400">{data.total} event{data.total === 1 ? '' : 's'} — auto-refresh 30s</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(data.summary).map(([type, count]) => (
          <span
            key={type}
            className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            {type}: <strong>{count}</strong>
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Received</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Type</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">To</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Subject</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.bounces.map((b) => (
              <tr key={b.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                <td className="px-4 py-2 text-xs text-gray-500">{new Date(b.received_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 font-medium ${
                    b.event_type === 'MessageBounced' || b.event_type === 'MessageDeliveryFailed'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
                      : b.event_type === 'SpamComplaint'
                        ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                  }`}>
                    {b.event_type}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-gray-900 dark:text-white">{b.to_address}</td>
                <td className="px-4 py-2 text-xs text-gray-600 dark:text-gray-400 max-w-xs truncate">{b.subject || '—'}</td>
                <td className="px-4 py-2 text-xs text-gray-600 dark:text-gray-400 max-w-xs truncate">{b.bounce_reason || '—'}</td>
              </tr>
            ))}
            {data.bounces.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-400">
                  No bounce events recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

