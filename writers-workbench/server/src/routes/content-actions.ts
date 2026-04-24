/**
 * POST /api/content/:id/rewrite-with-research — S12-10 UI MVP.
 *
 * Enqueues a heavy-ops BullMQ job that asks the DEV/PROD hub to invoke
 * `rewrite_chapter_with_research` (S12-6) for the given chapter. We don't
 * call the tool sub-workflow directly because the hub is the entry point
 * for all n8n work — it owns routing, user context threading, and
 * response ack/respond wiring.
 *
 * The route itself is thin: validate, craft a pre-formed prompt that
 * forces Gemini to pick the tool, enqueue, return job id. Progress
 * surfaces through the existing SSE `job-status` channel.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { getNamedQueue } from '../lib/queue.js';
import { addTrackedJob } from '../lib/jobs/job-tracker.js';
import type { N8nWebhookJob } from '../lib/jobs/types.js';

export const contentActionsRouter = Router();

contentActionsRouter.use(requireAuth);

const RewriteWithResearchSchema = z.object({
  research_focus: z.string().min(10, 'research_focus must be at least 10 characters').max(2000),
  use_qa_report: z.boolean().optional().default(false),
  style_directives: z.string().max(2000).optional(),
  // 'auto' = derive from project_type (fiction = invisible, non_fiction = inline)
  citation_mode: z.enum(['auto', 'invisible', 'inline']).optional().default('auto'),
});

function resolveHubWebhookUrl(): string {
  if (process.env.N8N_HUB_WEBHOOK_URL) return process.env.N8N_HUB_WEBHOOK_URL;
  if (process.env.N8N_API_URL) return `${process.env.N8N_API_URL}/webhook/author_request_v2`;
  return '';
}

/**
 * @openapi
 * /content/{id}/rewrite-with-research:
 *   post:
 *     tags: [Content]
 *     summary: Enqueue a credibility-first chapter rewrite job
 *     description: |
 *       Kicks off the S12-6 `rewrite_chapter_with_research` flow. The route
 *       looks up the chapter by id (verifies it belongs to the requesting
 *       user), resolves the project title + chapter_number, forms a prompt
 *       that forces the hub to call the rewrite tool with the supplied
 *       parameters, and enqueues a heavy-ops BullMQ job. Client watches the
 *       existing `job-status` SSE channel for progress.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [research_focus]
 *             properties:
 *               research_focus: { type: string, minLength: 10 }
 *               use_qa_report: { type: boolean, default: false }
 *               style_directives: { type: string }
 *               citation_mode:
 *                 type: string
 *                 enum: [auto, invisible, inline]
 *                 default: auto
 *     responses:
 *       202:
 *         description: Job queued
 *       400:
 *         description: Validation error / chapter not found
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Hub webhook not configured
 */
contentActionsRouter.post(
  '/:id/rewrite-with-research',
  validateBody(RewriteWithResearchSchema),
  async (req: Request, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }

    const webhookUrl = resolveHubWebhookUrl();
    if (!webhookUrl) {
      res.status(503).json({
        success: false,
        error: { code: 'NOT_CONFIGURED', message: 'N8N_HUB_WEBHOOK_URL not set' },
      });
      return;
    }

    const { id } = req.params;
    const body = req.body as z.infer<typeof RewriteWithResearchSchema>;

    try {
      // Resolve the chapter + its project so the hub prompt carries both.
      const supabase = getSupabaseAdmin();
      const { data: chapter, error: chapterErr } = await supabase
        .from('published_content_v2')
        .select('id, user_id, chapter_number, content_type, project_id')
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .single();

      if (chapterErr || !chapter) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Chapter not found or not yours' },
        });
        return;
      }
      if (chapter.content_type !== 'chapter') {
        res.status(400).json({
          success: false,
          error: { code: 'NOT_A_CHAPTER', message: 'This endpoint only rewrites chapters' },
        });
        return;
      }

      const { data: project, error: projectErr } = await supabase
        .from('writing_projects_v2')
        .select('title, project_type')
        .eq('id', chapter.project_id)
        .single();

      if (projectErr || !project) {
        res.status(400).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Parent project missing' },
        });
        return;
      }

      // Build the hub prompt. Explicit tool + parameters so Gemini has a
      // deterministic routing decision — no prose creativity required on
      // the LLM's part.
      const forceCitationsFragment =
        body.citation_mode === 'inline'
          ? ' Force inline citations in prose (force_citations_in_prose=true).'
          : body.citation_mode === 'invisible'
            ? ' Force invisible citations (force_citations_in_prose=false).'
            : '';
      const styleFragment = body.style_directives ? ` Style directives: ${body.style_directives}.` : '';
      const qaFragment = body.use_qa_report ? ' Use the chapter\'s last QA report (use_qa_report=true).' : '';

      const preFormedPrompt =
        `Call the rewrite_chapter_with_research tool to rewrite chapter ${chapter.chapter_number} ` +
        `of "${project.title}". research_focus: ${body.research_focus}.${qaFragment}${styleFragment}${forceCitationsFragment} ` +
        `Do not call any other tool; this is a direct rewrite request from the UI.`;

      const queue = getNamedQueue<N8nWebhookJob>('heavy-ops');
      const { bullJobId, trackerRowId } = await addTrackedJob<N8nWebhookJob>({
        queue,
        jobName: 'rewrite_chapter_with_research',
        data: {
          userId,
          jobType: 'rewrite_chapter_with_research',
          webhookUrl,
          body: {
            user_message_request: preFormedPrompt,
            user_id: userId,
            _source: 'ui:rewrite-with-research',
            _content_id: id,
          },
        },
        priority: 5,
        jobTypeTag: 'rewrite_chapter_with_research',
      });

      logger.info(
        { userId, contentId: id, bullJobId, trackerRowId },
        'content-actions: rewrite-with-research enqueued',
      );
      res.status(202).json({
        success: true,
        jobId: bullJobId,
        trackerRowId,
        status: 'queued',
        queue: 'heavy-ops',
      });
    } catch (err) {
      logger.error({ err, userId, contentId: id }, 'content-actions: rewrite-with-research failed');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  },
);
