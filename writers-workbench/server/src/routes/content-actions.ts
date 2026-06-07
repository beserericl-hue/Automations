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
import { callEngineWriteTool } from '../lib/engine-hub.js';
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
// =====================================================================
// S12-13 — Shared Report-Comment Surface
// =====================================================================
// Surfaces annotations from S12-11 (genre_eval) + S12-12 (drift_scan)
// pinned to spans in the chapter, with apply/dismiss/open actions. Single
// API shared by both report sources so future evidence-backed tools
// (rewrite_diff, citation_audit, etc.) can plug in without UI changes.

interface UnifiedAnnotation {
  id: string;
  source: 'genre_eval' | 'drift_scan';
  severity: 'high' | 'medium' | 'low' | 'info';
  message: string;
  evidence_quote: string | null;
  evidence_context: string | null;
  chapter_number: number | null;
  suggestion?: {
    action: 'replace' | 'note';
    target_text?: string; // exact text to replace
    replacement_text?: string;
  };
  dismissed: boolean;
  raw: unknown; // original report fragment for debugging
}

const ApplyAnnotationSchema = z.object({
  annotationId: z.string().min(1),
  source: z.enum(['genre_eval', 'drift_scan']),
  // Optional override of the replacement text — lets the user tweak the
  // suggestion before applying.
  replacementText: z.string().min(1).max(20000).optional(),
});

const DismissAnnotationSchema = z.object({
  annotationId: z.string().min(1),
  source: z.enum(['genre_eval', 'drift_scan']),
});

/**
 * Build the deterministic ID for an annotation so the same flag re-fetched
 * later collapses onto the same row in `metadata.dismissed_annotations`.
 */
