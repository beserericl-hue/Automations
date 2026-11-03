import type { Response } from 'express';
import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { ChatProxySchema } from '../schemas.js';
import { logger } from '../lib/logger.js';
import { classifyJob } from '../lib/jobs/classifier.js';
import { getNamedQueue } from '../lib/queue.js';
import { addTrackedJob } from '../lib/jobs/job-tracker.js';
import type { N8nWebhookJob } from '../lib/jobs/types.js';
import { getCreditCost } from '../services/credit-costs.js';
import { deductCredits } from '../services/credits.js';
import { hubBackend, callEngineHub, abortEngineJob, type HubResponse } from '../lib/engine-hub.js';
import { assistantUnits } from './content-studio.js';
import { chargeCredits, sendInsufficient } from '../lib/credit-charge.js';

export const chatRouter = Router();

/**
 * Resolve the n8n hub webhook URL for the current environment.
 * Preferred: `N8N_HUB_WEBHOOK_URL` (full URL — dev uses the `_dev` suffix,
 * prod uses `_v2`). Falls back to the historical N8N_API_URL-based form so
 * existing Railway services keep working without env var changes.
 */
function resolveWebhookUrl(): string {
  if (process.env.N8N_HUB_WEBHOOK_URL) return process.env.N8N_HUB_WEBHOOK_URL;
  if (process.env.N8N_API_URL) return `${process.env.N8N_API_URL}/webhook/author_request_v2`;
  return '';
}

/**
 * @openapi
 * /chat/proxy:
 *   post:
 *     tags: [Chat]
 *     summary: Dispatch chat message to n8n (sync direct or async via queue)
 *     description: |
 *       Classifies the user message by operation type. Sync ops (list/retrieve/approve/etc.)
 *       are forwarded straight to the n8n webhook. Async ops (write/brainstorm/generate/etc.)
 *       are enqueued onto the BullMQ queue tier matching their priority, and the handler
 *       returns a job id that the client can stream progress for via /api/callback/events.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatProxyRequest'
 *     responses:
 *       200:
 *         description: Either the sync webhook body or an async job acknowledgement.
 *       401:
 *         description: Missing or invalid auth token
 *       502:
 *         description: Failed to reach n8n webhook (sync path only)
 */
/** Privileged roles bypass credit checks (Sprint 8). */
function bypassCredits(req: { effectiveRole?: string }): boolean {
  return req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
}

/** Set X-Credits-Remaining response header (Sprint 8 / S8-6). */
function setCreditsHeader(res: Response, remaining: number): void {
  res.setHeader('X-Credits-Remaining', String(remaining));
}

/**
 * What one engine-hub turn costs, from what the hub ACTUALLY ran (2026-11-03). The server's regex
 * classifier only guesses; the engine's router decides. Each dispatched op is priced under its own
 * credit key (chapter.write -> write_chapter, research.run -> research, brainstorm.story ->
 * brainstorm_story, library reads -> 0 ...). A turn that ran no op (a plain answer, or a fan-out whose
 * clauses were all answers) costs the chat rate. A Content Studio op is priced per topic/draft, as on
 * the studio page.
 */
export async function hubTurnCost(hub: HubResponse): Promise<{ cost: number; ops: string[] }> {
  if (hub.kind === 'error') return { cost: 0, ops: [] };
  const dispatched: Array<{ tool: string; op: string; params?: Record<string, unknown> | null }> = [];
  if (Array.isArray(hub.jobs) && hub.jobs.length > 0) {
    for (const j of hub.jobs) {
      if (j?.tool && j?.op) dispatched.push({ tool: j.tool, op: j.op });
    }
  } else if (hub.kind !== 'reply' && hub.tool && hub.op) {
    dispatched.push({ tool: hub.tool, op: hub.op, params: hub.params });
  }
  if (dispatched.length === 0) {
    return { cost: await getCreditCost('chat_generic'), ops: ['chat_generic'] };
  }
  let cost = 0;
  for (const d of dispatched) {
    const unit = await getCreditCost(`${d.tool}.${d.op}`);
    // Studio drafting is per topic / per draft revised; a studio op that drafts nothing is free.
    cost += d.tool === 'studio' ? unit * (hub.kind === 'queued' ? assistantUnits(d.op, d.params ?? null) : 0) : unit;
  }
  return { cost, ops: dispatched.map((d) => `${d.tool}.${d.op}`) };
}

