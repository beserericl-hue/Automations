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

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool, hubBackend } from '../lib/engine-hub.js';
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
  source: 'genre_eval' | 'drift_scan' | 'craft_qa';
  severity: 'high' | 'medium' | 'low' | 'info';
  message: string;
  evidence_quote: string | null;
  evidence_context: string | null;
  chapter_number: number | null;
  suggestion?: {
    action: 'replace' | 'note';
    target_text?: string; // exact text to replace
    replacement_text?: string;
    // How much prose this gains or loses, in characters. Shown at the point of decision because
    // the failure mode every automated repair attempt hit was prose quietly disappearing: six
    // whole-chapter revisions returned 48-80% of the original, and one repair cut a chapter from
    // 7,000 words to 2,800. A per-span accept is bounded and reversible, but the author should
    // still be told when accepting means deleting two thirds of a passage.
    delta_chars?: number;
  };
  dismissed: boolean;
  /** The passage it was about has been rewritten since the report: answered, not active. */
  resolved?: boolean;
  raw: unknown; // original report fragment for debugging
}

const ApplyAnnotationSchema = z.object({
  annotationId: z.string().min(1),
  source: z.enum(['genre_eval', 'drift_scan', 'craft_qa']),
  // Optional override of the replacement text — lets the user tweak the
  // suggestion before applying.
  replacementText: z.string().min(1).max(20000).optional(),
});

const DismissAnnotationSchema = z.object({
  annotationId: z.string().min(1),
  source: z.enum(['genre_eval', 'drift_scan', 'craft_qa']),
});

// Continuity defects are real defects and rare (0-4 chapters in 96 on a full book run). Craft
// defects — pacing, flat paragraphs, prose clarity — are frequent (51 and 39 of 96) and are
// editorial judgement, not breakage, so they must not shout at the same volume or the panel
// becomes noise and the rare real defect gets lost in it.
const CRAFT_DIMENSION_SEVERITY: Record<string, UnifiedAnnotation['severity']> = {
  character_consistency: 'high',
  character_follows_guide: 'high',
  outline_follows_guide: 'high',
  period_language_ok: 'high',
  dialogue_follows_guide: 'medium',
  prose_transparent: 'medium',
  no_boring_paragraphs: 'low',
  story_turn_density: 'low',
};

const CRAFT_DIMENSION_LABELS: Record<string, string> = {
  character_consistency: 'Character consistency',
  character_follows_guide: 'Character craft',
  outline_follows_guide: 'Follows the outline',
  period_language_ok: 'Period language',
  dialogue_follows_guide: 'Dialogue',
  prose_transparent: 'Prose clarity',
  no_boring_paragraphs: 'Flat paragraph',
  story_turn_density: 'Pacing — no story turn',
};

/**
 * The words of a chapter or quote, without markup: tags gone, the common entities decoded, markdown
 * emphasis dropped, whitespace collapsed. A chapter is plain text until the editor saves it, and HTML
 * after; a quote taken from one must still be recognised in the other.
 */
