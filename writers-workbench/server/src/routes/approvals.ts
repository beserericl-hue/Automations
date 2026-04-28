/**
 * Newsletter-approval backend (S9).
 *
 * n8n (Content - Newsletter Agent V2) calls POST /api/approvals/create to mint
 * a one-time token and park it in `newsletter_approvals_v2`, then sends the
 * reviewer a Postal email pointing at `{APPROVAL_BASE_URL}/approvals/{token}`.
 *
 * The reviewer opens that URL in a browser, sees a server-side-rendered form
 * (no React — same lightweight pattern as routes/images.ts and
 * routes/ingestion.ts), picks Approve or Revise with an optional feedback
 * note, and submits. The POST /approvals/:token/resolve handler records the
 * decision and POSTs it back to the n8n Wait node's `resume_url`, which
 * reactivates the workflow.
 *
 * Security:
 * - POST /api/approvals/create is gated by X-Approval-Secret (shared secret
 *   between n8n and the server). Never user-facing.
 * - GET/POST /approvals/:token is PUBLIC by design — the 24-byte token IS
 *   the credential. The server never exposes the resume_url to the browser.
 * - Rows expire after 48h (`expires_at` default on the table). Expired or
 *   already-resolved tokens return 410/409 without doing anything.
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { ApprovalCreateSchema, ApprovalResolveSchema } from '../schemas.js';
import { logger } from '../lib/logger.js';
import { pushSseEvent } from './session.js';
import { resolveApproval } from '../lib/approvals.js';

// Mount by caller:
//   app.use('/api/approvals', approvalsApiRouter)
//   app.use('/approvals',     approvalsPublicRouter)
export const approvalsApiRouter = Router();
export const approvalsPublicRouter = Router();

const TOKEN_BYTES = 24;
const requireApprovalSecret = requireSharedSecret('X-Approval-Secret', 'APPROVAL_SECRET');

// --------------------------------------------------------------------
// Types for the row shape we read back from Supabase.
interface ApprovalRow {
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

// --------------------------------------------------------------------
// Token safety — matches the ingestion key guard pattern. The token is
// generated server-side so it's known safe, but when it arrives on the
// :token path param it must still be validated before any DB lookup.
function isValidToken(t: string): boolean {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(t);
}

// --------------------------------------------------------------------
// HTML page helpers. Tiny hand-rolled strings — no templating lib
// dependency, same pattern as routes/images.ts.
function htmlEscape(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${htmlEscape(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  .stage-badge { display: inline-block; background: #eef; color: #336; padding: 2px 8px; border-radius: 4px; font-size: .85rem; margin-left: .5rem; }
  .payload { background: #f6f8fa; padding: 1rem; border-radius: 6px; white-space: pre-wrap; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: .85rem; overflow-x: auto; }
  form { margin-top: 2rem; padding: 1rem; border: 1px solid #ddd; border-radius: 6px; }
  label.radio { display: block; margin: .5rem 0; font-weight: 500; }
  textarea { width: 100%; box-sizing: border-box; min-height: 100px; font-family: inherit; font-size: 1rem; padding: .5rem; }
  button { background: #0366d6; color: #fff; border: 0; border-radius: 4px; padding: .6rem 1.2rem; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
  button:hover { background: #024ea4; }
  .gone { color: #666; background: #fff5f5; padding: 1rem; border-radius: 6px; border: 1px solid #fcc; }
  .ok { color: #0a6; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderForm(row: ApprovalRow): string {
  const stageLabel = row.stage === 'stories' ? 'Top Stories' : 'Subject Line';
  const payloadJson = JSON.stringify(row.payload, null, 2);
  return pageShell(
    `Newsletter approval — ${stageLabel}`,
    `
      <h1>Newsletter approval <span class="stage-badge">${htmlEscape(row.stage)}</span></h1>
      <p>Expires ${htmlEscape(row.expires_at)}. Review the payload below, then Approve or ask for a revision.</p>
      <h2>${htmlEscape(stageLabel)}</h2>
      <div class="payload">${htmlEscape(payloadJson)}</div>
      <form method="POST" action="/approvals/${htmlEscape(row.token)}/resolve">
        <label class="radio"><input type="radio" name="decision" value="approve" required/> Approve as-is</label>
        <label class="radio"><input type="radio" name="decision" value="revise"/> Request revision</label>
        <h2>Feedback <small>(optional for approve, required for revise)</small></h2>
        <textarea name="feedback" placeholder="Revision notes or approval comment"></textarea>
        <button type="submit">Submit decision</button>
      </form>
    `,
  );
}

function renderResolved(row: ApprovalRow): string {
  return pageShell(
    'Already resolved',
    `
      <h1>Already resolved</h1>
      <p class="gone">This approval was already recorded as <strong>${htmlEscape(row.decision || 'unknown')}</strong> at ${htmlEscape(row.resolved_at)}.</p>
    `,
  );
}

function renderExpired(row: ApprovalRow): string {
  return pageShell(
    'Approval expired',
    `
      <h1>Approval expired</h1>
      <p class="gone">This approval link expired at ${htmlEscape(row.expires_at)}. The workflow should have timed out on its own. If you still need to approve this newsletter, re-trigger the workflow to generate a fresh link.</p>
    `,
  );
}

function renderThankYou(decision: string): string {
  return pageShell(
    'Decision recorded',
    `
      <h1 class="ok">Decision recorded</h1>
      <p>Your <strong>${htmlEscape(decision)}</strong> has been sent back to the workflow. You can close this tab.</p>
    `,
  );
}

// --------------------------------------------------------------------
// POST /api/approvals/create — n8n -> server
// --------------------------------------------------------------------
/**
 * @openapi
 * /approvals/create:
 *   post:
 *     tags: [Newsletter Approvals]
 *     summary: Mint a one-time newsletter approval token (n8n -> server)
 *     description: |
 *       Called from `Content - Newsletter Agent V2` at each approval gate.
 *       Inserts a `newsletter_approvals_v2` row and returns the public URL
 *       the reviewer should click. The Wait node's resume URL never leaves
 *       the server.
 *     parameters:
 *       - in: header
 *         name: X-Approval-Secret
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, stage, payload, resume_url, execution_id]
 *             properties:
 *               user_id:      { type: string }
 *               stage:        { type: string, enum: [stories, subject_line] }
 *               payload:      { type: object }
 *               resume_url:   { type: string, format: uri }
 *               execution_id: { type: string }
 *     responses:
 *       200: { description: "{ success, token, approval_url }" }
 *       400: { description: Validation failure }
 *       401: { description: Missing/invalid X-Approval-Secret }
 *       500: { description: APPROVAL_BASE_URL not configured or DB error }
 */
