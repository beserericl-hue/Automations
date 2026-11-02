import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Global settings (item 8): values every user inherits unless they have set their own. Resolution is
 * user -> global -> default, in the server (lib/app-config.ts) and the engine alike. Secret values
 * (API keys) are masked by the server and never come back in full; saving one replaces it.
 */

export interface GlobalSetting {
  key: string;
  value: string;
  description: string;
  is_secret: boolean;
  masked: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export interface GlobalSettingsApi {
  load: () => Promise<GlobalSetting[]>;
  save: (key: string, body: { value: string; description?: string; is_secret?: boolean }) => Promise<GlobalSetting>;
  remove: (key: string) => Promise<{ deleted: boolean }>;
}

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const input =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

export default function GlobalSettings({ api }: { api: GlobalSettingsApi }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['admin-global-config'], queryFn: api.load });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newSecret, setNewSecret] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-global-config'] });
  const save = useMutation({
    mutationFn: (v: { key: string; value: string; description?: string; is_secret?: boolean }) =>
      api.save(v.key, { value: v.value, description: v.description, is_secret: v.is_secret }),
    onSuccess: (row) => {
      setMessage(`Saved ${row.key}`);
      setEditing(null);
      setNewKey('');
      setNewValue('');
      setNewDesc('');
      setNewSecret(false);
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.remove(key),
    onSuccess: (_r, key) => {
      setMessage(`Deleted ${key}`);
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const newKeyValid = KEY_RE.test(newKey);
  const rows = data ?? [];

  return (
    <div className="space-y-6" data-testid="global-settings">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Global Settings</h2>
        <p className="mt-1 text-sm text-gray-500">
          Every user inherits these unless they have set their own value. Order: the user&apos;s setting, then this
          table, then the built-in default.
        </p>
      </div>

      {message && (
        <p role="status" data-testid="global-settings-message" className="text-sm text-gray-700 dark:text-gray-300">
          {message}
        </p>
      )}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}

      {!isLoading && !error && (
        <table className="min-w-full text-sm" data-testid="global-settings-table">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2 pr-4">Key</th>
              <th className="py-2 pr-4">Value</th>
              <th className="py-2 pr-4">Description</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-gray-500">
                  No global settings yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} data-testid={`global-setting-${r.key}`} className="border-t border-gray-100 dark:border-gray-800 align-top">
                <td className="py-2 pr-4 font-mono text-xs text-gray-900 dark:text-white">
                  {r.key}
                  {r.is_secret && <span className="ml-2 rounded bg-amber-100 px-1.5 text-[10px] text-amber-800">secret</span>}
                </td>
                <td className="py-2 pr-4 max-w-md">
                  {editing === r.key ? (
                    <textarea
                      aria-label={`Value for ${r.key}`}
                      className={input}
                      rows={3}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  ) : (
                    <span className="break-all font-mono text-xs text-gray-700 dark:text-gray-300" data-testid="global-setting-value">
                      {r.value}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-gray-500">{r.description}</td>
                <td className="py-2 whitespace-nowrap space-x-2">
                  {editing === r.key ? (
                    <>
                      <button
                        className="text-brand-600 hover:underline"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ key: r.key, value: draft })}
                      >
                        Save
                      </button>
                      <button className="text-gray-500 hover:underline" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="text-brand-600 hover:underline"
                        onClick={() => {
                          setEditing(r.key);
                          setDraft(r.masked ? '' : r.value);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-red-600 hover:underline"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete the global setting "${r.key}"? Users without their own value fall back to the default.`)) {
                            remove.mutate(r.key);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        className="grid gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800 sm:grid-cols-2"
        data-testid="global-settings-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newKeyValid) return;
          save.mutate({ key: newKey, value: newValue, description: newDesc, is_secret: newSecret });
        }}
      >
        <label className="text-sm">
          <span className="mb-1 block text-gray-700 dark:text-gray-300">Key</span>
          <input className={input} value={newKey} onChange={(e) => setNewKey(e.target.value.trim())} placeholder="bcc_email" />
          {newKey && !newKeyValid && <span className="text-xs text-red-600">Letters, digits, _ . : - only</span>}
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-gray-700 dark:text-gray-300">Value</span>
          <input className={input} value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-gray-700 dark:text-gray-300">Description</span>
          <input className={input} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={newSecret} onChange={(e) => setNewSecret(e.target.checked)} />
          Secret (masked after saving)
        </label>
        <div className="sm:text-right">
          <button
            type="submit"
            disabled={!newKeyValid || save.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Add setting
          </button>
        </div>
      </form>
    </div>
  );
}
