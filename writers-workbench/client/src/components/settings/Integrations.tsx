/**
 * Settings → Integrations: your own Blotato key and every account on it (LinkedIn, Facebook, Threads,
 * X, Bluesky, Instagram, Pinterest, TikTok — migrations 043 + 055), and the blog websites your posts go to.
 * Nothing about an account is typed: the key says what is on it, and each switch makes a channel.
 *
 * These are YOUR accounts. Another author's posts go out through their Blotato key and their blog,
 * never through ours, so the keys live here, per user — not in a server variable.
 *
 * Keys and tokens are write-only. The server encrypts them before they are stored and never sends
 * them back: this page only ever knows whether one is set, its last four characters and when it
 * was saved. To change one, paste a new one over it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope, type ApiError } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface SecretStatus {
  set: boolean;
  last4: string | null;
  updated_at: string | null;
}
/** What a post needs before Blotato takes it on that platform (migration 055). */
type Needs = 'text' | 'image' | 'video' | 'page';
/** One place a post can go, read from the Blotato key: an account, or one of its pages / boards. */
interface BlotatoTarget {
  target_id: string;
  platform: string;
  account_id: string;
  account_name: string;
  page_id: string | null;
  page_name: string | null;
  board_id: string | null;
  label: string;
  needs: Needs;
}
interface SocialChannel {
  channel: string;
  kind: string;
  label: string;
  enabled: boolean;
  account_id: string | null;
  page_id: string | null;
  board_id: string | null;
  target_id: string | null;
  needs: Needs;
}
interface Website {
  channel: string;
  label: string;
  endpoint: string;
  auth_header: string;
  public_base: string;
  author: string;
  enabled: boolean;
  token: SecretStatus;
}
interface IntegrationsData {
  encryption_ready: boolean;
  read_only: boolean;
  blotato: { key: SecretStatus; accounts: BlotatoTarget[]; synced_at: string | null };
  social: SocialChannel[];
  websites: Website[];
}
interface TestResult {
  ok: boolean;
  status: number;
  message: string;
  header?: string;
  accounts?: BlotatoTarget[];
}

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white disabled:opacity-60';
const primary =
  'rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const secondary =
  'rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';
const danger =
  'rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30';

function errorText(err: unknown): string {
  const e = err as ApiError & { body?: { error?: { fields?: Array<{ field: string; message: string }> } } };
  const fields = e?.body?.error?.fields;
  if (fields?.length) return fields.map((f) => `${f.field}: ${f.message}`).join('; ');
  return e?.message || 'Something went wrong';
}

function SecretBadge({ status, testId }: { status: SecretStatus; testId: string }) {
  if (!status.set) {
    return (
      <span data-testid={testId} className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        Not set
      </span>
    );
  }
  return (
    <span data-testid={testId} className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
      Set{status.last4 ? ` · ends ••••${status.last4}` : ''}
      {status.updated_at ? ` · saved ${new Date(status.updated_at).toLocaleDateString()}` : ''}
    </span>
  );
}

function Result({ result, testId }: { result: TestResult | null; testId: string }) {
  if (!result) return null;
  return (
    <div
      role="status"
      data-testid={testId}
      className={`rounded-lg px-3 py-2 text-xs ${
        result.ok
          ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300'
          : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300'
      }`}
    >
      {result.message}
    </div>
  );
}

