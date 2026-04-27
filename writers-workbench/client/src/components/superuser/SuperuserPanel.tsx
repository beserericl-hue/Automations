// Sprint 8 (S8-4 + S8-7): superuser-only control plane.
// Sections: Quick Impersonate, Impersonation History, Tier Management,
// System Configuration. Route: /superuser. Guarded by RequireRole.

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '../../contexts/UserContext';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import type {
  ImpersonationLog,
  SubscriptionTier,
  TierFeatures,
} from '../../types/database';

interface AdminUserRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  effective_role: string;
  account_status: string;
}

interface SystemConfig {
  credit_costs?: Record<string, number>;
  maintenance_mode?: boolean;
  default_tier_name?: string;
}

export default function SuperuserPanel() {
  const { isSuperuser } = usePermissions();
  const [tab, setTab] = useState<'impersonate' | 'tiers' | 'config'>('impersonate');

  if (!isSuperuser) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-6 text-red-900">
        Superuser access required.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Superuser Console</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Impersonation, tier management, and system configuration.
        </p>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-4">
          {(['impersonate', 'tiers', 'config'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${
                tab === t
                  ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
              }`}
            >
              {t === 'impersonate' ? 'Impersonation' : t === 'tiers' ? 'Tier Management' : 'System Config'}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'impersonate' && <ImpersonationSection />}
      {tab === 'tiers' && <TierManagement />}
      {tab === 'config' && <SystemConfigSection />}
    </div>
  );
}

// ============================================================
// Impersonation
// ============================================================

function ImpersonationSection() {
  const { isImpersonating, startImpersonation } = useUser();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [log, setLog] = useState<ImpersonationLog[]>([]);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<ApiEnvelope<AdminUserRow[]>>('/api/admin/users', { skipImpersonation: true });
        setUsers(res.data ?? []);
      } catch {
        setUsers([]);
      }
      try {
        const res = await apiFetch<ApiEnvelope<ImpersonationLog[]>>('/api/superuser/impersonate/log', { skipImpersonation: true });
        setLog(res.data ?? []);
      } catch {
        setLog([]);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users.slice(0, 25);
    return users
      .filter((u) =>
        u.user_id.toLowerCase().includes(q) ||
        (u.display_name ?? '').toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q),
      )
      .slice(0, 25);
  }, [users, search]);

  const handleStart = async (target: string) => {
    setError(null);
    try {
      await startImpersonation(target, reason || undefined);
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start impersonation');
    }
  };

  return (
    <div className="space-y-6">
      {isImpersonating && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You already have an active impersonation session. End it from the banner before starting a new one.
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold">Quick Impersonate</h2>
        <p className="mt-1 text-sm text-gray-600">Search users by name, phone, or email.</p>

        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type to filter..."
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, recorded in audit log)"
            className="flex-[2] rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>

        {error && <div className="mt-2 text-sm text-red-700">{error}</div>}

        <div className="mt-3 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left">
                <th className="px-3 py-2">User ID</th>
                <th className="px-3 py-2">Display Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.user_id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 font-mono text-xs">{u.user_id}</td>
                  <td className="px-3 py-2">{u.display_name ?? '—'}</td>
                  <td className="px-3 py-2">{u.email ?? '—'}</td>
                  <td className="px-3 py-2">{u.effective_role}</td>
                  <td className="px-3 py-2">{u.account_status}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={isImpersonating}
                      onClick={() => void handleStart(u.user_id)}
                      className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      Impersonate
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                    No users match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Impersonation History</h2>
        <div className="mt-3 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left">
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Ended</th>
                <th className="px-3 py-2">Superuser</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {log.slice(0, 50).map((row) => (
                <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 font-mono text-xs">{new Date(row.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.ended_at ? new Date(row.ended_at).toLocaleString() : <span className="text-amber-700">active</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.superuser_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.target_user_id}</td>
                  <td className="px-3 py-2">{row.reason ?? '—'}</td>
                </tr>
              ))}
              {log.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                    No impersonation events yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Tier Management (S8-7)
// ============================================================

interface TierWithCount extends SubscriptionTier {
  active_subscriber_count: number;
}

function TierManagement() {
  const [tiers, setTiers] = useState<TierWithCount[]>([]);
  const [editing, setEditing] = useState<TierWithCount | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch<ApiEnvelope<TierWithCount[]>>('/api/superuser/tiers', { skipImpersonation: true });
      setTiers(res.data ?? []);
    })();
  }, [reload]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Configure subscription tiers — pricing, monthly credit allowance, and feature flags. Changes apply to new subscribers immediately;
        existing subscribers' allowances refresh on their next monthly reset.
      </p>

      <div className="overflow-hidden rounded border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr className="text-left">
              <th className="px-3 py-2">Tier</th>
              <th className="px-3 py-2">Credits/mo</th>
              <th className="px-3 py-2">Per credit</th>
              <th className="px-3 py-2">Monthly $</th>
              <th className="px-3 py-2">Annual $</th>
              <th className="px-3 py-2">Subscribers</th>
              <th className="px-3 py-2">Active</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-3 py-2">
                  <div className="font-medium">{t.display_name}</div>
                  <div className="font-mono text-xs text-gray-500">{t.name}</div>
                </td>
                <td className="px-3 py-2">{t.monthly_credits}</td>
                <td className="px-3 py-2">${(t.credit_purchase_price_cents / 100).toFixed(2)}</td>
                <td className="px-3 py-2">${(t.monthly_price_cents / 100).toFixed(2)}</td>
                <td className="px-3 py-2">${(t.annual_price_cents / 100).toFixed(2)}</td>
                <td className="px-3 py-2">{t.active_subscriber_count}</td>
                <td className="px-3 py-2">{t.active ? 'yes' : 'no'}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <TierEditDialog
          tier={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

interface TierEditDialogProps {
  tier: TierWithCount;
  onClose: () => void;
  onSaved: () => void;
}

function TierEditDialog({ tier, onClose, onSaved }: TierEditDialogProps) {
  const [form, setForm] = useState({
    display_name: tier.display_name,
    description: tier.description ?? '',
    monthly_credits: tier.monthly_credits,
    credit_purchase_price_cents: tier.credit_purchase_price_cents,
    monthly_price_cents: tier.monthly_price_cents,
    annual_price_cents: tier.annual_price_cents,
    publicly_selectable: tier.publicly_selectable,
    trial_days: tier.trial_days,
    active: tier.active,
    apply_credit_change_to_existing: false,
    features: tier.features as TierFeatures,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        display_name: form.display_name,
        description: form.description || null,
        monthly_credits: Number(form.monthly_credits),
        credit_purchase_price_cents: Number(form.credit_purchase_price_cents),
        monthly_price_cents: Number(form.monthly_price_cents),
        annual_price_cents: Number(form.annual_price_cents),
        publicly_selectable: form.publicly_selectable,
        trial_days: Number(form.trial_days),
        active: form.active,
        features: form.features,
        _apply_credit_change_to_existing: form.apply_credit_change_to_existing,
      };
      const res = await apiFetch<ApiEnvelope<unknown>>(`/api/superuser/tiers/${tier.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
        skipImpersonation: true,
      });
      if (!res.success) throw new Error(res.error?.message ?? 'Save failed');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold">Edit tier: {tier.name}</h3>
        <p className="mt-1 text-xs text-gray-500">Tier name (slug) cannot be changed.</p>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="Display Name">
            <input
              type="text"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
          <Field label="Trial Days">
            <input
              type="number"
              min={0}
              value={form.trial_days}
              onChange={(e) => setForm({ ...form, trial_days: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
          <Field label="Monthly Credits Allowance" hint="Reset every billing cycle">
            <input
              type="number"
              min={0}
              value={form.monthly_credits}
              onChange={(e) => setForm({ ...form, monthly_credits: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
          <Field label="Per-credit Purchase Price (cents)">
            <input
              type="number"
              min={1}
              value={form.credit_purchase_price_cents}
              onChange={(e) => setForm({ ...form, credit_purchase_price_cents: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
          <Field label="Monthly Price (cents)">
            <input
              type="number"
              min={0}
              value={form.monthly_price_cents}
              onChange={(e) => setForm({ ...form, monthly_price_cents: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
          <Field label="Annual Price (cents)">
            <input
              type="number"
              min={0}
              value={form.annual_price_cents}
              onChange={(e) => setForm({ ...form, annual_price_cents: Number(e.target.value) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </Field>
        </div>

        <fieldset className="mt-4 rounded border border-gray-200 p-3 dark:border-gray-700">
          <legend className="px-2 text-sm font-semibold">Features</legend>
          {(['kdp_export', 'cover_art', 'social_media'] as const).map((key) => (
            <label key={key} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={!!(form.features as Record<string, unknown>)[key]}
                onChange={(e) => setForm({ ...form, features: { ...form.features, [key]: e.target.checked } as TierFeatures })}
              />
              <span>{key.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="mt-4 space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            <span>Active (signup-able)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.publicly_selectable}
              onChange={(e) => setForm({ ...form, publicly_selectable: e.target.checked })}
            />
            <span>Publicly selectable on signup page</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.apply_credit_change_to_existing}
              onChange={(e) => setForm({ ...form, apply_credit_change_to_existing: e.target.checked })}
            />
            <span>Propagate credit change to existing subscribers' next reset</span>
          </label>
        </fieldset>

        {error && <div className="mt-3 text-sm text-red-700">{error}</div>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 dark:border-gray-700"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
      {hint && <span className="ml-1 text-xs text-gray-500">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

// ============================================================
// System Configuration (S8-7)
// ============================================================

function SystemConfigSection() {
  const [config, setConfig] = useState<SystemConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<ApiEnvelope<SystemConfig>>('/api/superuser/config', { skipImpersonation: true });
        setConfig(res.data ?? {});
      } catch {
        setConfig({});
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/superuser/config', {
        method: 'PUT',
        body: JSON.stringify(config),
        skipImpersonation: true,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const updateCost = (op: string, value: number) => {
    setConfig({
      ...config,
      credit_costs: { ...(config.credit_costs ?? {}), [op]: value },
    });
  };

  const costOps: Array<[string, string]> = [
    ['write_chapter', 'Write Chapter'],
    ['write_short_story', 'Write Short Story'],
    ['write_blog', 'Write Blog Post'],
    ['write_newsletter', 'Write Newsletter'],
    ['brainstorm', 'Brainstorm / Outline'],
    ['research', 'Research'],
    ['cover_art', 'Cover Art'],
    ['social_repurpose', 'Social Repurpose'],
  ];

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold">Credit Costs per Operation</h2>
        <p className="mt-1 text-sm text-gray-600">How many credits each operation deducts from the user's balance.</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {costOps.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min={0}
                value={config.credit_costs?.[key] ?? 0}
                onChange={(e) => updateCost(key, Number(e.target.value))}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </Field>
          ))}
        </div>
      </section>

      <section>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!config.maintenance_mode}
            onChange={(e) => setConfig({ ...config, maintenance_mode: e.target.checked })}
          />
          <span>Maintenance mode (blocks non-superuser writes)</span>
        </label>
      </section>

      {error && <div className="text-sm text-red-700">{error}</div>}
      {saved && <div className="text-sm text-green-700">Saved.</div>}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save Configuration'}
      </button>
    </div>
  );
}
