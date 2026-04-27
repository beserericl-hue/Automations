// Sprint 8: authenticated fetch wrapper that auto-attaches the Supabase JWT
// and the X-Impersonate-User header when an impersonation session is active.
//
// Use this for any call to /api/* that needs the user's identity. Direct
// Supabase queries (anon-key + RLS) do not flow through here — they remain
// the existing pattern in components.

import { supabase } from '../config/supabase';

const IMPERSONATION_KEY = 'sprint8.impersonation';

export interface ImpersonationSession {
  log_id: string;
  target_user_id: string;
  started_at: string;
  reason?: string;
}

export function getActiveImpersonation(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(IMPERSONATION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImpersonationSession;
  } catch {
    return null;
  }
}

export function setActiveImpersonation(session: ImpersonationSession | null): void {
  if (typeof window === 'undefined') return;
  if (session) {
    sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(session));
  } else {
    sessionStorage.removeItem(IMPERSONATION_KEY);
  }
}

export interface ApiOptions extends RequestInit {
  // Skip impersonation header even if a session is active (e.g. for the
  // superuser's own /superuser/* endpoints, where impersonation must NOT apply).
  skipImpersonation?: boolean;
}

/**
 * fetch wrapper for /api/* — adds Authorization Bearer + X-Impersonate-User.
 * Returns the parsed JSON body. Throws on non-2xx with a structured Error
 * carrying { status, code, message, body } so callers can branch on 402/403.
 */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new ApiError(401, 'NO_SESSION', 'No active Supabase session');
  }

  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  if (!options.skipImpersonation) {
    const imp = getActiveImpersonation();
    if (imp) {
      headers.set('X-Impersonate-User', imp.target_user_id);
    }
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const errBody = body as { error?: { code?: string; message?: string } } | null;
    const code = errBody?.error?.code ?? `HTTP_${res.status}`;
    const message = errBody?.error?.message ?? res.statusText;
    throw new ApiError(res.status, code, message, body);
  }

  return body as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; [key: string]: unknown };
}
