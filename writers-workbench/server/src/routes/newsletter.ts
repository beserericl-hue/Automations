/**
 * Compose Newsletter Phase 2a (S2) — newsletter editions + generate + status.
 *
 * Four endpoints, all session-authenticated:
 *
 *   GET  /api/newsletter/editions
 *     List enabled editions for the authenticated user (RLS-equivalent
 *     filter applied server-side because we use the service-role client).
 *
 *   GET  /api/newsletter/editions/:id/last-sent-markdown
 *     Returns {markdown: string | null} from the most recent
 *     newsletter_sends_v2 row for that edition. Used by the Generate page
 *     to pre-fill the "previous newsletter content" textarea.
 *
 *   POST /api/newsletter/generate
 *     Validates {edition_id, send_date, previous_newsletter_content?}.
 *     Looks up the edition row (404 if disabled or missing). POSTs JSON
 *     to N8N_NEWSLETTER_WEBHOOK_URL with X-Ingestion-Secret. The webhook's
 *     first downstream node (Respond to Webhook, added in S3) returns
 *     {executionId, editionId} synchronously; the handler proxies that
 *     through to the client as {executionId, started: true}.
 *
 *   GET  /api/newsletter/execution/:id/status
 *     Thin proxy over n8n public API GET /api/v1/executions/:id. Strips
 *     to {executionId, status, mode, startedAt, stoppedAt, lastNodeExecuted}.
 *
 * Note: until S3 lands the webhook trigger and N8N_NEWSLETTER_WEBHOOK_URL
 * gets set on Railway, /generate returns a 500 NOT_CONFIGURED — the route
 * itself is testable without the workflow.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireSharedSecret } from '../middleware/shared-secret.js';
import { validateBody } from '../middleware/validate.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import {
  GenerateSchema,
  NewsletterEditionIdParamSchema,
  StageCallbackSchema,
  ApprovalResolveSchema,
  ApprovalsOpenQuerySchema,
  ApprovalTokenParamSchema,
} from '../schemas.js';
import { logger } from '../lib/logger.js';
import { pushSseEvent } from './session.js';
import { resolveApproval } from '../lib/approvals.js';

export const newsletterRouter = Router();

// Mounted at /api/callback. Holds n8n-facing endpoints that authenticate
// via shared-secret header rather than a session JWT — this matches the
// requireApprovalSecret pattern used by /api/approvals/create.
export const newsletterCallbackRouter = Router();

/**
 * @openapi
 * /newsletter/editions:
 *   get:
 *     tags: [Newsletter]
 *     summary: List enabled newsletter editions for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "{success, editions: NewsletterEdition[]}" }
 *       401: { description: Missing or invalid auth }
 */
newsletterRouter.get('/editions', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('newsletter_editions_v2')
    .select('id, display_name, subheader, genre, description, newsletter_name, primary_color, paper_color, enabled, user_id, created_at, updated_at')
    .eq('user_id', userId)
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error, userId }, 'newsletter editions list failed');
    res.status(500).json({
      success: false,
      error: { code: 'DB_QUERY_FAILED', message: error.message },
    });
    return;
  }

  res.json({ success: true, editions: data ?? [] });
});

/**
 * @openapi
 * /newsletter/editions/{id}/last-sent-markdown:
 *   get:
 *     tags: [Newsletter]
 *     summary: Return the most recent newsletter's markdown body for an edition
 *     description: |
 *       Used by the Generate page to pre-fill the "previous newsletter
 *       content" textarea — the workflow uses it to avoid duplicate coverage.
 *       Returns `{markdown: null}` if the edition has no prior sends.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{success, markdown: string | null}" }
 *       400: { description: Invalid edition id }
 *       401: { description: Missing or invalid auth }
 *       404: { description: Edition not found / not enabled / not owned by caller }
 */
