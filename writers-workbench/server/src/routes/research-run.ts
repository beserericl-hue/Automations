/**
 * Research a topic from the Research screens, not only by asking the chat.
 *
 *   POST /api/research/run   { topic, project_id? }
 *
 * The engine's research.run derives the questions, answers each from the web, writes the report and
 * saves it (linked to the project when one is given, so it shows on that project's Research tab).
 * Charged as `research`.
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

export const researchRunRouter = Router();
researchRunRouter.use(requireAuth);

const RunSchema = z.object({
  topic: z.string().trim().min(3).max(500),
  project_id: z.string().uuid().optional(),
});

researchRunRouter.post('/run', validateBody(RunSchema), async (req: Request, res: Response) => {
  const { topic, project_id } = req.body as z.infer<typeof RunSchema>;
  const userId = req.userId!;
  type Project = { id: string; title: string; genre_slug: string | null };
  let project: Project | null = null;
  if (project_id) {
    const { data } = await getSupabaseAdmin()
      .from('writing_projects_v2')
      .select('id, title, genre_slug')
      .eq('id', project_id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    project = data as unknown as Project;
  }
  const privileged = req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
  const hasSubscription = req.subscriptionTier !== null && req.subscriptionTier !== undefined;
  const cost = await getCreditCost('research');
  if (!privileged && cost > 0 && hasSubscription && (req.creditsRemaining ?? 0) < cost) {
    res.status(402).json({ success: false, error: { code: 'INSUFFICIENT_CREDITS', message: `This needs ${cost} credits.`, creditsRequired: cost } });
    return;
  }
  try {
    const job = await callEngineWriteTool('research', {
      op: 'run',
      // A project's research is filed under "<project title> — <topic>", which is how its Research
      // tab and the landing page's history section find it.
      topic: project ? `${project.title} — ${topic}` : topic,
      user_id: userId,
      ...(project ? { project_id: project.id, project_title: project.title, genre_slug: project.genre_slug ?? undefined } : {}),
      persist: true,
      async: true,
    });
    if (!privileged && cost > 0 && hasSubscription) await deductCredits(userId, cost, 'research.run:research');
    logger.info({ userId, projectId: project?.id, jobId: job.job_id }, 'research queued');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, projectId: project?.id }, 'research run failed');
    res.status(502).json({ success: false, error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' } });
  }
});