function ErrorLine({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return (
    <p role="alert" data-testid={testId} className="text-xs font-medium text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

function Section({ title, hint, children, testId }: { title: string; hint: string; children: React.ReactNode; testId: string }) {
  return (
    <section data-testid={testId} className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      {hint ? <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-1" />}
      {children}
    </div>
  );
}

export default function Integrations() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['integrations'],
    queryFn: async () => (await apiFetch<ApiEnvelope<IntegrationsData>>('/api/integrations')).data!,
    retry: (count, err) => (err as ApiError)?.code !== 'MIGRATION_PENDING' && count < 2,
  });

  if (isLoading) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  if ((error as ApiError)?.code === 'MIGRATION_PENDING') {
    return (
      <div className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
        <h1 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Integrations storage is not set up on this database</h1>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          Migration <code>043_user_integrations.sql</code> has not been applied here.
        </p>
      </div>
    );
  }
  if (error || !data) {
    return <ErrorLine testId="integrations-load-error" message={`Could not load your integrations: ${errorText(error)}`} />;
  }

  const locked = data.read_only;
  return (
    <div className="max-w-3xl space-y-6" data-testid="integrations-page">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Integrations</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your own accounts for the post calendar: the Blotato key that posts to your social accounts (LinkedIn, Facebook,
          Threads, X, Bluesky, Instagram, Pinterest, TikTok), and the blog websites your posts are published on. Keys and
          tokens are encrypted before they are stored and are never shown again — only whether one is set and its last
          four characters.
        </p>
      </div>
      {!data.encryption_ready ? (
        <p role="alert" data-testid="integrations-encryption-warning" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Secret storage is not configured on this server, so keys and tokens cannot be saved yet. Other settings can.
        </p>
      ) : null}
      {locked ? (
        <p data-testid="integrations-read-only" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          You are impersonating this user: you can see what is set, but not change or test it.
        </p>
      ) : null}
      <BlotatoSection data={data} locked={locked} />
      <WebsitesSection sites={data.websites} locked={locked} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Blotato
// ---------------------------------------------------------------------------------------------

function BlotatoSection({ data, locked }: { data: IntegrationsData; locked: boolean }) {
  const qc = useQueryClient();
  const { addToast } = useToast();
  const [apiKey, setApiKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations'] });

  const save = useMutation({
    mutationFn: async () => {
      if (!apiKey.trim()) throw new Error('Paste your Blotato API key first');
      return (await apiFetch<ApiEnvelope<TestResult>>('/api/integrations/blotato', { method: 'PUT', body: JSON.stringify({ api_key: apiKey.trim() }) })).data!;
    },
    onSuccess: (r) => {
      setApiKey('');
      setErr(null);
      setResult(r);
      void refresh();
      addToast(r.ok ? 'Blotato key saved and accounts read' : 'Blotato key saved', r.ok ? 'success' : 'info');
    },
    onError: (e) => setErr(errorText(e)),
  });
  const removeKey = useMutation({
    mutationFn: () => apiFetch('/api/integrations/blotato/key', { method: 'DELETE' }),
    onSuccess: () => {
      setResult(null);
      void refresh();
      addToast('Blotato key removed', 'success');
    },
    onError: (e) => setErr(errorText(e)),
  });
  const test = useMutation({
    mutationFn: async () => {
      const body = apiKey.trim() ? { api_key: apiKey.trim() } : {};
      return (await apiFetch<ApiEnvelope<TestResult>>('/api/integrations/blotato/test', { method: 'POST', body: JSON.stringify(body) })).data!;
    },
    onSuccess: (r) => {
      setErr(null);
      setResult(r);
      if (!apiKey.trim()) void refresh(); // the saved key's list was stored
    },
    onError: (e) => {
      setResult(null);
      setErr(errorText(e));
    },
  });
  const toggle = useMutation({
    mutationFn: ({ target_id, enabled }: { target_id: string; enabled: boolean }) =>
      apiFetch<ApiEnvelope<{ channel: string | null; enabled: boolean }>>('/api/integrations/blotato/targets', {
        method: 'POST',
        body: JSON.stringify({ target_id, enabled }),
      }),
    onSuccess: (_r, v) => {
      setErr(null);
      void refresh();
      addToast(v.enabled ? 'Switched on — the calendar can post there now' : 'Switched off', 'success');
    },
    onError: (e) => setErr(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (channel: string) => apiFetch(`/api/integrations/social/${channel}`, { method: 'DELETE' }),
    onSuccess: () => {
      setErr(null);
      void refresh();
      addToast('Channel removed', 'success');
    },
    onError: (e) => setErr(errorText(e)),
  });

  const accounts = data.blotato.accounts;
  const byTarget = new Map(data.social.filter((c) => c.target_id).map((c) => [c.target_id as string, c]));
  const synced = new Set(accounts.map((a) => a.target_id));
  // Channels made before the account list existed (or whose account left the key): still usable, shown apart.
  const unmatched = data.social.filter((c) => !c.target_id || !synced.has(c.target_id));
  const busy = locked || toggle.isPending;

  return (
    <Section
      testId="blotato-section"
      title="Blotato (social posting)"
      hint="Your Blotato API key (Blotato → Settings → API). Everything on it — accounts, LinkedIn and Facebook pages, Pinterest boards — is read from the key; nothing is typed. Test connection re-reads it; nothing is posted."
    >
      <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        API key: <SecretBadge status={data.blotato.key} testId="blotato-key-status" />
      </div>
      <Field label="API key" htmlFor="blotato-api-key" hint={data.blotato.key.set ? 'Paste a new key to replace the saved one. Leave blank to keep it.' : undefined}>
        <input
          id="blotato-api-key"
          data-testid="blotato-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={locked}
          placeholder={data.blotato.key.set ? '•••••••• (saved)' : 'blt_…'}
          className={inputClass}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button data-testid="blotato-save" className={primary} disabled={locked || save.isPending} onClick={() => { setErr(null); save.mutate(); }}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button data-testid="blotato-test" className={secondary} disabled={locked || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Reading…' : data.blotato.key.set && !apiKey.trim() ? 'Refresh accounts' : 'Test connection'}
        </button>
        {data.blotato.key.set ? (
          <button
            data-testid="blotato-remove-key"
            className={danger}
            disabled={locked || removeKey.isPending}
            onClick={() => {
              if (window.confirm('Remove your Blotato API key? Social posts will fail until you add one again.')) removeKey.mutate();
            }}
          >
            Remove key
          </button>
        ) : null}
      </div>
      <ErrorLine testId="blotato-error" message={err} />
      <Result testId="blotato-test-result" result={result} />

      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Post here</h3>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          {accounts.length
            ? `${accounts.length} place(s) on this key${data.blotato.synced_at ? `, read ${new Date(data.blotato.synced_at).toLocaleString()}` : ''}. Switch on the ones the calendar and the Content Studio may post to; each becomes a channel you can pick per post.`
            : data.blotato.key.set
              ? 'No accounts read yet — click Refresh accounts.'
              : 'Save your key and the accounts on it appear here.'}
        </p>
        {accounts.length ? (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-700" data-testid="blotato-targets">
            {accounts.map((a) => {
              const ch = byTarget.get(a.target_id);
              const on = Boolean(ch?.enabled);
              const cannot = a.needs === 'video' || a.needs === 'page';
              const note =
                a.needs === 'video'
                  ? 'video only — the calendar has nothing to post here'
                  : a.needs === 'page'
                    ? `connect a ${a.platform === 'pinterest' ? 'board' : 'page'} to this account in Blotato, then Refresh accounts`
                    : a.needs === 'image'
                      ? 'needs an image: only posts with a sketchnote or chosen image go here'
                      : null;
              return (
                <li key={a.target_id} data-testid={`target-${a.target_id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <label className={`flex items-center gap-2 text-sm ${cannot ? 'opacity-60' : ''}`}>
                    <input
                      type="checkbox"
                      data-testid={`target-switch-${a.target_id}`}
                      checked={on}
                      disabled={busy || cannot}
                      onChange={(e) => toggle.mutate({ target_id: a.target_id, enabled: e.target.checked })}
                    />
                    <span className="font-medium text-gray-900 dark:text-white">{a.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      account <code>{a.account_id}</code>
                      {a.page_id ? <> · page <code>{a.page_id}</code></> : null}
                      {a.board_id ? <> · board <code>{a.board_id}</code></> : null}
                      {ch ? <> · <code>{ch.channel}</code></> : null}
                    </span>
                  </label>
                  {note ? <span className="text-xs text-amber-700 dark:text-amber-400">{note}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {unmatched.length ? (
          <div className="mt-3">
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Channels not on the synced list (made by hand, or their account is no longer on this key):</p>
            <ul className="space-y-1">
              {unmatched.map((c) => (
                <li key={c.channel} data-testid={`social-row-${c.channel}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <span>
                    <span className="font-medium text-gray-900 dark:text-white">{c.label}</span>{' '}
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {c.kind} · <code>{c.channel}</code>
                      {c.page_id ? ` · page ${c.page_id}` : ''}
                      {c.enabled ? '' : ' · off'}
                    </span>
                  </span>
                  <button
                    data-testid={`social-remove-${c.channel}`}
                    className={danger}
                    disabled={locked || remove.isPending}
                    onClick={() => { if (window.confirm(`Remove ${c.label}?`)) remove.mutate(c.channel); }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Websites
// ---------------------------------------------------------------------------------------------

interface WebsiteForm {
  label: string;
  endpoint: string;
  auth_header: string;
  auth_token: string;
  public_base: string;
  author: string;
  enabled: boolean;
}

function WebsiteEditor({
  initial,
  tokenSet,
  onSave,
  onCancel,
  pending,
  error,
  idPrefix,
}: {
  initial: WebsiteForm;
  tokenSet: boolean;
  onSave: (f: WebsiteForm) => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
  idPrefix: string;
}) {
  const [f, setF] = useState(initial);
  const input = (key: keyof WebsiteForm, label: string, hint?: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Field label={label} hint={hint} htmlFor={`${idPrefix}-${key}`}>
      <input
        id={`${idPrefix}-${key}`}
        data-testid={`${idPrefix}-${key}`}
        value={String(f[key])}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
        className={inputClass}
        {...extra}
      />
    </Field>
  );
  return (
    <div data-testid={`${idPrefix}-form`} className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/30 p-3 dark:border-brand-800 dark:bg-brand-950/20">
      {input('label', 'Label', undefined, { placeholder: 'My blog' })}
      {input('endpoint', 'Blog API endpoint', 'The https:// URL posts are sent to (a POST of the post as JSON).', { placeholder: 'https://www.example.com/api/blog', type: 'url' })}
      {input('auth_header', 'Auth header name', 'The header the token is sent in. "Authorization" sends "Bearer <token>".', { placeholder: 'Authorization' })}
      {input('auth_token', 'Auth token', tokenSet ? 'Paste a new token to replace the saved one. Leave blank to keep it.' : 'Write-only: it is encrypted and never shown again.', {
        type: 'password',
        autoComplete: 'off',
        spellCheck: false,
        placeholder: tokenSet ? '•••••••• (saved)' : '',
      })}
      {input('public_base', 'Public blog URL', 'Where published posts are read, e.g. https://www.example.com/blog/ — used to build each post\'s link.', { placeholder: 'https://www.example.com/blog/', type: 'url' })}
      {input('author', 'Author name', 'The byline sent with each post.', { placeholder: 'Your name' })}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" data-testid={`${idPrefix}-enabled`} checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled
      </label>
      <ErrorLine testId={`${idPrefix}-error`} message={error} />
      <div className="flex gap-2">
        <button data-testid={`${idPrefix}-save`} className={primary} disabled={pending} onClick={() => onSave(f)}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button data-testid={`${idPrefix}-cancel`} className={secondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WebsitesSection({ sites, locked }: { sites: Website[]; locked: boolean }) {
  const qc = useQueryClient();
  const { addToast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const save = useMutation({
    mutationFn: async ({ site, f }: { site: Website | null; f: WebsiteForm }) => {
      const body: Record<string, unknown> = {
        label: f.label.trim(),
        endpoint: f.endpoint.trim(),
        auth_header: f.auth_header.trim() || 'Authorization',
        public_base: f.public_base.trim(),
        author: f.author.trim(),
        enabled: f.enabled,
      };
      if (f.auth_token.trim()) body.auth_token = f.auth_token.trim();
      if (site) await apiFetch(`/api/integrations/websites/${site.channel}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await apiFetch('/api/integrations/websites', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setEditing(null);
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      addToast('Website saved', 'success');
    },
    onError: (e) => setErr(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (channel: string) => apiFetch(`/api/integrations/websites/${channel}`, { method: 'DELETE' }),
    onSuccess: (_r, channel) => {
      setRowErr((m) => ({ ...m, [channel]: '' }));
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      addToast('Website removed', 'success');
    },
    onError: (e, channel) => setRowErr((m) => ({ ...m, [channel]: errorText(e) })),
  });
  const test = useMutation({
    mutationFn: async (channel: string) =>
      (await apiFetch<ApiEnvelope<TestResult>>(`/api/integrations/websites/${channel}/test`, { method: 'POST' })).data!,
    onSuccess: (r, channel) => {
      setRowErr((m) => ({ ...m, [channel]: '' }));
      setResults((m) => ({ ...m, [channel]: r }));
    },
    onError: (e, channel) => {
      setResults((m) => {
        const next = { ...m };
        delete next[channel];
        return next;
      });
      setRowErr((m) => ({ ...m, [channel]: errorText(e) }));
    },
  });

  const blank: WebsiteForm = { label: '', endpoint: '', auth_header: 'Authorization', auth_token: '', public_base: '', author: '', enabled: true };
  return (
    <Section
      testId="websites-section"
      title="Website blogs"
      hint="Your blog's posting API. Each post is sent as JSON to the endpoint with your token. Test sends a GET with the token — nothing is published."
    >
      {sites.length === 0 && editing !== 'new' ? (
        <p data-testid="websites-empty" className="text-sm text-gray-500 dark:text-gray-400">No websites yet.</p>
      ) : null}
      <ul className="space-y-2">
        {sites.map((s) =>
          editing === s.channel ? (
            <li key={s.channel}>
              <WebsiteEditor
                idPrefix={`web-edit-${s.channel}`}
                initial={{ label: s.label, endpoint: s.endpoint, auth_header: s.auth_header, auth_token: '', public_base: s.public_base, author: s.author, enabled: s.enabled }}
                tokenSet={s.token.set}
                onSave={(f) => { setErr(null); save.mutate({ site: s, f }); }}
                onCancel={() => { setEditing(null); setErr(null); }}
                pending={save.isPending}
                error={err}
              />
            </li>
          ) : (
            <li key={s.channel} data-testid={`web-row-${s.channel}`} className="space-y-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium text-gray-900 dark:text-white">{s.label}</span>{' '}
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    <code>{s.channel}</code>
                    {s.enabled ? '' : ' · off'}
                  </span>
                  <div className="text-xs text-gray-500 dark:text-gray-400" data-testid={`web-endpoint-${s.channel}`}>
                    {s.endpoint} · header {s.auth_header}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
                    Token: <SecretBadge status={s.token} testId={`web-token-status-${s.channel}`} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button data-testid={`web-test-${s.channel}`} className={secondary} disabled={locked || test.isPending} onClick={() => test.mutate(s.channel)}>
                    {test.isPending && test.variables === s.channel ? 'Testing…' : 'Test'}
                  </button>
                  <button data-testid={`web-edit-${s.channel}`} className={secondary} disabled={locked} onClick={() => { setEditing(s.channel); setErr(null); }}>
                    Edit
                  </button>
                  <button
                    data-testid={`web-remove-${s.channel}`}
                    className={danger}
                    disabled={locked || remove.isPending}
                    onClick={() => { if (window.confirm(`Remove ${s.label} and its saved token?`)) remove.mutate(s.channel); }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <ErrorLine testId={`web-row-error-${s.channel}`} message={rowErr[s.channel] || null} />
              <Result testId={`web-test-result-${s.channel}`} result={results[s.channel] ?? null} />
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <WebsiteEditor
          idPrefix="web-new"
          initial={blank}
          tokenSet={false}
          onSave={(f) => { setErr(null); save.mutate({ site: null, f }); }}
          onCancel={() => { setEditing(null); setErr(null); }}
          pending={save.isPending}
          error={err}
        />
      ) : (
        <button data-testid="web-add" className={secondary} disabled={locked} onClick={() => { setEditing('new'); setErr(null); }}>
          Add website
        </button>
      )}
    </Section>
  );
}