newsletterRouter.get(
  '/editions/:id/last-sent-markdown',
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = NewsletterEditionIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }

    const userId = req.userId!;
    const editionId = parsed.data.id;
    const supabase = getSupabaseAdmin();

    // Confirm the edition exists, is enabled, and belongs to the caller.
    const { data: edition, error: editionErr } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', editionId)
      .eq('user_id', userId)
      .eq('enabled', true)
      .maybeSingle();

    if (editionErr) {
      logger.error({ editionErr, editionId }, 'edition lookup failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: editionErr.message },
      });
      return;
    }
    if (!edition) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Edition ${editionId} not found, disabled, or not owned by caller` },
      });
      return;
    }

    // Most recent sent row for this edition (prefer 'sent' over 'scheduled' so
    // the textarea is pre-filled from real prior coverage rather than an
    // unreleased draft).
    const { data: sends, error: sendsErr } = await supabase
      .from('newsletter_sends_v2')
      .select('markdown_body, status, sent_at, created_at')
      .eq('user_id', userId)
      .eq('edition_id', editionId)
      .neq('status', 'cancelled')
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (sendsErr) {
      logger.error({ sendsErr, editionId }, 'last-sent lookup failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: sendsErr.message },
      });
      return;
    }

    const markdown = sends && sends.length > 0 ? (sends[0].markdown_body ?? null) : null;
    res.json({ success: true, markdown });
  },
);

/**
 * @openapi
 * /newsletter/generate:
 *   post:
 *     tags: [Newsletter]
 *     summary: Trigger a newsletter run (proxies the n8n webhook trigger)
 *     description: |
 *       POSTs JSON to the n8n webhook trigger added in S3 (configured at
 *       N8N_NEWSLETTER_WEBHOOK_URL on Railway). The webhook's first node
 *       returns {executionId, editionId} synchronously via Respond to
 *       Webhook — this handler awaits that and returns it to the client
 *       so the React app can navigate directly to /newsletter/execution/:id
 *       without any correlationId stitching.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [edition_id, send_date]
 *             properties:
 *               edition_id:                  { type: string }
 *               send_date:                   { type: string, format: date }
 *               previous_newsletter_content: { type: string }
 *     responses:
 *       200: { description: "{success, executionId, started: true}" }
 *       400: { description: Validation }
 *       401: { description: Missing or invalid auth }
 *       404: { description: Edition not found / disabled / not owned by caller }
 *       500: { description: NOT_CONFIGURED if N8N_NEWSLETTER_WEBHOOK_URL or INGESTION_SECRET missing, or upstream n8n error }
 *       502: { description: n8n webhook returned a non-2xx response }
 */
newsletterRouter.post(
  '/generate',
  requireAuth,
  validateBody(GenerateSchema),
  async (req: Request, res: Response) => {
    const body = req.body as import('zod').infer<typeof GenerateSchema>;
    const userId = req.userId!;

    const webhookUrl = process.env.N8N_NEWSLETTER_WEBHOOK_URL;
    const ingestionSecret = process.env.INGESTION_SECRET;
    if (!webhookUrl) {
      res.status(500).json({
        success: false,
        error: { code: 'NOT_CONFIGURED', message: 'N8N_NEWSLETTER_WEBHOOK_URL not set on server (S3 sets this after the webhook trigger is added).' },
      });
      return;
    }
    if (!ingestionSecret) {
      res.status(500).json({
        success: false,
        error: { code: 'NOT_CONFIGURED', message: 'INGESTION_SECRET not set on server' },
      });
      return;
    }

    // Edition must exist, be enabled, and be owned by the caller.
    const supabase = getSupabaseAdmin();
    const { data: edition, error: editionErr } = await supabase
      .from('newsletter_editions_v2')
      .select('id')
      .eq('id', body.edition_id)
      .eq('user_id', userId)
      .eq('enabled', true)
      .maybeSingle();

    if (editionErr) {
      logger.error({ editionErr, editionId: body.edition_id }, 'edition lookup failed');
      res.status(500).json({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: editionErr.message },
      });
      return;
    }
    if (!edition) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Edition ${body.edition_id} not found, disabled, or not owned by caller` },
      });
      return;
    }

    // The keys here match the form-trigger field labels n8n preserves on
    // the webhook side too, so set_trigger_inputs (S3) can normalize either
    // shape into one.
    const webhookBody = {
      Date: body.send_date,
      'Previous Newsletter Content': body.previous_newsletter_content ?? '',
      'Edition Id': body.edition_id,
    };

    let upstream: Response | undefined;
    try {
      upstream = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ingestion-Secret': ingestionSecret,
        },
        body: JSON.stringify(webhookBody),
      }) as unknown as Response;
    } catch (err) {
      logger.error({ err, webhookUrl }, 'newsletter generate: n8n webhook fetch threw');
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_FETCH_FAILED', message: 'Could not reach n8n webhook' },
      });
      return;
    }

    if (!upstream || !('ok' in upstream) || !upstream.ok) {
      const status = (upstream as unknown as { status?: number })?.status ?? 0;
      let detail = '';
      try { detail = await (upstream as unknown as { text(): Promise<string> }).text(); } catch { /* best-effort */ }
      logger.error({ status, detail, webhookUrl }, 'newsletter generate: n8n returned non-2xx');
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_NON_2XX', message: `n8n webhook returned ${status}` },
      });
      return;
    }

    let payload: { executionId?: string; editionId?: string } = {};
    try {
      payload = await (upstream as unknown as { json(): Promise<unknown> }).json() as typeof payload;
    } catch (err) {
      logger.error({ err }, 'newsletter generate: n8n webhook returned non-JSON body');
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_BAD_BODY', message: 'n8n webhook response was not JSON' },
      });
      return;
    }

    if (!payload.executionId) {
      logger.error({ payload }, 'newsletter generate: n8n response missing executionId');
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_MISSING_EXECUTION_ID', message: 'n8n webhook response did not include executionId — confirm the Respond to Webhook node is wired (S3).' },
      });
      return;
    }

    res.json({
      success: true,
      executionId: payload.executionId,
      editionId: payload.editionId ?? body.edition_id,
      started: true,
    });
  },
);

