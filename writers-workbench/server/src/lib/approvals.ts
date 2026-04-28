/**
 * Shared approval-resolution core (Compose Newsletter 2a — S5).
 *
 * Two surfaces resolve approvals:
 *   - the email-link public HTML form `POST /approvals/:token/resolve` (Newsletter Migration S9)
 *   - the in-app session-authenticated JSON `POST /api/newsletter/approvals/:token/resolve` (S5)
 *
 * Both must run identical server-side state transitions — including the
 * race-safe conditional UPDATE that prevents double-resolve when both
 * surfaces fire simultaneously, and the unconditional SSE broadcast on
 * any successful update. Centralising the logic here eliminates the risk
 * of the two endpoints drifting apart.
 *
 * The function is "pure-ish" — it does I/O (Supabase + n8n + SSE) but
 * does not write to a Response object. Callers translate the typed
 * Result into HTML / JSON / status codes.
 */
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from './logger.js';
import { pushSseEvent } from '../routes/session.js';

export interface ApprovalRow {
  id: string;
  token: string;
  user_id: string;
  execution_id: string;
  resume_url: string;
  stage: 'stories' | 'subject_line';
  payload: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
  decision: 'approve' | 'revise' | null;
  feedback: string | null;
}

export type ResolveStatus =
  | 'ok'
  | 'not_found'
  | 'forbidden'
  | 'already_resolved'
  | 'expired'
  | 'lookup_error'
  | 'update_error'
  | 'resume_failed';

export interface ResolveOptions {
  token: string;
  decision: 'approve' | 'revise';
  feedback: string;
  /**
   * When provided, enforces `row.user_id === sessionUserId` and returns
   * 'forbidden' otherwise. Pass undefined for the public HTML endpoint —
   * the 24-byte token IS the credential there.
   */
  sessionUserId?: string;
}

export interface ResolveResult {
  status: ResolveStatus;
  /** Populated when we successfully fetched the approval row. */
  row?: ApprovalRow;
  /** Populated for 'ok' and 'resume_failed' — true when n8n acknowledged. */
  resumed?: boolean;
}

export async function resolveApproval(opts: ResolveOptions): Promise<ResolveResult> {
  const { token, decision, feedback, sessionUserId } = opts;
  const supabase = getSupabaseAdmin();

  // Fetch the row first — we need the resume_url, the user_id (for
  // ownership enforcement), and the current state.
  const { data: existing, error: lookupErr } = await supabase
    .from('newsletter_approvals_v2')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (lookupErr) {
    logger.error({ lookupErr, token }, 'resolveApproval: lookup failed');
    return { status: 'lookup_error' };
  }
  if (!existing) {
    return { status: 'not_found' };
  }

  const row = existing as ApprovalRow;

  if (sessionUserId !== undefined && row.user_id !== sessionUserId) {
    // The in-app surface enforces session-user match; without this, anyone
    // who guessed (or saw) a token could resolve someone else's approval.
    // The public surface SKIPS this branch by passing undefined — it relies
    // on token secrecy.
    return { status: 'forbidden', row };
  }

  if (row.resolved_at) {
    return { status: 'already_resolved', row };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { status: 'expired', row };
  }

  // Conditional UPDATE — only succeeds if resolved_at is still NULL.
  // PostgREST can't combine "WHERE expires_at > now()" into a single
  // chain without a stored function, so we lean on the resolved_at guard
  // and the pre-check above; if a concurrent caller wins the race the
  // .update().select() returns no row and we surface 'already_resolved'.
  const nowIso = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from('newsletter_approvals_v2')
    .update({ resolved_at: nowIso, decision, feedback })
    .eq('token', token)
    .is('resolved_at', null)
    .select()
    .maybeSingle();

  if (updateErr) {
    logger.error({ updateErr, token }, 'resolveApproval: update failed');
    return { status: 'update_error', row };
  }
  if (!updated) {
    return { status: 'already_resolved', row };
  }

  // Best-effort POST to the n8n Wait node's resume_url. Even when this
  // fails, the DB row IS resolved — callers should still surface the
  // outcome (502 on the public form, 502 on the in-app endpoint), but the
  // SSE broadcast still fires unconditionally so the UI doesn't show a
  // phantom open approval.
  let resumed = true;
  try {
    const resp = await fetch(row.resume_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, feedback }),
    });
    if (!resp.ok) {
      resumed = false;
      logger.warn({ token, status: resp.status }, 'resolveApproval: n8n resume returned non-2xx');
    }
  } catch (err) {
    resumed = false;
    logger.error({ err, token }, 'resolveApproval: n8n resume POST failed');
  }

  // SSE broadcast — `resumed` is part of the payload so the in-app UI can
  // distinguish "resolved cleanly" from "resolved but n8n didn't ack."
  try {
    await pushSseEvent(row.user_id, {
      event: 'newsletter.approval.resolved',
      data: {
        token,
        stage: row.stage,
        execution_id: row.execution_id,
        decision,
        feedback,
        resumed,
      },
    });
  } catch (err) {
    logger.warn({ err, userId: row.user_id, token }, 'resolveApproval: SSE broadcast failed');
  }

  return { status: resumed ? 'ok' : 'resume_failed', row, resumed };
}
