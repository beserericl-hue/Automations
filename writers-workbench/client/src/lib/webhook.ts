import { supabase } from '../config/supabase';

export interface HubEnqueueResult {
  jobId?: string;
  engineJob?: boolean;
  mode?: 'async' | 'sync';
  raw: unknown;
}

/**
 * Queue a hub command via the server proxy and return immediately.
 *
 * Always goes through /api/chat/proxy (never the raw n8n webhook from the browser). When
 * HUB_BACKEND=engine the server enqueues the heavy op and returns a job_id
 * right away, so the caller can background-poll /api/jobs/engine/:id/status and the UI is freed to
 * start other jobs. Info ops still come back inline (mode:'sync', no jobId).
 */
export async function enqueueHubCommand(userId: string, message: string): Promise<HubEnqueueResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const resp = await fetch('/api/chat/proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user_message_request: message, user_id: userId }),
  });
  if (!resp.ok) throw new Error('Failed to queue command');
  const body = (await resp.json()) as { jobId?: string; engineJob?: boolean; mode?: 'async' | 'sync' };
  return { jobId: body.jobId, engineJob: body.engineJob, mode: body.mode, raw: body };
}