/**
 * @openapi
 * /newsletter/execution/{id}/status:
 *   get:
 *     tags: [Newsletter]
 *     summary: Read n8n execution status (proxy over n8n public API)
 *     description: |
 *       Strips n8n's response to the fields the UI needs. Hides the
 *       n8n API key from the browser.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{success, executionId, status, mode, startedAt, stoppedAt, lastNodeExecuted}" }
 *       401: { description: Missing or invalid auth }
 *       404: { description: n8n returned 404 for this execution id }
 *       500: { description: NOT_CONFIGURED if N8N_API_KEY missing, or upstream n8n error }
 *       502: { description: n8n returned non-2xx } */
newsletterRouter.get(
  '/execution/:id/status',
  requireAuth,
  async (req: Request, res: Response) => {
    const executionId = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(executionId)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_EXECUTION_ID', message: 'execution id format invalid' },
      });
      return;
    }

    const apiKey = process.env.N8N_API_KEY;
    const apiUrl = process.env.N8N_API_URL || 'https://n8n.agileadautomation.com';
    if (!apiKey) {
      res.status(500).json({
        success: false,
        error: { code: 'NOT_CONFIGURED', message: 'N8N_API_KEY not set on server' },
      });
      return;
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${apiUrl}/api/v1/executions/${executionId}`, {
        headers: { 'X-N8N-API-KEY': apiKey, 'Accept': 'application/json' },
      }) as unknown as Response;
    } catch (err) {
      logger.error({ err, executionId }, 'execution status: n8n fetch threw');
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_FETCH_FAILED', message: 'Could not reach n8n' },
      });
      return;
    }

    const status = (upstream as unknown as { status: number }).status;
    if (status === 404) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `n8n execution ${executionId} not found` },
      });
      return;
    }
    if (status >= 300) {
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_NON_2XX', message: `n8n returned ${status}` },
      });
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = await (upstream as unknown as { json(): Promise<Record<string, unknown>> }).json();
    } catch {
      res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_BAD_BODY', message: 'n8n response was not JSON' },
      });
      return;
    }

    // Strip to the fields the UI cares about — never proxy n8n's full payload
    // because it contains item-level run data + secrets in node parameters.
    res.json({
      success: true,
      executionId: body.id,
      status: body.status,
      mode: body.mode,
      startedAt: body.startedAt,
      stoppedAt: body.stoppedAt,
      lastNodeExecuted: (body.data as { resultData?: { lastNodeExecuted?: string } } | undefined)?.resultData?.lastNodeExecuted ?? null,
    });
  },
);

// --------------------------------------------------------------------
// Compose Newsletter 2a (S5) — in-app approvals API
//
// Session-authenticated counterparts to the public email-link approval
// surface. Both endpoints pin every action to the caller's session id —
// no token-as-credential here, the JWT is the credential and the token
// is just a row identifier.
//
//   GET  /api/newsletter/approvals/open
//        List the caller's open approvals (resolved_at IS NULL AND
//        expires_at > now()), with optional execution_id and stage
//        filters. Returns each row's payload plus a constructed
//        approval_url so the UI can deep-link to the public form too.
//
//   POST /api/newsletter/approvals/:token/resolve
//        JSON variant of the public form. Returns 403 when the token
//        belongs to another user, 409 when already resolved, 410 when
//        expired, 502 when the n8n resume POST fails (decision is still
//        persisted and the SSE event still fires). The resolve core
//        lives in lib/approvals.ts and is shared with the public route
//        so behaviour cannot drift.
// --------------------------------------------------------------------

/**
 * @openapi
 * /newsletter/approvals/open:
 *   get:
 *     tags: [Newsletter]
 *     summary: List the caller's open (unresolved, unexpired) newsletter approvals
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: execution_id
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: stage
 *         required: false
 *         schema: { type: string, enum: [stories, subject_line] }
 *     responses:
 *       200: { description: "{success, approvals: ApprovalRow[]}" }
 *       400: { description: Validation error }
 *       401: { description: Missing or invalid auth }
 */
newsletterRouter.get('/approvals/open', requireAuth, async (req: Request, res: Response) => {
  const parsed = ApprovalsOpenQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  const userId = req.userId!;
  const { execution_id, stage } = parsed.data;

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  let query = supabase
    .from('newsletter_approvals_v2')
    .select('id, token, user_id, execution_id, stage, payload, created_at, expires_at, resolved_at, decision, feedback')
    .eq('user_id', userId)
    .is('resolved_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(100);

  if (execution_id) query = query.eq('execution_id', execution_id);
  if (stage) query = query.eq('stage', stage);

  const { data, error } = await query;
  if (error) {
    logger.error({ error, userId }, 'newsletter approvals open: query failed');
    res.status(500).json({ success: false, error: { code: 'DB_QUERY_FAILED', message: error.message } });
    return;
  }

  // Tag each row with its public approval URL when APPROVAL_BASE_URL is
  // configured — handy for "open in browser" actions in the in-app UI even
  // though the in-app POST does the actual resolve.
  const baseUrl = process.env.APPROVAL_BASE_URL;
  const approvals = (data ?? []).map((row) => ({
    ...row,
    approval_url: baseUrl ? `${baseUrl}/approvals/${row.token}` : null,
  }));

  res.json({ success: true, approvals });
});

/**
 * @openapi
 * /newsletter/approvals/{token}/resolve:
 *   post:
 *     tags: [Newsletter]
 *     summary: In-app resolve of a newsletter approval (session-authenticated)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [approve, revise] }
 *               feedback: { type: string }
 *     responses:
 *       200: { description: "{success: true, resumed: true}" }
 *       400: { description: Validation }
 *       401: { description: Missing or invalid auth }
 *       403: { description: Token belongs to another user }
 *       404: { description: Token unknown }
 *       409: { description: Already resolved }
 *       410: { description: Expired }
 *       502: { description: n8n resume POST failed (decision still persisted) }
 */
newsletterRouter.post(
  '/approvals/:token/resolve',
  requireAuth,
  validateBody(ApprovalResolveSchema),
  async (req: Request, res: Response) => {
    const params = ApprovalTokenParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', fields: params.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      });
      return;
    }
    const { token } = params.data;
    const body = req.body as import('zod').infer<typeof ApprovalResolveSchema>;
    const userId = req.userId!;

    const result = await resolveApproval({
      token,
      decision: body.decision,
      feedback: body.feedback,
      sessionUserId: userId,
    });

    switch (result.status) {
      case 'ok':
        res.json({ success: true, resumed: true });
        return;
      case 'resume_failed':
        // Decision persisted, SSE broadcast fired, but n8n didn't ack the
        // resume. UI should surface this as "saved, retry workflow".
        res.status(502).json({
          success: true,
          resumed: false,
          error: { code: 'UPSTREAM_RESUME_FAILED', message: 'Decision saved, but the n8n resume POST failed' },
        });
        return;
      case 'not_found':
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Approval not found' } });
        return;
      case 'forbidden':
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'This approval belongs to another user' } });
        return;
      case 'already_resolved':
        res.status(409).json({
          success: false,
          error: { code: 'ALREADY_RESOLVED', message: 'Approval was already resolved' },
          resolved_at: result.row?.resolved_at ?? null,
          decision: result.row?.decision ?? null,
        });
        return;
      case 'expired':
        res.status(410).json({
          success: false,
          error: { code: 'EXPIRED', message: 'Approval window has closed' },
          expires_at: result.row?.expires_at ?? null,
        });
        return;
      case 'lookup_error':
      case 'update_error':
        res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: 'Database operation failed' } });
        return;
    }
  },
);

// --------------------------------------------------------------------
// Stage-emit callback — POST /api/callback/newsletter-stage
//
// Called by the 9 emit_stage_* nodes inside `Content - Newsletter Agent V2`
// each time the workflow crosses a checkpoint. Auth is `X-Callback-Secret`
// (shared with n8n via the `DEV Workbench Newsletter Callback Secret`
// httpHeaderAuth credential). Side effect: publish a `newsletter.stage`
// event to the SSE channel for the workflow's user, so the in-app
// Execution Status page (S7) can update its progress strip in real time.
//
// The handler intentionally validates strictly and returns 400/401 cleanly,
// because n8n emit nodes use `onError: continueRegularOutput` — a 4xx
// from here only logs in the n8n UI; it never poisons the run.
// --------------------------------------------------------------------

const requireCallbackSecret = requireSharedSecret(
  'X-Callback-Secret',
  'NEWSLETTER_CALLBACK_SECRET',
);

/**
 * @openapi
 * /callback/newsletter-stage:
 *   post:
 *     tags: [Newsletter]
 *     summary: Receive a stage-update callback from the n8n compose-newsletter workflow
 *     description: |
 *       Authenticated via `X-Callback-Secret` (shared with n8n). Validated
 *       payload is rebroadcast as a `newsletter.stage` SSE event on
 *       `sse:{userId}` so the React Execution Status page can update.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, executionId, editionId, stage, ts]
 *             properties:
 *               userId:      { type: string }
 *               executionId: { type: string }
 *               editionId:   { type: string }
 *               stage:       { type: string, enum: [gathering, selecting_stories, awaiting_stories_approval, stories_approved, awaiting_subject_approval, subject_approved, writing_segment, segments_done, saved, error] }
 *               detail:      { type: string }
 *               ts:          { type: string, format: date-time }
 *     responses:
 *       200: { description: "{success: true, broadcast: number} — count of SSE consumers reached" }
 *       400: { description: Validation error }
 *       401: { description: Missing or invalid X-Callback-Secret }
 *       500: { description: NEWSLETTER_CALLBACK_SECRET not configured }
 */
newsletterCallbackRouter.post(
  '/newsletter-stage',
  requireCallbackSecret,
  validateBody(StageCallbackSchema),
  async (req: Request, res: Response) => {
    const body = req.body as import('zod').infer<typeof StageCallbackSchema>;

    const broadcast = await pushSseEvent(body.userId, {
      event: 'newsletter.stage',
      data: {
        userId: body.userId,
        executionId: body.executionId,
        editionId: body.editionId,
        stage: body.stage,
        detail: body.detail ?? '',
        ts: body.ts,
      },
    });

    logger.info(
      { userId: body.userId, executionId: body.executionId, stage: body.stage, broadcast },
      'newsletter stage callback',
    );

    res.json({ success: true, broadcast });
  },
);