approvalsApiRouter.post(
  '/create',
  requireApprovalSecret,
  validateBody(ApprovalCreateSchema),
  async (req: Request, res: Response) => {
    const body = req.body as import('zod').infer<typeof ApprovalCreateSchema>;
    const baseUrl = process.env.APPROVAL_BASE_URL;
    if (!baseUrl) {
      res.status(500).json({
        success: false,
        error: { code: 'NOT_CONFIGURED', message: 'APPROVAL_BASE_URL not set on server' },
      });
      return;
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

    const supabase = getSupabaseAdmin();
    const { error: dbError } = await supabase
      .from('newsletter_approvals_v2')
      .insert({
        token,
        user_id: body.user_id,
        execution_id: body.execution_id,
        resume_url: body.resume_url,
        stage: body.stage,
        payload: body.payload,
      });

    if (dbError) {
      const code = (dbError as { code?: string }).code;
      if (code === '23503') {
        res.status(400).json({
          success: false,
          error: { code: 'FK_VIOLATION', message: 'user_id does not exist in users_v2' },
        });
        return;
      }
      logger.error({ dbError }, 'approvals create: insert failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_INSERT_FAILED', message: dbError.message },
      });
      return;
    }

    // Compose Newsletter 2a (S3): broadcast a `newsletter.approval.created`
    // event to the workflow user's SSE channel so the in-app approvals
    // queue lights up in real time. Best-effort — never block the response
    // on it (n8n is waiting synchronously for {token, approval_url}).
    try {
      await pushSseEvent(body.user_id, {
        event: 'newsletter.approval.created',
        data: {
          token,
          stage: body.stage,
          execution_id: body.execution_id,
          approval_url: `${baseUrl}/approvals/${token}`,
        },
      });
    } catch (err) {
      logger.warn({ err, userId: body.user_id }, 'approvals create: SSE broadcast failed');
    }

    res.json({
      success: true,
      token,
      approval_url: `${baseUrl}/approvals/${token}`,
    });
  },
);

// --------------------------------------------------------------------
// GET /approvals/:token — user-facing form
// --------------------------------------------------------------------
/**
 * @openapi
 * /approvals/{token}:
 *   get:
 *     tags: [Newsletter Approvals]
 *     summary: Approval form (HTML) for newsletter reviewers
 *     description: |
 *       No authentication — the 24-byte token is the credential. Renders
 *       an HTML form or a gone/expired page as appropriate.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: HTML form / resolved / expired page }
 *       400: { description: Invalid token format }
 *       404: { description: No matching approval row }
 */
