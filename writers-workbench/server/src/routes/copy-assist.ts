/**
 * The copy assistant's routes, and the per-book copy that had nowhere to live (subtitle, inside flap,
 * Also by).
 *
 *   GET  /api/copy-assist/project/:id/copy         the saved subtitle / inside flap / Also by, and the
 *                                                 assistant's price, limits and field list
 *   PUT  /api/copy-assist/project/:id/copy         save them (the author's action; book_copy_v2)
 *   POST /api/copy-assist/project/:id/assist       draft or revise ONE field — returns text, saves nothing
 *   POST /api/copy-assist/project/:id/assist/all   draft several EMPTY package fields at a quoted total
 *
 * Its own prefix (not /api/publishing) so a request is authenticated once, not once per router.
 *
 * PRICED under `promo_copy` per field drafted or revised (credit-costs.ts). Checked before the model
 * is called (402 like every priced op), charged only for a draft that came back, admins exempt. "Also
 * by" is filled from the author's own projects with no model and is free.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { parseWith } from '../lib/claude-structured.js';
import { getCreditCost } from '../services/credit-costs.js';
import { chargeable, chargeCredits, refuseIfInsufficient } from '../lib/credit-charge.js';
import { loadProject, marketingKey, publishingOf } from './publishing.js';
import { bookTitle, plannedBooks, seriesName, storedSeries } from '../lib/series.js';
import { buyOf, publicBase, publicOf } from './landing-page.js';
import { COPY_FIELDS, loadSavedCopy, type CopyField } from '../lib/book-copy.js';
import {
  DraftOutput,
  FIELD_KEYS,
  FIELD_SPECS,
  PACKAGE_FIELDS,
  limitOf,
  runAssist,
  specOf,
  type AssistResult,
  type BookFacts,
  type Caller,
  type FieldKey,
} from '../lib/copy-assist.js';

export const copyAssistRouter = Router();
copyAssistRouter.use(requireAuth);

type Outline = Record<string, unknown>;

/** The price key. One per field drafted or revised; see credit-costs.ts for how it was measured. */
export const PROMO_COPY_KEY = 'promo_copy';

/** The model. Swappable in tests; production is the structured Claude call every route uses. */
let caller: Caller = (prompt, ctx, prefix) => parseWith(DraftOutput, prompt, ctx, 'medium', prefix);
export function setAssistCaller(c: Caller | null): void {
  caller = c ?? ((prompt, ctx, prefix) => parseWith(DraftOutput, prompt, ctx, 'medium', prefix));
}

// ------------------------------------------------------------------------------------------------
// The saved copy
// ------------------------------------------------------------------------------------------------

