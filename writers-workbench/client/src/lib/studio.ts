/**
 * Content Studio client helpers: types, the API, the range parser ("1-5, 8, 12-16") and the engine-job
 * poller the studio uses to show a generate / revise run finishing and what failed.
 */
import { apiFetch } from './api';
import { supabase } from '../config/supabase';

export interface StudioEdition {
  edition_id: string;
  name: string;
  radar: 'trend' | 'dev';
  channels: string[];
  cadence: string | null;
}

export interface StudioChannel {
  channel: string;
  kind: 'website' | 'linkedin';
  label: string;
  enabled: boolean;
}

export interface SlateTopic {
  id: string;
  rank: number;
  title: string;
  url: string;
  source: string;
  item_type: 'article' | 'video';
  angle: string;
  score: number | null;
  summary: string;
  also_covered_by: string[];
  week_of: string;
  post: { id: string; display_number: number; state: string; scheduled_date: string | null; slot: string; edition_id: string | null } | null;
}

export interface StudioDelivery {
  channel: string;
  status: string;
  public_url: string | null;
  detail: string | null;
}

export interface StudioPost {
  id: string;
  display_number: number;
  external_id: string;
  title: string;
  body_md: string;
  linkedin_content: string;
  seo_title: string;
  meta_description: string;
  category: string;
  include_image: boolean;
  image_url: string | null;
  channels: string[];
  scheduled_date: string | null;
  slot: 'morning' | 'afternoon';
  scheduled_at: string | null;
  post_at: string | null;
  state: string;
  last_error: string | null;
  source: string;
  item_type: string;
  source_url: string | null;
  radar_topic_id: string | null;
  humanize?: { applied?: boolean } | null;
  studio?: { revisions?: Array<{ at: string; what: string }>; previous?: Record<string, unknown>; rank?: number; week_of?: string };
  deliveries?: StudioDelivery[];
}

export interface IssueItem {
  position: number;
  kind: 'post' | 'topic';
  id: string;
  title: string | null;
  display_number?: number | null;
  rank?: number | null;
  state?: string | null;
  url?: string | null;
  week_of?: string | null;
}

export interface IssueView {
  selection: { id: string; status: string } | null;
  items: IssueItem[];
  last_issue: { execution_id: string | null; send_date: string | null; locked_at: string | null } | null;
  message?: string;
}

export const LINKEDIN_LIMIT = 3000;

