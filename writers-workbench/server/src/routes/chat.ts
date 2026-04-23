import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { ChatProxySchema } from '../schemas.js';
import { logger } from '../lib/logger.js';
import { classifyJob } from '../lib/jobs/classifier.js';
import { getNamedQueue } from '../lib/queue.js';
import { addTrackedJob } from '../lib/jobs/job-tracker.js';
import type { N8nWebhookJob } from '../lib/jobs/types.js';

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
chatRouter.post('/proxy', requireAuth, validateBody(ChatProxySchema), async (req, res) => {
  const webhookUrl = resolveWebhookUrl();

  if (!webhookUrl) {
    res.status(500).json({ error: 'N8N webhook URL not configured' });
    return;
  }

  const message = req.body.user_message_request as string;
  const classification = classifyJob(message);
  const userId = req.userId!;

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
      res.json({
        mode: 'sync',
        classification: {
          tier: classification.tier,
          queue: classification.queue,
          jobType: classification.jobType,
        },
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
      res.json({
        mode: 'sync-fallback',
        classification: {
          tier: classification.tier,
          queue: classification.queue,
          jobType: classification.jobType,
        },
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
    });
  } catch (error) {
    logger.error({ err: error, userId, queue: classification.queue }, 'chat: enqueue failed');
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});