approvalsPublicRouter.get('/:token', async (req: Request, res: Response) => {
  const tokenParam = req.params.token as unknown;
  const token: string = Array.isArray(tokenParam) ? tokenParam.join('') : String(tokenParam ?? '');
  if (!isValidToken(token)) {
    res.status(400).type('html').send(pageShell('Invalid link', '<h1>Invalid approval link</h1><p class="gone">Token malformed.</p>'));
    return;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('newsletter_approvals_v2')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error, token }, 'approvals form: lookup failed');
    res.status(500).type('html').send(pageShell('Lookup error', '<h1>Lookup error</h1>'));
    return;
  }
  if (!data) {
    res.status(404).type('html').send(pageShell('Not found', '<h1>Not found</h1><p class="gone">No approval matches this token.</p>'));
    return;
  }

  const row = data as ApprovalRow;
  if (row.resolved_at) {
    res.status(200).type('html').send(renderResolved(row));
    return;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    res.status(410).type('html').send(renderExpired(row));
    return;
  }
  res.status(200).type('html').send(renderForm(row));
});

// --------------------------------------------------------------------
// POST /approvals/:token/resolve — form submission
// --------------------------------------------------------------------
/**
 * @openapi
 * /approvals/{token}/resolve:
 *   post:
 *     tags: [Newsletter Approvals]
 *     summary: Record a reviewer decision and resume the n8n Wait node
 *     description: |
 *       Public form POST — token is the credential. On success, UPDATEs the
 *       row and POSTs `{decision, feedback}` to the n8n Wait node's resume_url
 *       stored server-side. Renders a thank-you page.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               decision: { type: string, enum: [approve, revise] }
 *               feedback: { type: string }
 *     responses:
 *       200: { description: Decision recorded, n8n resumed }
 *       400: { description: Invalid token or missing decision }
 *       409: { description: Already resolved }
 *       410: { description: Expired }
 *       502: { description: Resume POST to n8n failed }
 */
approvalsPublicRouter.post(
  '/:token/resolve',
  async (req: Request, res: Response) => {
    const tokenParam = req.params.token as unknown;
    const token: string = Array.isArray(tokenParam) ? tokenParam.join('') : String(tokenParam ?? '');
    if (!isValidToken(token)) {
      res.status(400).type('html').send(pageShell('Bad request', '<h1>Invalid token</h1>'));
      return;
    }

    const parsed = ApprovalResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      res.status(400).type('html').send(pageShell('Bad request', `<h1>Invalid decision</h1><pre>${htmlEscape(JSON.stringify(fields))}</pre>`));
      return;
    }
    const { decision, feedback } = parsed.data;

    // Public surface — token is the credential, no session-user enforcement.
    // S5 extracted the resolve core into lib/approvals.ts; the in-app
    // counterpart at /api/newsletter/approvals/:token/resolve calls the same
    // function with sessionUserId set so behavior never drifts.
    const result = await resolveApproval({ token, decision, feedback });
    const row = result.row;

    switch (result.status) {
      case 'lookup_error':
        res.status(500).type('html').send(pageShell('Lookup error', '<h1>Lookup error</h1>'));
        return;
      case 'not_found':
        res.status(404).type('html').send(pageShell('Not found', '<h1>Not found</h1>'));
        return;
      case 'already_resolved':
        res.status(409).type('html').send(row ? renderResolved(row) : pageShell('Already resolved', '<h1>Already resolved</h1>'));
        return;
      case 'expired':
        res.status(410).type('html').send(row ? renderExpired(row) : pageShell('Expired', '<h1>Expired</h1>'));
        return;
      case 'update_error':
        res.status(500).type('html').send(pageShell('Update error', '<h1>Update error</h1>'));
        return;
      case 'resume_failed':
        res.status(502).type('html').send(
          pageShell(
            'Decision recorded, but workflow resume failed',
            `<h1>Decision recorded</h1><p class="gone">Your <strong>${htmlEscape(decision)}</strong> was saved, but resuming the newsletter workflow failed. The on-call operator can rerun the workflow manually if needed.</p>`,
          ),
        );
        return;
      case 'forbidden':
        // Not reachable from the public endpoint (we don't pass sessionUserId)
        // — but compile-time exhaustiveness keeps the switch honest if a new
        // status is added later.
        res.status(403).type('html').send(pageShell('Forbidden', '<h1>Forbidden</h1>'));
        return;
      case 'ok':
        res.status(200).type('html').send(renderThankYou(decision));
        return;
    }
  },
);