copyAssistRouter.get('/project/:projectId/copy', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const saved = await loadSavedCopy(project.id, req.userId!);
    const price = await getCreditCost(PROMO_COPY_KEY);
    res.json({
      success: true,
      data: {
        ...saved,
        assist: {
          price,
          charged: chargeable(req),
          fields: Object.fromEntries(
            FIELD_KEYS.map((k) => {
              const s = specOf(k);
              return [k, { label: s.label, kind: s.kind, limit: limitOf(k, project.title), max_items: s.maxItems ?? null, free: Boolean(s.deterministic) }];
            }),
          ),
          package_fields: PACKAGE_FIELDS,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

const CopySchema = z.object({
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
  subtitle: z.string().max(200).optional(),
  inside_flap: z.string().max(4000).optional(),
  also_by: z.array(z.string().trim().max(200)).max(20).optional(),
  /** Which fields the author saved exactly as the assistant drafted them. */
  generated: z.array(z.enum(COPY_FIELDS)).optional(),
});

copyAssistRouter.put('/project/:projectId/copy', validateBody(CopySchema), async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const body = req.body as z.infer<typeof CopySchema>;
    const volume = body.volume_index ?? 1;
    const subtitle = body.subtitle?.trim();
    if (subtitle && project.title.trim().length + 1 + subtitle.length > 199) {
      res.status(400).json({
        success: false,
        error: { code: 'TOO_LONG', message: `KDP allows 200 characters for the title and subtitle together; this is ${project.title.trim().length + 1 + subtitle.length}.` },
      });
      return;
    }
    const now = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];
    const add = (field: CopyField, value: string, vol: number) =>
      rows.push({
        user_id: req.userId!,
        project_id: project.id,
        volume_index: vol,
        field,
        value,
        source: body.generated?.includes(field) ? 'generated' : 'edited',
        updated_at: now,
      });
    if (body.subtitle !== undefined) add('subtitle', subtitle ?? '', volume);
    if (body.inside_flap !== undefined) add('inside_flap', body.inside_flap.trim(), volume);
    // Also by is the author's list, printed in every book of the project: stored once, on book 1.
    if (body.also_by !== undefined) add('also_by', body.also_by.filter(Boolean).join('\n'), 1);
    if (rows.length) {
      const { error } = await getSupabaseAdmin()
        .from('book_copy_v2')
        .upsert(rows, { onConflict: 'project_id,volume_index,field' });
      if (error) {
        if (error.code === '42P01') {
          res.status(503).json({ success: false, error: { code: 'MIGRATION_PENDING', message: 'Apply migration 054_book_copy.sql to this database, then save again.' } });
          return;
        }
        throw new Error(error.message);
      }
    }
    logger.info({ userId: req.userId, projectId: project.id, volume, fields: rows.map((r) => r.field) }, 'copy-assist: copy saved');
    res.json({ success: true, data: await loadSavedCopy(project.id, req.userId!) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------------------------------------
// The book's material
// ------------------------------------------------------------------------------------------------

interface ProjectLike {
  id: string;
  title: string;
  genre_slug: string | null;
  outline: Outline | null;
}

const BIBLE_ORDER = ['character', 'place', 'location', 'plot_thread', 'event', 'object', 'concept'];

/** Everything the assistant may draw on, for one book of the project. */
export async function loadFacts(
  project: ProjectLike,
  userId: string,
  volumeIndex: number | null,
  fields: FieldKey[],
  req?: Request,
): Promise<BookFacts> {
  const supabase = getSupabaseAdmin();
  const outline = project.outline ?? {};
  const books = plannedBooks(outline);
  const isSeries = books.length > 1;
  const vol = isSeries ? books.find((b) => b.index === (volumeIndex ?? 1)) ?? books[0] : null;
  const inRange = (n: number) => !vol || (n >= vol.first_chapter && n <= vol.last_chapter);

  const planned = Array.isArray(outline.chapters) ? (outline.chapters as Record<string, unknown>[]) : [];
  const chapters = planned
    .map((c) => ({
      number: Number(c.chapter_number ?? c.number ?? 0),
      title: String(c.title ?? ''),
      beat: String(c.beat ?? c.brief ?? c.summary ?? ''),
    }))
    .filter((c) => inRange(c.number));

  const { data: bibleRows } = await supabase
    .from('story_bible_v2')
    .select('entry_type, name, description')
    .eq('project_id', project.id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .limit(200);
  const bible = ((bibleRows ?? []) as { entry_type: string; name: string; description: string }[])
    .sort((a, b) => {
      const ia = BIBLE_ORDER.indexOf(a.entry_type);
      const ib = BIBLE_ORDER.indexOf(b.entry_type);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .slice(0, 45)
    .map((e) => ({ type: e.entry_type, name: e.name, description: e.description }));
  // The outline's own cast, when the bible has not been built yet.
  if (!bible.some((b) => b.type === 'character') && Array.isArray(outline.characters)) {
    for (const c of (outline.characters as Record<string, unknown>[]).slice(0, 20)) {
      const name = String(c.name ?? '').trim();
      if (name) bible.push({ type: 'character', name, description: String(c.description ?? c.role ?? '') });
    }
  }

  // Excerpts: the opening of this book; for an epigraph, passages from across it.
  const { data: textRows } = await supabase
    .from('published_content_v2')
    .select('chapter_number, content_text')
    .eq('project_id', project.id)
    .eq('user_id', userId)
    .eq('content_type', 'chapter')
    .is('deleted_at', null)
    .order('chapter_number', { ascending: true })
    .range(0, 999);
  const written = ((textRows ?? []) as { chapter_number: number; content_text: string | null }[]).filter(
    (r) => inRange(Number(r.chapter_number)) && (r.content_text ?? '').trim(),
  );
  const excerpts: { chapter: number; text: string }[] = [];
  if (written[0]) excerpts.push({ chapter: Number(written[0].chapter_number), text: written[0].content_text!.slice(0, 2500) });
  if (fields.includes('epigraph') && written.length > 1) {
    const step = Math.max(1, Math.floor(written.length / 6));
    for (let i = step; i < written.length && excerpts.length < 7; i += step) {
      const t = written[i].content_text!;
      const start = Math.floor(t.length / 3);
      excerpts.push({ chapter: Number(written[i].chapter_number), text: t.slice(start, start + 1500) });
    }
  }

  const index = vol?.index ?? 1;
  const m = (outline[marketingKey(index)] as Record<string, unknown> | undefined) ?? {};
  const savedCopy = await loadSavedCopy(project.id, userId);
  const settings = publishingOf(outline);
  const s = storedSeries(outline);
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join('; ') : '');
  const saved: Record<string, string> = {
    description: String(m.blurb ?? ''),
    back_cover: String(m.back_cover ?? ''),
    hook: String(m.hook ?? ''),
    keywords: list(m.keywords),
    categories: list(m.categories),
    subtitle: savedCopy.books[String(index)]?.subtitle ?? '',
    series_description: s.description?.text ?? '',
  };

  const { data: p } = await supabase.from('author_profiles_v2').select('*').eq('user_id', userId).maybeSingle();
  const prof = (p ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(prof[k] ?? '').trim();
  const arr = (k: string) => (Array.isArray(prof[k]) ? (prof[k] as string[]) : []);
  let penName = str('pen_name');
  if (!penName) {
    const { data: account } = await supabase.from('users_v2').select('display_name').eq('user_id', userId).maybeSingle();
    penName = String(account?.display_name ?? '').trim();
  }

  let research: BookFacts['research'] = [];
  if (fields.includes('authors_note')) {
    const { data: reports } = await supabase
      .from('research_reports_v2')
      .select('topic, content')
      .eq('user_id', userId)
      .like('topic', `${project.title.replace(/[%_]/g, '')}%`)
      .is('deleted_at', null)
      .limit(8);
    research = ((reports ?? []) as { topic: string; content: string }[]).map((r) => ({
      topic: r.topic,
      excerpt: String(r.content ?? '').slice(0, 900),
    }));
  }

  let landing: BookFacts['landing'] = null;
  if (req && fields.some((f) => specOf(f).store === 'email')) {
    const pub = publicOf(outline);
    const buy = buyOf(outline);
    if (pub) landing = { url: `${publicBase(req)}/books/${pub.slug}`, buyUrl: buy?.url ?? '', buyLabel: buy?.label ?? '' };
  }

  return {
    title: project.title,
    genre: project.genre_slug ?? '',
    premise: String(outline.premise ?? ''),
    themes: Array.isArray(outline.themes) ? (outline.themes as string[]) : [],
    chapters,
    bible,
    excerpts,
    saved,
    series: isSeries
      ? {
          name: seriesName(outline, project.title),
          index,
          total: books.length,
          bookTitle: bookTitle(outline, index),
          books: books.map((b) => {
            const bm = (outline[marketingKey(b.index)] as Record<string, unknown> | undefined) ?? {};
            return { index: b.index, title: bookTitle(outline, b.index), hook: String(bm.hook ?? ''), blurb: String(bm.blurb ?? '') };
          }),
        }
      : null,
    author: {
      pen_name: penName,
      pronouns: str('pronouns'),
      lives: str('lives'),
      background: str('background'),
      credentials: arr('credentials'),
      prior_work: arr('prior_work'),
      why_this_book: settings.why_this_book.trim() || str('why_this_book'),
      personal: str('personal'),
      links: arr('links'),
    },
    research,
    landing,
  };
}

/** "Also by": the author's other projects that have written chapters. No model, no charge. */
async function alsoByDraft(projectId: string, userId: string): Promise<AssistResult> {
  const supabase = getSupabaseAdmin();
  const { data: projects } = await supabase
    .from('writing_projects_v2')
    .select('id, title, updated_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .neq('id', projectId)
    .order('updated_at', { ascending: false })
    .limit(100);
  const items: string[] = [];
  for (const p of (projects ?? []) as { id: string; title: string }[]) {
    const { count } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', p.id)
      .eq('content_type', 'chapter')
      .is('deleted_at', null);
    const title = String(p.title ?? '').trim();
    // Working copies ("The Burial Mound (CR-001 top-down) (2026-10-26 19:10)") are not books.
    if (!count || !title || /\(\d{4}-\d{2}-\d{2}/.test(title) || items.includes(title)) continue;
    items.push(title);
    if (items.length >= 20) break;
  }
  const value = items.join('\n');
  return {
    field: 'also_by',
    value,
    items,
    chars: value.length,
    limit: specOf('also_by').maxChars,
    over_limit: false,
    warnings: items.length
      ? ['these are your other projects with chapters: keep only the ones that are published or coming']
      : ['you have no other projects with chapters yet'],
    calls: 0,
  };
}

// ------------------------------------------------------------------------------------------------
// Drafting
// ------------------------------------------------------------------------------------------------

const AssistSchema = z
  .object({
    field: z.enum(FIELD_KEYS as [FieldKey, ...FieldKey[]]),
    volume_index: z.number().int().min(1).max(12).nullable().optional(),
    mode: z.enum(['draft', 'revise']).default('draft'),
    instruction: z.string().trim().max(1000).optional(),
    current: z.string().max(20000).optional(),
  })
  .refine((b) => b.mode === 'draft' || (b.instruction?.trim() && b.current?.trim()), {
    message: 'A revision needs the current text and what to change.',
    path: ['instruction'],
  });

function failed(res: Response, err: unknown, what: string): void {
  logger.error({ err }, `copy-assist: ${what} failed`);
  res.status(502).json({
    success: false,
    error: { code: 'ASSIST_FAILED', message: err instanceof Error ? err.message : 'The assistant failed' },
  });
}

copyAssistRouter.post('/project/:projectId/assist', validateBody(AssistSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof AssistSchema>;
  const spec = specOf(body.field);

  if (spec.deterministic) {
    try {
      const result = await alsoByDraft(project.id, req.userId!);
      res.setHeader('X-Credits-Remaining', String(req.creditsRemaining ?? 0));
      res.json({ success: true, data: { ...result, credits_charged: 0 } });
    } catch (err) {
      failed(res, err, 'also-by');
    }
    return;
  }
  if (body.field.startsWith('series_') && plannedBooks(project.outline).length < 2) {
    res.status(400).json({ success: false, error: { code: 'NOT_A_SERIES', message: 'Plan the books first: there is only one.' } });
    return;
  }

  const cost = await getCreditCost(PROMO_COPY_KEY);
  if (refuseIfInsufficient(req, res, cost)) return;
  try {
    const facts = await loadFacts(project, req.userId!, body.volume_index ?? null, [body.field], req);
    const result = await runAssist(
      { field: body.field, mode: body.mode, instruction: body.instruction, current: body.current },
      facts,
      { userId: req.userId, projectId: project.id },
      caller,
    );
    // Charged only for a draft that came back. An empty answer costs nothing.
    const paid = result.value.trim()
      ? await chargeCredits(req, res, cost, `copy-assist.${body.mode}:${PROMO_COPY_KEY} ${body.field}`, project.id)
      : { charged: 0, remaining: req.creditsRemaining ?? 0 };
    logger.info(
      { userId: req.userId, projectId: project.id, field: body.field, mode: body.mode, chars: result.chars, over: result.over_limit, warnings: result.warnings.length, calls: result.calls, charged: paid.charged },
      'copy-assist: drafted',
    );
    res.json({ success: true, data: { ...result, credits_charged: paid.charged, credits_remaining: paid.remaining } });
  } catch (err) {
    failed(res, err, 'draft');
  }
});

const AllSchema = z.object({
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
  /** The EMPTY fields to draft. The screen decides what is empty: it holds the unsaved edits. */
  fields: z.array(z.enum(PACKAGE_FIELDS as [FieldKey, ...FieldKey[]])).min(1).max(PACKAGE_FIELDS.length),
  /** The total the author was shown and agreed to. A different price now means ask again. */
  expected_cost: z.number().int().min(0),
});

copyAssistRouter.post('/project/:projectId/assist/all', validateBody(AllSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof AllSchema>;
  const fields = [...new Set(body.fields)];
  const unit = await getCreditCost(PROMO_COPY_KEY);
  const total = chargeable(req) ? unit * fields.length : 0;
  if (total !== body.expected_cost) {
    res.status(409).json({
      success: false,
      error: { code: 'PRICE_CHANGED', message: `This would cost ${total} credits, not ${body.expected_cost}. Check the total and try again.`, total },
    });
    return;
  }
  if (refuseIfInsufficient(req, res, total)) return;

  try {
    const facts = await loadFacts(project, req.userId!, body.volume_index ?? null, fields, req);
    const results: Record<string, AssistResult> = {};
    const errors: Record<string, string> = {};
    const one = async (f: FieldKey) => {
      try {
        results[f] = await runAssist({ field: f, mode: 'draft' }, facts, { userId: req.userId, projectId: project.id }, caller);
      } catch (err) {
        errors[f] = err instanceof Error ? err.message : 'failed';
      }
    };
    // The book's material is the same cached prefix for every field: the first call alone writes
    // the cache, then the rest read it two at a time.
    const queue = [...fields];
    await one(queue.shift()!);
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await one(f);
    };
    await Promise.all([worker(), worker()]);
    const drafted = Object.values(results).filter((r) => r.value.trim()).length;
    const paid = drafted
      ? await chargeCredits(req, res, chargeable(req) ? unit * drafted : 0, `copy-assist.all:${PROMO_COPY_KEY} x${drafted}`, project.id)
      : { charged: 0, remaining: req.creditsRemaining ?? 0 };
    logger.info({ userId: req.userId, projectId: project.id, fields, drafted, failed: Object.keys(errors), charged: paid.charged }, 'copy-assist: drafted all missing');
    res.json({ success: true, data: { results, errors, credits_charged: paid.charged, credits_remaining: paid.remaining } });
  } catch (err) {
    failed(res, err, 'draft all');
  }
});

export { FIELD_SPECS };
