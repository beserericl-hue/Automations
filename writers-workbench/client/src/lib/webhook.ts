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