/** "1-5, 8, 12-16" (or "1-5 and 8") → [1,2,3,4,5,8,12,...]. Only numbers in `available` are kept, in order. */
export function parseRanks(spec: string, available: number[]): number[] {
  const have = new Set(available);
  const out: number[] = [];
  for (const raw of spec.replace(/\band\b|&/gi, ',').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n - a < 100; n++) if (have.has(n) && !out.includes(n)) out.push(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (have.has(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  pending: 'Scheduled',
  posting: 'Posting',
  posted: 'Posted',
  partial: 'Partly posted',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function whenLabel(p: Pick<StudioPost, 'scheduled_date' | 'slot' | 'post_at'>): string {
  if (p.post_at) {
    return new Date(p.post_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  }
  if (!p.scheduled_date) return 'Not scheduled';
  return `${p.scheduled_date} ${p.slot === 'afternoon' ? '2:00 PM' : '9:00 AM'} ET`;
}

export const studioApi = {
  editions: () => apiFetch<{ data: StudioEdition[] }>('/api/studio/editions'),
  overview: (ed: string) => apiFetch<{ data: { edition: StudioEdition; channels: StudioChannel[]; weeks: string[]; run: Record<string, unknown> | null } }>(`/api/studio/${encodeURIComponent(ed)}`),
  slate: (ed: string, week?: string | null) => apiFetch<{ data: { radar: string; week_of: string | null; topics: SlateTopic[] } }>(
    `/api/studio/${encodeURIComponent(ed)}/slate${week ? `?week=${week}` : ''}`),
  posts: (ed: string, status: string) => apiFetch<{ data: StudioPost[] }>(`/api/studio/${encodeURIComponent(ed)}/posts?status=${status}`),
  runRadar: (ed: string) => apiFetch<{ jobId: string }>(`/api/studio/${encodeURIComponent(ed)}/radar/run`, { method: 'POST' }),
  generate: (ed: string, body: { topic_ids?: string[]; numbers?: string; week_of?: string; redo?: boolean }) =>
    apiFetch<{ jobId: string; creditsCharged: number }>(`/api/studio/${encodeURIComponent(ed)}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  edit: (ed: string, id: string, changes: Partial<StudioPost>) =>
    apiFetch<{ data: unknown }>(`/api/studio/${encodeURIComponent(ed)}/posts/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  revise: (ed: string, id: string, instruction: string) =>
    apiFetch<{ jobId: string }>(`/api/studio/${encodeURIComponent(ed)}/posts/${id}/revise`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  regenerate: (ed: string, id: string) => apiFetch<{ jobId: string }>(`/api/studio/${encodeURIComponent(ed)}/posts/${id}/regenerate`, { method: 'POST' }),
  undo: (ed: string, id: string) => apiFetch<{ data: { message: string } }>(`/api/studio/${encodeURIComponent(ed)}/posts/${id}/undo`, { method: 'POST' }),
  email: (ed: string, id: string) => apiFetch<{ data: { message: string } }>(`/api/studio/${encodeURIComponent(ed)}/posts/${id}/email`, { method: 'POST' }),
  emailDigest: (ed: string, week_of?: string | null) =>
    apiFetch<{ data: { message: string } }>(`/api/studio/${encodeURIComponent(ed)}/digest/email`, { method: 'POST', body: JSON.stringify(week_of ? { week_of } : {}) }),
  action: (ed: string, ids: string[], action: string) =>
    apiFetch<{ data: { message: string } }>(`/api/studio/${encodeURIComponent(ed)}/posts/actions`, { method: 'POST', body: JSON.stringify({ ids, action }) }),
  schedule: (ed: string, body: { ids: string[]; mode: 'next' | 'slot' | 'at' | 'now'; day?: string; slot?: string; at?: string; channels?: string[] }) =>
    apiFetch<{ data: { message: string } }>(`/api/studio/${encodeURIComponent(ed)}/posts/schedule`, { method: 'POST', body: JSON.stringify(body) }),
  issue: (ed: string) => apiFetch<{ data: IssueView }>(`/api/studio/${encodeURIComponent(ed)}/issue`),
  setIssue: (ed: string, items: Array<{ kind: 'post' | 'topic'; id: string }>) =>
    apiFetch<{ data: IssueView }>(`/api/studio/${encodeURIComponent(ed)}/issue`, { method: 'PUT', body: JSON.stringify({ items }) }),
  newIssue: (ed: string) => apiFetch<{ data: IssueView }>(`/api/studio/${encodeURIComponent(ed)}/issue/new`, { method: 'POST' }),
  assistant: (ed: string, message: string, week_of?: string | null) =>
    apiFetch<{ data: { kind: string; op: string | null; message: string; jobId: string | null; result: Record<string, unknown> | null; error: string | null; creditsCharged: number } }>(
      `/api/studio/${encodeURIComponent(ed)}/assistant`, { method: 'POST', body: JSON.stringify({ message, ...(week_of ? { week_of } : {}) }) }),
  feeds: (ed: string) => apiFetch<{ data: { items: string; digest: string; enabled: boolean } }>(`/api/studio/${encodeURIComponent(ed)}/feeds`),
  rotateFeeds: (ed: string) => apiFetch<{ data: { items: string; digest: string; enabled: boolean } }>(`/api/studio/${encodeURIComponent(ed)}/feeds/rotate`, { method: 'POST' }),
};

export interface JobOutcome {
  status: 'complete' | 'error';
  result: Record<string, unknown> | null;
  error: string | null;
}

/** Poll an engine job until it finishes; `onTick` runs on every poll (to refresh lists as drafts land). */
export async function waitForJob(jobId: string, onTick?: () => void, intervalMs = 4000, maxMs = 30 * 60_000): Promise<JobOutcome> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    onTick?.();
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    try {
      const r = await fetch(`/api/jobs/engine/${encodeURIComponent(jobId)}/status`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      const j = (await r.json()) as { status?: string; result?: Record<string, unknown>; error?: string };
      if (j.status === 'complete') {
        const env = (j.result ?? {}) as { payload?: { result?: Record<string, unknown> }; error?: unknown; status?: string };
        const err = env.error as { message?: string } | string | undefined;
        if (err) return { status: 'error', result: null, error: typeof err === 'string' ? err : err.message ?? 'The engine refused it' };
        return { status: 'complete', result: env.payload?.result ?? null, error: null };
      }
      if (j.status === 'error' || j.status === 'not_found') return { status: 'error', result: null, error: j.error ?? j.status };
    } catch {
      // transient — keep polling
    }
  }
  return { status: 'error', result: null, error: 'Timed out waiting for the engine' };
}