export function plainText(s: string): string {
  return s
    // A block boundary is a word break; an inline tag (<em>) sits inside a word as often as not.
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|blockquote|br|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the craft-Q/A annotations for a chapter from `metadata.craft_findings`.
 *
 * Shared by the GET and the apply handler so a finding can never be listed with one target span and
 * applied with another. The engine has already verified each quote against the chapter text
 * (`anchor_findings`), and this drops any whose span is no longer present — the chapter may have
 * been edited since the report ran, and offering an Apply that 422s on click is the failure the
 * drift source already learned to avoid.
 */
export function buildCraftAnnotations(
  meta: Record<string, unknown>,
  chapterNumber: number | null,
  chapterText: string,
  dismissed: Set<string>,
): UnifiedAnnotation[] {
  const block = (meta.craft_findings as Record<string, unknown> | undefined) || undefined;
  const findings = Array.isArray(block?.findings) ? (block.findings as Record<string, unknown>[]) : [];
  const out: UnifiedAnnotation[] = [];
  for (const f of findings) {
    const dimension = (f.dimension as string | undefined) || 'craft';
    const quote = (f.quote as string | undefined) || null;
    const replacement = (f.replacement as string | undefined) || null;
    const problem = (f.problem as string | undefined) || '';
    const fix = (f.fix as string | undefined) || '';
    // The engine stores a quote only after finding it in the chapter (`anchor_findings`), so a quote
    // that is no longer there means the passage has been rewritten since — by Apply, the Humanizer
    // or the author's own hand. That finding is answered: it is reported as fixed, with no one-click
    // fix (its target is gone) and no place among the active findings.
    const anchored = quote && chapterText.includes(quote) ? quote : null;
    // "Still there" is judged on the words, not the bytes: once the editor saves, the chapter is HTML,
    // and an italic phrase or a paragraph break inside the quote would otherwise read as a rewrite.
    const present = Boolean(anchored) || Boolean(quote && plainText(chapterText).includes(plainText(quote)));
    const resolved = Boolean(quote) && !present;
    const label = CRAFT_DIMENSION_LABELS[dimension] || dimension;
    // Keyed on the quote whether or not it is still there, so the finding keeps one id as it moves
    // from open to fixed.
    const aid = buildAnnotationId('craft_qa', chapterNumber, quote || `${dimension}:${problem}`, dimension);
    out.push({
      id: aid,
      source: 'craft_qa',
      severity: CRAFT_DIMENSION_SEVERITY[dimension] || 'low',
      message: problem ? `${label}: ${problem}` : label,
      // Still shown (and findable in the editor, which matches loosely) when only the markup moved;
      // the one-click replace below still needs the exact span.
      evidence_quote: present ? quote : null,
      evidence_context: fix || null,
      chapter_number: chapterNumber,
      suggestion:
        anchored && replacement
          ? {
              action: 'replace',
              target_text: anchored,
              replacement_text: replacement,
              delta_chars: replacement.length - anchored.length,
            }
          : { action: 'note' },
      dismissed: dismissed.has(aid),
      ...(resolved ? { resolved: true } : {}),
      raw: f,
    });
  }
  return out;
}

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
          const chapterText = chapter.content_text || '';
          for (const f of flags) {
            if (f.chapter_number !== chapter.chapter_number) continue;
            const variant = (f.variant as string | undefined) || '';
            // Skip STALE drift flags whose drifted spelling is no longer in the chapter (already
            // fixed / text edited since the scan ran). Surfacing them shows an "Apply Fix" that
            // 422s on click — a bad look, especially in a demo. A resolved finding shouldn't appear.
            if (variant && !chapterText.includes(variant)) continue;
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
            // General name-variant renames (e.g. engine QA: "Meara" → "Mara") carry an explicit
            // `replacement` on the flag, so the panel offers a one-click Apply that swaps the span.
            if (!replacementText && typeof f.replacement === 'string' && f.replacement) {
              replacementText = f.replacement;
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

    // ---- Source 3: craft_qa (the Q/A findings, pinned to their verified spans) ----
    annotations.push(
      ...buildCraftAnnotations(meta, chapter.chapter_number, chapter.content_text || '', dismissed),
    );

    res.json({
      success: true,
      annotations,
      counts: {
        total: annotations.length,
        active: annotations.filter((a) => !a.dismissed && !a.resolved).length,
        by_source: {
          genre_eval: annotations.filter((a) => a.source === 'genre_eval').length,
          drift_scan: annotations.filter((a) => a.source === 'drift_scan').length,
          craft_qa: annotations.filter((a) => a.source === 'craft_qa').length,
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
      } else if (source === 'craft_qa') {
        // Rebuilt through the same function the GET uses, so the span that is applied is by
        // construction the span that was shown.
        const built = buildCraftAnnotations(meta, chapter.chapter_number, chapter.content_text || '', dismissed);
        const hit = built.find((a) => a.id === annotationId);
        const sug = hit?.suggestion;
        if (sug?.action === 'replace' && sug.target_text) {
          const replacement = replacementText || sug.replacement_text;
          if (replacement) target = { target_text: sug.target_text, replacement_text: replacement };
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

      // Resolve citation_mode 'auto' from the project type (fiction → invisible grounding,
      // non-fiction → inline footnotes) — both the engine and n8n paths honour the resolved value.
      const isNonFiction = ['non_fiction', 'nonfiction'].includes(
        String(project.project_type || 'fiction').toLowerCase(),
      );
      const resolvedCitationMode =
        body.citation_mode === 'auto' ? (isNonFiction ? 'inline' : 'invisible') : body.citation_mode;

      // B1 (CR-010): when HUB_BACKEND=engine, route to the engine's chapter.repair op — its research-
      // weave path re-detects drift, fetches focused research bound to the author's research_focus,
      // weaves it in (invisible for fiction / inline footnotes for non-fiction), applies the style
      // directives, line-edits, and re-persists. Returns an engine job_id the existing
      // useEngineJobQueue poller (/api/jobs/engine/:id) already understands. No n8n webhook involved.
      if (hubBackend() === 'engine') {
        const job = await callEngineWriteTool('chapter', {
          op: 'repair',
          project_id: chapter.project_id,
          chapter_number: chapter.chapter_number,
          user_id: userId,
          research_focus: body.research_focus,
          style_directives: body.style_directives || '',
          citation_mode: resolvedCitationMode,
          use_qa_report: body.use_qa_report,
          persist: true,
          async: true,
        });
        logger.info(
          { userId, contentId: id, jobId: job.job_id },
          'content-actions: rewrite-with-research queued via engine',
        );
        res.status(202).json({
          success: true,
          jobId: job.job_id,
          engineJob: true,
          status: job.status ?? 'queued',
        });
        return;
      }

      // n8n path: the hub webhook must be configured.
      const webhookUrl = resolveHubWebhookUrl();
      if (!webhookUrl) {
        res.status(503).json({
          success: false,
          error: { code: 'NOT_CONFIGURED', message: 'N8N_HUB_WEBHOOK_URL not set' },
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

// Rewrite a chapter to FIX its Q/A findings. Unlike /:id/repair (generic drift repair), this reads
// the chapter's Q/A Consistency Report and threads the flagged checks + their suggestions into the
// rewrite as style directives, so the one-click rewrite targets exactly what the report flagged
// (e.g. "No flat paragraphs: rewrite so Mara's attention to the peeling tape is the entry point…").
// Reuses chapter.repair (line-edit + drift correction + re-QA + re-persist). Async → engine job id.
contentActionsRouter.post('/:id/rewrite-to-fix-qa', async (req: Request, res: Response) => {
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
      .select('id, user_id, chapter_number, content_type, project_id, metadata')
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !chapter) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chapter not found' } });
      return;
    }
    if (chapter.content_type !== 'chapter') {
      res.status(400).json({ success: false, error: { code: 'NOT_A_CHAPTER', message: 'Q/A fix targets chapters' } });
      return;
    }
    const meta = (chapter.metadata ?? {}) as Record<string, unknown>;
    const report = (meta.qa_report ?? meta.last_qa_report ?? {}) as { checks?: Array<{ name?: string; status?: string; details?: string }> };
    const flagged = (Array.isArray(report.checks) ? report.checks : []).filter(
      (c) => c && c.status && String(c.status).toUpperCase() !== 'PASS',
    );
    const directive = flagged.length
      ? `Fix these Q/A findings without changing the plot, roster, or outline. ${flagged
          .map((c) => `${c.name ?? 'issue'}: ${c.details ?? ''}`.trim())
          .join(' | ')}`
      : 'Strengthen every paragraph — remove flat/expository prose, sharpen imagery and dialogue, keep the plot and roster identical.';

    const job = await callEngineWriteTool('chapter', {
      op: 'repair',
      project_id: chapter.project_id,
      chapter_number: chapter.chapter_number,
      user_id: userId,
      research_focus: '',
      style_directives: directive,
      use_qa_report: true,
      persist: true,
      async: true,
    });
    logger.info(
      { userId, contentId: id, jobId: job.job_id, flagged: flagged.length },
      'content-actions: rewrite-to-fix-qa queued via engine',
    );
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, userId, contentId: id }, 'content-actions: rewrite-to-fix-qa failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});

// Run the Q/A Consistency check as a true BACKGROUND engine job. The old path went through the chat hub
// (enqueueHubCommand → /api/chat/proxy → callEngineHub) which could hold the HTTP request open for the
// whole multi-minute QA run — so it hit the edge timeout and died, and navigating away killed it. This
// enqueues an arq write-tool job (async:true) that runs in the worker independent of the request/browser
// and persists the qa_report; the UI polls /api/jobs/engine/:id and refetches when it completes.
contentActionsRouter.post('/:id/run-qa', async (req: Request, res: Response) => {
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
      res.status(400).json({ success: false, error: { code: 'NOT_A_CHAPTER', message: 'Q/A targets chapters' } });
      return;
    }
    const job = await callEngineWriteTool('chapter', {
      op: 'qa',
      project_id: chapter.project_id,
      chapter_number: chapter.chapter_number,
      user_id: userId,
      persist: true,
      async: true,
    });
    logger.info({ userId, contentId: id, jobId: job.job_id }, 'content-actions: run-qa queued via engine');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, userId, contentId: id }, 'content-actions: run-qa failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});

const LifecycleSchema = z.object({
  action: z.enum(['approve', 'publish', 'reject', 'schedule', 'unschedule', 'draft']),
  schedule_date: z.string().optional(),
});

const LIFECYCLE_STATUS: Record<string, string> = {
  approve: 'approved',
  publish: 'published',
  reject: 'rejected',
  schedule: 'scheduled',
  unschedule: 'draft',
  draft: 'draft',
};

/**
 * Server-side lifecycle fallback when the engine is the n8n backend or the engine gateway is
 * unreachable. Replicates the snapshot + status change (the email is the only engine-only extra it
 * skips — logged) so a core approve/publish never hard-fails on engine downtime. `row` is the
 * pre-update content row.
 */
async function serverSideLifecycle(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  id: string,
  userId: string,
  action: string,
  scheduleDate: string | undefined,
  row: { content_text?: string | null; metadata?: Record<string, unknown> | null },
): Promise<string> {
  const newStatus = LIFECYCLE_STATUS[action] ?? 'draft';
  // Snapshot before approve/publish — the auto-version the n8n manage_library workflow took.
  if ((action === 'approve' || action === 'publish') && row.content_text) {
    const { data: last } = await supabase
      .from('content_versions_v2')
      .select('version_number')
      .eq('content_id', id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = ((last?.version_number as number | undefined) ?? 0) + 1;
    await supabase.from('content_versions_v2').insert({
      content_id: id,
      user_id: userId,
      version_number: nextVersion,
      content_text: row.content_text,
      changed_by: `lifecycle_${action}`,
      change_note: `auto-snapshot before ${action}`,
    });
  }
  const updates: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
  const meta = { ...(row.metadata || {}) };
  if (action === 'publish') updates.published_at = new Date().toISOString();
  if (action === 'schedule' && scheduleDate) {
    meta.schedule_date = scheduleDate;
    updates.metadata = meta;
  }
  if (action === 'unschedule' && 'schedule_date' in meta) {
    delete meta.schedule_date;
    updates.metadata = meta;
  }
  await supabase.from('published_content_v2').update(updates).eq('id', id).eq('user_id', userId);
  logger.warn({ contentId: id, action }, 'content-actions: lifecycle via server fallback (no email)');
  return newStatus;
}

/**
 * POST /api/content/:id/lifecycle — CR-010 B2: change a piece of content's lifecycle state
 * (approve / publish / reject / schedule / unschedule / back-to-draft) through the ENGINE's
 * library.lifecycle op rather than a direct Supabase status write. The engine snapshots the current
 * text into content_versions_v2 on approve/publish and emails the user (approve/publish/reject/
 * schedule) — the auto-version + notification that the n8n manage_library workflow performed and that
 * the old direct-Supabase UI write silently skipped. Synchronous (lifecycle is a fast info op).
 * Falls back to an equivalent server-side write (snapshot + status, no email) if the engine is the
 * n8n backend or the gateway is unreachable, so a core lifecycle action never hard-fails.
 */
contentActionsRouter.post('/:id/lifecycle', validateBody(LifecycleSchema), async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }
  const id = String(req.params.id);
  const { action, schedule_date } = req.body as z.infer<typeof LifecycleSchema>;
  try {
    // Verify the content belongs to the requesting user; load the row for the fallback snapshot.
    const supabase = getSupabaseAdmin();
    const { data: content, error } = await supabase
      .from('published_content_v2')
      .select('id, content_text, metadata, status')
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !content) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Content not found' } });
      return;
    }

    if (hubBackend() === 'engine') {
      try {
        const out = (await callEngineWriteTool('library', {
          op: 'lifecycle',
          content_id: id,
          user_id: userId,
          action,
          ...(schedule_date ? { schedule_date } : {}),
          async: false,
        })) as { payload?: { result?: Record<string, unknown> } };
        const result = out.payload?.result ?? {};
        if (result.error) throw new Error(String(result.error));
        logger.info({ userId, contentId: id, action, status: result.status }, 'content-actions: lifecycle via engine');
        res.json({ success: true, status: result.status, result, via: 'engine' });
        return;
      } catch (engineErr) {
        logger.warn({ err: engineErr, contentId: id, action }, 'content-actions: engine lifecycle failed, falling back');
      }
    }

    const status = await serverSideLifecycle(supabase, id, userId, action, schedule_date, content);
    res.json({ success: true, status, via: 'server' });
  } catch (err) {
    logger.error({ err, userId, contentId: id, action }, 'content-actions: lifecycle failed');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
    });
  }
});

// =====================================================================
// Chapter approval readiness + bulk approve
// =====================================================================
// Approval is a real gate, not a label: the manuscript export filters on
// `status in ('approved','published')` (routes/export.ts), so a book with 96
// draft chapters exports nothing at all. Approving one chapter at a time
// through the UI is 96 round trips, which is why none of them were approved.
//
// What blocks approval is deliberately narrow. Measured over a full 96-chapter
// book: the continuity dimensions fail in 0-4 chapters each and a failure there
// is a genuine defect. The two craft dimensions fail in 51 and 39 — gating on
// those would block two thirds of the book on a known limitation of the
// generator, which no automated pass fixes. They are editorial notes, and they
// belong in the Review tab, not in a gate.
//
// Staleness blocks, though. Approving a chapter whose report describes prose
// that was since replaced is approving something nobody read — and that was not
// hypothetical: a repair pass rewrote four chapters and left their reports
// twelve minutes stale, under a "5/8 passed" badge.

// FACTUAL defects only. A failure here means something is wrong: a character is named
// inconsistently, the chapter does not do what its outline said it would, or the prose contains an
// anachronism — which in historical fiction is an error, not a preference.
//
// Everything else is EDITORIAL JUDGEMENT and advises instead. The first version of this gate also
// blocked prose clarity, dialogue and character craft, and the justification was frequency: pacing
// fails in a third of chapters so gating on it would stop most of the book, while prose clarity
// failed in ten. That is an argument about how many, not about what kind, and it produced a gate
// that stopped a book for exactly the sort of thing it waved through elsewhere. Measured on a
// 96-chapter book: 13 chapters blocked, 10 of them on prose clarity alone, every one carrying a
// line-level suggestion the author could have accepted in a click.
const BLOCKING_CHECKS = new Set([
  'Character consistency',
  'Follows the outline',
  'Period language',
]);

/** First 16 hex of the SHA-256 — the same fingerprint the engine stamps on a report. */
export function proseFingerprint(text: string): string {
  return crypto.createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 16);
}

export interface ChapterReadiness {
  id: string;
  chapter_number: number | null;
  title: string;
  status: string;
  eligible: boolean;
  blockers: string[];
  advisories: string[];
}

export function assessChapter(row: {
  id: string;
  chapter_number: number | null;
  title: string | null;
  status: string | null;
  content_text: string | null;
  metadata: Record<string, unknown> | null;
}): ChapterReadiness {
  const meta = row.metadata || {};
  const report = meta.qa_report as
    | { checks?: { name?: string; status?: string }[]; scored_sha256?: string }
    | undefined;
  const blockers: string[] = [];
  const advisories: string[] = [];

  if (!row.content_text || !row.content_text.trim()) {
    blockers.push('The chapter has no text.');
  }
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    blockers.push('No Q/A report — run the Q/A check.');
  } else {
    if (!report.scored_sha256) {
      blockers.push('The Q/A report predates verified scoring and cannot be confirmed — re-run it.');
    } else if (report.scored_sha256 !== proseFingerprint(row.content_text || '')) {
      blockers.push('The Q/A report describes an earlier draft — the chapter changed since it was scored.');
    }
    for (const c of report.checks) {
      const name = c.name || '';
      if (c.status === 'PASS') continue;
      if (BLOCKING_CHECKS.has(name)) blockers.push(`${name} did not pass.`);
      else advisories.push(`${name} is below threshold.`);
    }
  }
  return {
    id: row.id,
    chapter_number: row.chapter_number,
    title: row.title || '',
    status: row.status || 'draft',
    eligible: blockers.length === 0,
    blockers,
    advisories,
  };
}

async function loadProjectChapters(projectId: string, userId: string) {
  const supabase = getSupabaseAdmin();
  const rows: Record<string, unknown>[] = [];
  // Paged: PostgREST caps a response at 1000 rows, so `rows.length` on a single
  // call is a page size, not a count.
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('published_content_v2')
      .select('id, chapter_number, title, status, content_text, metadata')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('content_type', 'chapter')
      .is('deleted_at', null)
      .order('chapter_number', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return rows as unknown as Parameters<typeof assessChapter>[0][];
}

/**
 * @openapi
 * /content/project/{projectId}/approval-readiness:
 *   get:
 *     tags: [Content]
 *     summary: Which chapters of a project can be approved, and what is blocking the rest
 */
contentActionsRouter.get('/project/:projectId/approval-readiness', async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return;
  }
  try {
    const projectId = String(req.params.projectId);
    const chapters = (await loadProjectChapters(projectId, userId)).map(assessChapter);
    const pending = chapters.filter((c) => c.status !== 'approved' && c.status !== 'published');
    res.json({
      success: true,
      chapters,
      counts: {
        total: chapters.length,
        approved: chapters.length - pending.length,
        eligible: pending.filter((c) => c.eligible).length,
        blocked: pending.filter((c) => !c.eligible).length,
        with_advisories: chapters.filter((c) => c.advisories.length > 0).length,
      },
    });
  } catch (err) {
    logger.error({ err, userId, projectId: String(req.params.projectId) }, 'approval-readiness failed');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
    });
  }
});

