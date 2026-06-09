import { N8N_WEBHOOK_URL } from '../config/constants';
import { supabase } from '../config/supabase';

/**
 * Send a command to the n8n hub webhook.
 * Tries direct first, falls back to server proxy on CORS failure.
 */
export async function sendWebhookCommand(userId: string, message: string): Promise<unknown> {
  const payload = { user_message_request: message, user_id: userId };

  // Try direct webhook first
  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const text = await resp.text();
      return text ? JSON.parse(text) : { success: true };
    }
  } catch {
    // CORS blocked — fall through to proxy
  }

  // Fallback: server proxy with auth
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const resp = await fetch('/api/chat/proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) throw new Error('Failed to send command');
  return resp.json();
}

export interface HubEnqueueResult {
  jobId?: string;
  engineJob?: boolean;
  mode?: 'async' | 'sync';
  raw: unknown;
}

/**
 * Queue a hub command via the server proxy and return immediately.
 *
 * Unlike sendWebhookCommand (which posts to the n8n webhook directly and stays pending until the
 * op finishes — hanging the UI for minutes on a write/outline), this always goes through
 * /api/chat/proxy. When HUB_BACKEND=engine the server enqueues the heavy op and returns a job_id
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
