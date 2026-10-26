/**
 * Social posts from the content page, not only by asking the chat (CR-010).
 *
 *   POST /api/content/:id/social   { platforms?: ("twitter"|"linkedin"|"instagram"|"facebook")[] }
 *
 * Hands the piece's own title and text to the engine's media.social-posts, which writes one post per
 * platform, keeps each under that platform's limit, and saves them to social_posts_v2 against the
 * piece's project and the piece itself (`source_content_id`). Charged as a social repurpose.
 *
 * Through the chat, the router had to work out the piece from a sentence and was given only its
 * title, so the posts were written from a title and a guess.
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

export const socialGenerateRouter = Router();
socialGenerateRouter.use(requireAuth);

export const SOCIAL_PLATFORMS = ['twitter', 'linkedin', 'instagram', 'facebook'] as const;

const GenerateSchema = z.object({
  platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1).max(4).optional(),
});

/** How much of the piece the post writer reads. Enough for a chapter's opening and its turn. */
export const SOCIAL_SOURCE_CHARS = 6000;

socialGenerateRouter.post('/:id/social', validateBody(GenerateSchema), async (req: Request, res: Response) => {
  const userId = req.userId!;
  const platforms = (req.body as z.infer<typeof GenerateSchema>).platforms ?? ['twitter', 'linkedin'];
  const { data: piece } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('id, title, content_text, content_type, project_id')
    .eq('id', String(req.params.id))
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!piece) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Content not found' } });
    return;
  }
  const text = String(piece.content_text ?? '').trim();
  if (text.split(/\s+/).length < 30) {
    res.status(409).json({ success: false, error: { code: 'TOO_SHORT', message: 'There is not enough text here to write posts from yet.' } });
    return;
  }
  const privileged = req.effectiveRole === 'superuser' || req.effectiveRole === 'admin';
  const hasSubscription = req.subscriptionTier !== null && req.subscriptionTier !== undefined;
  const cost = await getCreditCost('social_repurpose');
  if (!privileged && cost > 0 && hasSubscription && (req.creditsRemaining ?? 0) < cost) {
    res.status(402).json({ success: false, error: { code: 'INSUFFICIENT_CREDITS', message: `This needs ${cost} credits.`, creditsRequired: cost } });
    return;
  }
  try {
    const job = await callEngineWriteTool('media', {
      op: 'social-posts',
      summary: `${piece.title ?? ''}\n\n${text.slice(0, SOCIAL_SOURCE_CHARS)}`,
      title: piece.title ?? '',
      platforms,
      user_id: userId,
      source_content_id: piece.id,
      ...(piece.project_id ? { project_id: piece.project_id } : {}),
      persist: true,
      async: true,
    });
    if (!privileged && cost > 0 && hasSubscription) await deductCredits(userId, cost, 'content.social:social_repurpose');
    logger.info({ userId, contentId: piece.id, platforms, jobId: job.job_id }, 'social posts queued');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, contentId: piece.id }, 'social posts failed');
    res.status(502).json({ success: false, error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' } });
  }
});