function buildAnnotationId(source: string, chapterNumber: number | null, evidence: string, kind: string): string {
  const norm = (evidence || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${source}:${chapterNumber ?? 'x'}:${kind}:${norm}`;
}

/**
 * @openapi
 * /content/{id}/annotations:
 *   get:
 *     tags: [Content]
 *     summary: Unified annotations panel for a chapter (drift + genre eval)
 *     description: |
 *       Merges annotations from `metadata.genre_eval` (S12-11) and the
 *       project's `outline._character_drift_scan` (S12-12), filtered to the
 *       chapter's number. Anchors each annotation to its evidence quote so
 *       the client can pin it inline. Honours `metadata.dismissed_annotations`.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Annotations list }
 *       404: { description: Chapter not found }
 */
contentActionsRouter.get('/:id/annotations', async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }
  const { id } = req.params;
  try {
    const supabase = getSupabaseAdmin();
    const { data: chapter, error: chapterErr } = await supabase
      .from('published_content_v2')
      .select('id, project_id, chapter_number, content_text, metadata')
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single();
    if (chapterErr || !chapter) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
      return;
    }

    const meta = (chapter.metadata as Record<string, unknown> | null) || {};
    const dismissed = new Set<string>(
      Array.isArray(meta.dismissed_annotations) ? (meta.dismissed_annotations as string[]) : [],
    );
    const annotations: UnifiedAnnotation[] = [];

    // ---- Source 1: genre_eval (lives on the chapter's own metadata) ----
    const genre = (meta.genre_eval as Record<string, unknown> | undefined) || undefined;
    if (genre) {
      for (const stream of ['prose_adaptations', 'outline_adaptations', 'observations'] as const) {
        const items = Array.isArray(genre[stream]) ? (genre[stream] as Record<string, unknown>[]) : [];
        for (const it of items) {
          const evidence = (it.evidence as Record<string, unknown> | undefined) || {};
          const quote = (evidence.quote as string | undefined) || null;
          const context = (evidence.context as string | undefined) || null;
          const after = (it.after as string | undefined) || null;
          const editorNote = (it.editor_note as string | undefined) || null;
          const ruleDim = (it.rule_dimension as string | undefined) || stream;
          const score = (it.score as number | undefined) ?? null;
          const aid = buildAnnotationId('genre_eval', chapter.chapter_number, quote || ruleDim, stream);
          annotations.push({
            id: aid,
            source: 'genre_eval',
            severity: score != null && score < 3 ? 'high' : score != null && score < 5 ? 'medium' : 'low',
            message: editorNote || ruleDim,
            evidence_quote: quote,
            evidence_context: context,
            chapter_number: chapter.chapter_number,
            suggestion:
              quote && after
                ? { action: 'replace', target_text: quote, replacement_text: after }
                : { action: 'note' },
            dismissed: dismissed.has(aid),
            raw: it,
          });
        }
      }
    }

    // ---- Source 2: drift_scan (lives on project outline) ----
    if (chapter.project_id) {
      const { data: project } = await supabase
        .from('writing_projects_v2')
        .select('outline')
        .eq('id', chapter.project_id)
        .single();
      const outline = (project?.outline as Record<string, unknown> | null) || {};
      const scan = outline._character_drift_scan as Record<string, unknown> | undefined;
      if (scan) {
        const characters = Array.isArray(scan.characters) ? (scan.characters as Record<string, unknown>[]) : [];
        for (const c of characters) {
          const flags = Array.isArray(c.drift_flags) ? (c.drift_flags as Record<string, unknown>[]) : [];
          for (const f of flags) {
            if (f.chapter_number !== chapter.chapter_number) continue;
            const variant = (f.variant as string | undefined) || '';
            const ctx = (f.context as string | undefined) || '';
            const flagType = (f.type as string | undefined) || 'drift';
            const sev = (f.severity as string | undefined) || 'medium';
            const aid = buildAnnotationId('drift_scan', chapter.chapter_number, variant, flagType);
            const canonical = (c.name_format as string | undefined) || (c.name as string | undefined) || '';
            // For reverse_order_drift: replacement preserves first name, swaps surname.
            // "Rodriguez, Elena" → "Morales, Elena" using canonical surname.
            let replacementText: string | undefined;
            if (flagType === 'reverse_order_drift' && canonical) {
              const canonToks = canonical.split(/\s+/);
              const firstName = canonToks[0] || '';
              const surname = canonToks.length > 1 ? canonToks[canonToks.length - 1] : '';
              if (firstName && surname && variant.includes(',')) {
                replacementText = `${surname}, ${firstName}`;
              }
            }
            annotations.push({
              id: aid,
              source: 'drift_scan',
              severity: sev === 'high' ? 'high' : sev === 'medium' ? 'medium' : 'low',
              message: `Character drift: "${variant}" — ${canonical} canonical`,
              evidence_quote: variant,
              evidence_context: ctx,
              chapter_number: chapter.chapter_number,
              suggestion: replacementText
                ? { action: 'replace', target_text: variant, replacement_text: replacementText }
                : { action: 'note' },
              dismissed: dismissed.has(aid),
              raw: f,
            });
          }
        }
      }
    }

    res.json({
      success: true,
      annotations,
      counts: {
        total: annotations.length,
        active: annotations.filter((a) => !a.dismissed).length,
        by_source: {
          genre_eval: annotations.filter((a) => a.source === 'genre_eval').length,
          drift_scan: annotations.filter((a) => a.source === 'drift_scan').length,
        },
      },
    });
  } catch (err) {
    logger.error({ err, userId, contentId: id }, 'content-actions: annotations GET failed');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
    });
  }
});

/**
 * @openapi
 * /content/{id}/annotations/apply:
 *   post:
 *     tags: [Content]
 *     summary: Apply an annotation's suggested fix to the chapter text
 *     description: |
 *       Performs a precise span replacement (no LLM rewrite). Snapshots the
 *       prior chapter text into `content_versions_v2` before mutating, so
 *       Apply is reversible via the existing version-history UI.
 *       Returns 422 if the target text can't be found in the current chapter
 *       (the chapter has been edited since the annotation was anchored).
 */
contentActionsRouter.post(
  '/:id/annotations/apply',
  validateBody(ApplyAnnotationSchema),
  async (req: Request, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    const { id } = req.params;
    const { annotationId, source, replacementText } = req.body as z.infer<typeof ApplyAnnotationSchema>;

    try {
      const supabase = getSupabaseAdmin();
      const { data: chapter, error } = await supabase
        .from('published_content_v2')
        .select('id, project_id, chapter_number, title, content_text, metadata')
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .single();
      if (error || !chapter) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
        return;
      }

      // Re-fetch annotations for this chapter via the same builder so we
      // know the exact target_text/replacement_text. Calling the GET handler
      // logic inline avoids HTTP round-trip.
      const meta = (chapter.metadata as Record<string, unknown>) || {};
      const dismissed = new Set<string>(Array.isArray(meta.dismissed_annotations) ? (meta.dismissed_annotations as string[]) : []);
      let target: { target_text: string; replacement_text: string } | null = null;

      if (source === 'genre_eval') {
        const genre = (meta.genre_eval as Record<string, unknown> | undefined) || {};
        for (const stream of ['prose_adaptations', 'outline_adaptations', 'observations'] as const) {
          const items = Array.isArray(genre[stream]) ? (genre[stream] as Record<string, unknown>[]) : [];
          for (const it of items) {
            const evidence = (it.evidence as Record<string, unknown> | undefined) || {};
            const quote = (evidence.quote as string | undefined) || '';
            const ruleDim = (it.rule_dimension as string | undefined) || stream;
            const aid = buildAnnotationId('genre_eval', chapter.chapter_number, quote || ruleDim, stream);
            if (aid === annotationId) {
              const after = (it.after as string | undefined) || '';
              if (quote && (replacementText || after)) {
                target = { target_text: quote, replacement_text: replacementText || after };
              }
              break;
            }
          }
          if (target) break;
        }
      } else if (source === 'drift_scan' && chapter.project_id) {
        const { data: project } = await supabase
          .from('writing_projects_v2')
          .select('outline')
          .eq('id', chapter.project_id)
          .single();
        const outline = (project?.outline as Record<string, unknown> | null) || {};
        const scan = outline._character_drift_scan as Record<string, unknown> | undefined;
        const characters = Array.isArray(scan?.characters) ? (scan.characters as Record<string, unknown>[]) : [];
        outer: for (const c of characters) {
          const flags = Array.isArray(c.drift_flags) ? (c.drift_flags as Record<string, unknown>[]) : [];
          for (const f of flags) {
            if (f.chapter_number !== chapter.chapter_number) continue;
            const variant = (f.variant as string | undefined) || '';
            const flagType = (f.type as string | undefined) || 'drift';
            const aid = buildAnnotationId('drift_scan', chapter.chapter_number, variant, flagType);
            if (aid === annotationId) {
              const canonical = (c.name_format as string | undefined) || (c.name as string | undefined) || '';
              const canonToks = canonical.split(/\s+/);
              const firstName = canonToks[0] || '';
              const surname = canonToks.length > 1 ? canonToks[canonToks.length - 1] : '';
              if (replacementText) {
                target = { target_text: variant, replacement_text: replacementText };
              } else if (flagType === 'reverse_order_drift' && surname && variant.includes(',')) {
                target = { target_text: variant, replacement_text: `${surname}, ${firstName}` };
              } else if (canonical) {
                target = { target_text: variant, replacement_text: canonical };
              }
              break outer;
            }
          }
        }
      }

      if (!target) {
        res.status(404).json({ success: false, error: { code: 'ANNOTATION_NOT_FOUND' } });
        return;
      }

      const text = chapter.content_text || '';
      if (!text.includes(target.target_text)) {
        res.status(422).json({
          success: false,
          error: {
            code: 'STALE_ANNOTATION',
            message: 'Target text no longer present — chapter was edited since the report was generated.',
          },
        });
        return;
      }
      // Snapshot prior text into content_versions_v2 before mutating.
      // version_number is computed as the next integer for this chapter.
      const { data: lastVersion } = await supabase
        .from('content_versions_v2')
        .select('version_number')
        .eq('content_id', chapter.id)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextVersion = ((lastVersion?.version_number as number | undefined) ?? 0) + 1;
      await supabase.from('content_versions_v2').insert({
        content_id: chapter.id,
        user_id: userId,
        version_number: nextVersion,
        content_text: text,
        changed_by: 'annotation_apply',
        change_note: `annotation_apply:${source}:${annotationId.slice(0, 60)}`,
      });

      // Replace ALL exact-match occurrences of the target so an "Elena Rodriguez"
      // case-file table that drifts twice in the same chapter is fully fixed.
      const newText = text.split(target.target_text).join(target.replacement_text);

      // Mark the annotation dismissed so the UI doesn't re-surface it after apply.
      dismissed.add(annotationId);
      const newMetadata = { ...meta, dismissed_annotations: [...dismissed] };

      await supabase
        .from('published_content_v2')
        .update({ content_text: newText, metadata: newMetadata })
        .eq('id', chapter.id)
        .eq('user_id', userId);

      logger.info(
        { userId, contentId: id, annotationId, source, replacements: text.split(target.target_text).length - 1 },
        'content-actions: annotation applied',
      );

      res.json({
        success: true,
        applied: {
          annotationId,
          source,
          replacements: text.split(target.target_text).length - 1,
          target_text: target.target_text,
          replacement_text: target.replacement_text,
        },
      });
    } catch (err) {
      logger.error({ err, userId, contentId: id }, 'content-actions: annotation apply failed');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  },
);

/**
 * @openapi
 * /content/{id}/annotations/dismiss:
 *   post:
 *     tags: [Content]
 *     summary: Dismiss an annotation without applying its fix
 */
contentActionsRouter.post(
  '/:id/annotations/dismiss',
  validateBody(DismissAnnotationSchema),
  async (req: Request, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    const { id } = req.params;
    const { annotationId } = req.body as z.infer<typeof DismissAnnotationSchema>;
    try {
      const supabase = getSupabaseAdmin();
      const { data: chapter, error } = await supabase
        .from('published_content_v2')
        .select('id, metadata')
        .eq('id', id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .single();
      if (error || !chapter) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
        return;
      }
      const meta = (chapter.metadata as Record<string, unknown>) || {};
      const dismissed = new Set<string>(
        Array.isArray(meta.dismissed_annotations) ? (meta.dismissed_annotations as string[]) : [],
      );
      dismissed.add(annotationId);
      const newMetadata = { ...meta, dismissed_annotations: [...dismissed] };
      await supabase
        .from('published_content_v2')
        .update({ metadata: newMetadata })
        .eq('id', chapter.id)
        .eq('user_id', userId);
      res.json({ success: true, dismissed: annotationId });
    } catch (err) {
      logger.error({ err, userId, contentId: id }, 'content-actions: annotation dismiss failed');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  },
);

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
      //
      // CRITICAL: avoid the words "QA" / "Q/A" / "consistency report" —
      // the hub's preprocess_message has a QA-override regex that
      // prepends "[TOOL OVERRIDE — qa_chapter]" whenever it sees those,
      // which short-circuits to the direct QA path and skips the rewrite
      // tool entirely. We still pass use_qa_report as a parameter name
      // (the rewrite tool reads it), we just phrase it in a way that
      // doesn't match the override regex.
      const forceCitationsFragment =
        body.citation_mode === 'inline'
          ? ' force_citations_in_prose=true.'
          : body.citation_mode === 'invisible'
            ? ' force_citations_in_prose=false.'
            : '';
      const styleFragment = body.style_directives ? ` style_directives="${body.style_directives}".` : '';
      const qaFragment = body.use_qa_report ? ' use_qa_report=true.' : '';

      // Title stripped of surrounding quotes / punctuation so Gemini's
      // extraction of the quoted title doesn't bleed into adjacent
      // params (the same class of bug fixed in PR #32).
      const safeTitle = project.title.replace(/"/g, '').trim();

      const preFormedPrompt =
        `Invoke rewrite_chapter_with_research. project_title=${safeTitle}. ` +
        `chapter_number=${chapter.chapter_number}. ` +
        `research_focus=${body.research_focus}.${qaFragment}${styleFragment}${forceCitationsFragment} ` +
        `This is a direct rewrite request from the UI. Do not call any other tool.`;

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

/**
 * POST /api/content/:id/repair — CR-008/009: run the ENGINE drift-correction (chapter.repair) on a
 * chapter. Repair re-detects drift vs the outline/roster, corrects it (+ weaves focused research +
 * line-edits), then re-scans so the "Drift detected" badge clears. Engine-only (not gated on
 * HUB_BACKEND). Returns an engine job_id the client polls via /api/jobs/engine/:id.
 */
contentActionsRouter.post('/:id/repair', async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }
  const id = String(req.params.id);
  try {
    const supabase = getSupabaseAdmin();
    const { data: chapter, error } = await supabase
      .from('published_content_v2')
      .select('id, user_id, chapter_number, content_type, project_id')
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !chapter) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chapter not found' } });
      return;
    }
    if (chapter.content_type !== 'chapter') {
      res.status(400).json({ success: false, error: { code: 'NOT_A_CHAPTER', message: 'Repair targets chapters' } });
      return;
    }
    const job = await callEngineWriteTool('chapter', {
      op: 'repair',
      project_id: chapter.project_id,
      chapter_number: chapter.chapter_number,
      user_id: userId,
      persist: true,
      async: true,
    });
    logger.info({ userId, contentId: id, jobId: job.job_id }, 'content-actions: engine repair queued');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, userId, contentId: id }, 'content-actions: repair failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});