/** Engine job ids a hub turn started (the fan-out's jobs, or the single job). */
function hubJobIds(hub: HubResponse): string[] {
  const ids = Array.isArray(hub.jobs) ? hub.jobs.map((j) => j?.job_id).filter((x): x is string => Boolean(x)) : [];
  if (ids.length === 0 && hub.job_id) ids.push(hub.job_id);
  return ids;
}

chatRouter.post('/proxy', requireAuth, validateBody(ChatProxySchema), async (req, res) => {
  const webhookUrl = resolveWebhookUrl();

  // The n8n webhook is only required when n8n is the backend; the engine-hub path doesn't use it.
  if (hubBackend() !== 'engine' && !webhookUrl) {
    res.status(500).json({ error: 'N8N webhook URL not configured' });
    return;
  }

  const message = req.body.user_message_request as string;
  const classification = classifyJob(message);
  const userId = req.userId!;

  if (req.body.dry_run === true) {
    res.json({
      mode: 'sync',
      dryRun: true,
      classification: { tier: classification.tier, queue: classification.queue, jobType: classification.jobType },
      assistantMessage: `Understood as ${classification.jobType}. Dry run: nothing was started.`,
      creditsCharged: 0,
    });
    return;
  }

  const hasSubscription = req.subscriptionTier !== null && req.subscriptionTier !== undefined;

  // CR-008 Workstream C: Path B cutover. When HUB_BACKEND=engine, route to the engine hub instead of
  // n8n — its Gemini router picks the tool, info ops return data synchronously, load-bearing ops are
  // queued (returning an engine job_id the client polls via /api/jobs/engine/:id). Default is n8n.
  //
  // Charging (2026-11-03): by the op the engine ROUTED to, once, after it is known (hubTurnCost). The
  // pre-flight gate can only check the chat rate, since nothing is known before routing; the real
  // charge is then an atomic deduction that refuses to overdraw. If the balance does not cover the
  // routed op, the queued job(s) are aborted and the turn answers 402 like any other priced op.
  if (hubBackend() === 'engine') {
    const chatRate = await getCreditCost('chat_generic');
    if (!bypassCredits(req) && hasSubscription && chatRate > 0 && (req.creditsRemaining ?? 0) < chatRate) {
      sendInsufficient(res, chatRate, req.creditsRemaining ?? 0);
      return;
    }
    let hub: HubResponse;
    try {
      // The page's project rides in `context`; the conversation id keys the engine's memory of this
      // drawer session (last list shown, current project, recent turns), which the engine loads
      // before routing and saves after it answers.
      hub = await callEngineHub({
        message,
        userId,
        conversationId: req.body.conversation_id,
        context: {
          ...(req.body.project_id ? { project_id: req.body.project_id } : {}),
          ...(req.body.project_title ? { project_title: req.body.project_title } : {}),
        },
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'chat: engine hub failed');
      res.status(502).json({ error: 'Failed to reach engine hub' });
      return;
    }
    const { cost: turnCost, ops } = await hubTurnCost(hub);
    const jobIds = hubJobIds(hub);
    const paid = await chargeCredits(req, res, turnCost, `chat.engine:${ops.join('+')}`, jobIds[0]);
    if (paid.refused) {
      // The routed op costs more than the balance: the work must not run for free.
      await Promise.all(jobIds.map((id) => abortEngineJob(id).catch(() => ({ aborted: false }))));
      logger.warn({ userId, ops, turnCost, jobIds }, 'chat: routed op unaffordable; engine job(s) aborted');
      sendInsufficient(res, turnCost, paid.remaining);
      return;
    }
    const balance = paid.remaining;
    const classBlock = {
      tier: classification.tier,
      queue: classification.queue,
      jobType: classification.jobType,
    };
    const conversation = hub.conversation_id ? { conversationId: hub.conversation_id } : {};
    const charged = { creditsCharged: paid.charged, creditsRemaining: balance, chargedOps: ops, ...(jobIds.length > 1 ? { jobIds } : {}) };
    if (hub.kind === 'queued' && hub.job_id) {
      res.json({
        mode: 'async', jobId: hub.job_id, engineJob: true, status: hub.status ?? 'queued',
        assistantMessage: hub.assistant_message, classification: classBlock,
        ...charged,
        ...conversation,
      });
    } else {
      res.json({
        mode: 'sync', classification: classBlock,
        ...charged,
        assistantMessage: hub.assistant_message,
        data: hub.kind === 'data' ? hub.data : { reply: hub.assistant_message },
        ...(hub.tool ? { tool: hub.tool, op: hub.op } : {}),
        ...conversation,
      });
    }
    return;
  }

  // Sprint 8: pre-flight credit check (n8n backend). Cost is dynamic per jobType, sourced from the
  // global config with hard-coded defaults. Superusers/admins bypass. Users with NO subscription
  // record (e.g. mid-onboarding, test fixtures) are also let through — the credit gate only fires
  // once a subscription exists. n8n does not report what it ran, so the classifier's guess prices it.
  const cost = await getCreditCost(classification.jobType);
  if (!bypassCredits(req) && cost > 0 && hasSubscription && (req.creditsRemaining ?? 0) < cost) {
    setCreditsHeader(res, req.creditsRemaining ?? 0);
    res.status(402).json({
      success: false,
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: `This operation requires ${cost} credits; you have ${req.creditsRemaining ?? 0}.`,
        creditsRequired: cost,
        creditsRemaining: req.creditsRemaining ?? 0,
      },
    });
    return;
  }
  const shouldDeduct = !bypassCredits(req) && cost > 0 && hasSubscription;

  // Sync tier: keep the low-latency direct call so the client gets an
  // immediate response (list/retrieve/approve and friends).
  if (classification.tier === 'sync') {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();

      // Deduct credits after a successful sync call.
      let balance = req.creditsRemaining ?? 0;
      if (shouldDeduct) {
        const result = await deductCredits(userId, cost, `chat.sync:${classification.jobType}`);
        if (result.ok) balance = result.balance_after;
      }
      setCreditsHeader(res, balance);

      res.json({
        mode: 'sync',
        classification: {
          tier: classification.tier,
          queue: classification.queue,
          jobType: classification.jobType,
        },
        creditsCharged: bypassCredits(req) ? 0 : cost,
        creditsRemaining: balance,
        data,
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'chat: sync proxy failed');
      res.status(502).json({ error: 'Failed to reach n8n webhook' });
    }
    return;
  }

  // Async tiers: enqueue onto BullMQ and return a job id. The worker in
  // n8n-worker.ts POSTs to the hub webhook in the background; progress
  // and completion events flow back via SSE + the jobs API.
  //
  // If REDIS_URL is not set (local dev without Redis), we fall back to a
  // direct proxy so the drawer still works — the queue layer is additive,
  // not a hard dependency.
  if (!process.env.REDIS_URL) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();

      let balance = req.creditsRemaining ?? 0;
      if (shouldDeduct) {
        const result = await deductCredits(userId, cost, `chat.sync-fallback:${classification.jobType}`);
        if (result.ok) balance = result.balance_after;
      }
      setCreditsHeader(res, balance);

      res.json({
        mode: 'sync-fallback',
        classification: {
          tier: classification.tier,
          queue: classification.queue,
          jobType: classification.jobType,
        },
        creditsCharged: bypassCredits(req) ? 0 : cost,
        creditsRemaining: balance,
        data,
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'chat: fallback proxy failed');
      res.status(502).json({ error: 'Failed to reach n8n webhook' });
    }
    return;
  }

  try {
    const queue = getNamedQueue<N8nWebhookJob>(classification.queue);
    const { bullJobId, trackerRowId } = await addTrackedJob<N8nWebhookJob>({
      queue,
      jobName: classification.jobType,
      data: {
        userId,
        jobType: classification.jobType,
        webhookUrl,
        body: {
          user_message_request: message,
          user_id: req.body.user_id,
        },
      },
      priority: classification.priority,
      jobTypeTag: classification.jobType,
    });

    // Deduct credits at enqueue time. The spec says "deduct on success" — we
    // interpret successful enqueue as the success boundary for async ops, since
    // the alternative (deduct after worker completes) would let users queue
    // unlimited free jobs while one is running. Refund happens on permanent
    // failure (handled by the worker's failure path — TODO S8-10 hardening).
    let balance = req.creditsRemaining ?? 0;
    if (!bypassCredits(req) && cost > 0) {
      const result = await deductCredits(userId, cost, `chat.async:${classification.jobType}`, bullJobId);
      if (result.ok) balance = result.balance_after;
    }
    setCreditsHeader(res, balance);

    res.json({
      mode: 'async',
      jobId: bullJobId,
      trackerRowId,
      status: 'queued',
      classification: {
        tier: classification.tier,
        queue: classification.queue,
        jobType: classification.jobType,
      },
      creditsCharged: bypassCredits(req) ? 0 : cost,
      creditsRemaining: balance,
    });
  } catch (error) {
    logger.error({ err: error, userId, queue: classification.queue }, 'chat: enqueue failed');
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});