const BulkApproveSchema = z.object({
  // Default false so a mis-click cannot approve a book. The caller must say so.
  confirm: z.literal(true),
  // Optional allow-list; omitted means "every eligible chapter".
  chapterNumbers: z.array(z.number().int()).max(2000).optional(),
});

/**
 * @openapi
 * /content/project/{projectId}/approve-eligible:
 *   post:
 *     tags: [Content]
 *     summary: Approve every chapter that passes the gate
 *     description: |
 *       Approves only chapters with no blockers. Each approval snapshots the
 *       prior text into `content_versions_v2` first, so it is reversible.
 *       Blocked chapters are returned with their reasons and left alone.
 */
contentActionsRouter.post(
  '/project/:projectId/approve-eligible',
  validateBody(BulkApproveSchema),
  async (req: Request, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    const { chapterNumbers } = req.body as z.infer<typeof BulkApproveSchema>;
    const only = chapterNumbers ? new Set(chapterNumbers) : null;
    try {
      const supabase = getSupabaseAdmin();
      const projectId = String(req.params.projectId);
      const rows = await loadProjectChapters(projectId, userId);
      const approved: number[] = [];
      const skipped: { chapter_number: number | null; reason: string }[] = [];
      for (const row of rows) {
        if (only && !only.has(row.chapter_number ?? -1)) continue;
        if (row.status === 'approved' || row.status === 'published') continue;
        const verdict = assessChapter(row);
        if (!verdict.eligible) {
          skipped.push({ chapter_number: row.chapter_number, reason: verdict.blockers[0] });
          continue;
        }
        try {
          await serverSideLifecycle(supabase, row.id, userId, 'approve', undefined, {
            content_text: row.content_text,
            metadata: row.metadata,
          });
          approved.push(row.chapter_number ?? -1);
        } catch (err) {
          skipped.push({
            chapter_number: row.chapter_number,
            reason: err instanceof Error ? err.message.slice(0, 160) : 'approve failed',
          });
        }
      }
      logger.info({ userId, projectId, approved: approved.length, skipped: skipped.length },
        'bulk approve complete');
      res.json({ success: true, approved, skipped, counts: { approved: approved.length, skipped: skipped.length } });
    } catch (err) {
      logger.error({ err, userId, projectId: String(req.params.projectId) }, 'bulk approve failed');
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  },
);
