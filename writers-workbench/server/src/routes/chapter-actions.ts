/**
 * The project page's chapter buttons — Outline, Write, Rewrite — sent to the engine by id.
 *
 *   POST /api/projects/:projectId/chapters/:chapterNumber/engine   { action, notes? }
 *
 * WHY NOT THE CHAT ROUTER. These buttons used to compose a sentence ("write Chapter 4 of The
 * Ossuary. ADDITIONAL INSTRUCTIONS: …") and send it through /api/chat/proxy, where a model had to
 * work out the project and chapter again from the words. Three things went wrong that way: the
 * proxy's schema dropped the `project_id` it was given, so the project came from the title alone; the
 * author's instructions were not among the fields the router extracts, so they never reached the
 * writer; and "rewrite" could land on the rewrite op, which needs the chapter text and saves nothing.
 * Here the ids are the ones the button already has, and the instructions travel as `author_notes`.
 *
 * Credits: an outline is charged as a chapter brainstorm and a write or rewrite as a chapter write
 * (see JOB_TYPE).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool } from '../lib/engine-hub.js';
import { getCreditCost } from '../services/credit-costs.js';
import { deductCredits } from '../services/credits.js';
import { logger } from '../lib/logger.js';

export const chapterActionsRouter = Router();
chapterActionsRouter.use(requireAuth);

const ActionSchema = z.object({
  action: z.enum(['outline', 'write', 'rewrite']),
  notes: z.string().trim().max(4000).optional(),
});

/** outline -> plan; write and rewrite both write the chapter again from its outline. */
const OP: Record<z.infer<typeof ActionSchema>['action'], 'plan' | 'write'> = {
  outline: 'plan',
  write: 'write',
  rewrite: 'write',
};

function chapterLabel(n: number): string {
  return n === 0 ? 'the Prologue' : `Chapter ${n}`;
}

/**
 * What each action is charged as. Named outright: through the chat proxy the same buttons were
 * priced by classifying their sentence, which charged an outline as a story brainstorm and a
 * rewrite (a full chapter write) as free chat.
 */
const JOB_TYPE: Record<z.infer<typeof ActionSchema>['action'], string> = {
  outline: 'brainstorm_chapter',
  write: 'write_chapter',
  rewrite: 'write_chapter',
};

function bypassCredits(req: Request): boolean {
  return req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
}

chapterActionsRouter.post(
  '/:projectId/chapters/:chapterNumber/engine',
  validateBody(ActionSchema),
  async (req: Request, res: Response) => {
    const { action, notes } = req.body as z.infer<typeof ActionSchema>;
    const chapterNumber = Number(req.params.chapterNumber);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 0 || chapterNumber > 500) {
      res.status(400).json({ success: false, error: { code: 'BAD_CHAPTER', message: 'Not a chapter number' } });
      return;
    }
    const userId = req.userId!;
    const { data: project } = await getSupabaseAdmin()
      .from('writing_projects_v2')
      .select('id, title, outline')
      .eq('id', String(req.params.projectId))
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!project) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    const chapters = ((project.outline as { chapters?: { chapter_number?: number }[] } | null)?.chapters ?? []).map((c) =>
      Number(c.chapter_number),
    );
    if (chapters.length && !chapters.includes(chapterNumber)) {
      res.status(400).json({ success: false, error: { code: 'NO_SUCH_CHAPTER', message: `${chapterLabel(chapterNumber)} is not in the outline` } });
      return;
    }

    const jobType = JOB_TYPE[action];
    const cost = await getCreditCost(jobType);
    const hasSubscription = req.subscriptionTier !== null && req.subscriptionTier !== undefined;
    if (!bypassCredits(req) && cost > 0 && hasSubscription && (req.creditsRemaining ?? 0) < cost) {
      res.status(402).json({
        success: false,
        error: { code: 'INSUFFICIENT_CREDITS', message: `This needs ${cost} credits; you have ${req.creditsRemaining ?? 0}.`, creditsRequired: cost },
      });
      return;
    }

    try {
      const job = await callEngineWriteTool('chapter', {
        op: OP[action],
        project_id: project.id,
        project_title: project.title,
        chapter_number: chapterNumber,
        user_id: userId,
        ...(notes ? { author_notes: notes } : {}),
        persist: true,
        async: true,
      });
      let remaining = req.creditsRemaining ?? 0;
      if (!bypassCredits(req) && cost > 0 && hasSubscription) {
        const r = await deductCredits(userId, cost, `chapter.${action}:${jobType}`);
        if (r.ok) remaining = r.balance_after;
      }
      res.setHeader('X-Credits-Remaining', String(remaining));
      logger.info({ userId, projectId: project.id, chapterNumber, action, jobId: job.job_id }, 'chapter action queued');
      res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued', jobType });
    } catch (err) {
      logger.error({ err, projectId: project.id, chapterNumber, action }, 'chapter action failed');
      res.status(502).json({ success: false, error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' } });
    }
  },
);
