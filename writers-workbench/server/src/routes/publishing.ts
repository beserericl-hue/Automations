/**
 * Publishing: the decisions that turn a finished manuscript into books on Amazon.
 *
 * WHY THIS FILE EXISTS. The pieces were all built — the volume planner, the listing copy writer, the
 * interior PDF, the cover wrap, the KDP validator — and every one of them could only be reached by
 * running a script by hand. Nothing a script did survived it: the trim size lived in a shell
 * variable, the listing copy in a file on a desktop, and the book's own ISBN nowhere at all. So this
 * is the other half: every one of those decisions gets a URL and a row in the database.
 *
 * WHERE IT IS STORED. `writing_projects_v2.outline` is a JSONB column, and the publishing state goes
 * in it under reserved keys — `_publishing` (the author's choices), `_volume_plan` (what the planner
 * decided), `_marketing` / `_marketing_v2`… (the listing copy, per volume), `_marketing_history`
 * (what it said before the last run). That is a deliberate choice over new tables: the base tables
 * are immutable and the engine already writes the plan and the copy there, so a second home for the
 * same data would mean two versions of a blurb and no way to tell which one shipped.
 *
 * WHO WRITES WHAT. The engine owns generation and persists its own output. This route owns the
 * author's side: the choices, the hand edits, and the history snapshot taken *before* a run, so a
 * revision that comes back worse can be read against what it replaced.
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool } from '../lib/engine-hub.js';
import { logger } from '../lib/logger.js';
import { TRIM_SIZES } from '../lib/print-pdf.js';
import { PAPER_THICKNESS } from '../lib/cover.js';
import { searchArchives } from '../lib/image-archives.js';

export const publishingRouter = Router();
publishingRouter.use(requireAuth);

/** How many previous drafts to keep. Enough to see a revision loop; not enough to bloat the row. */
const HISTORY_LIMIT = 20;

type Outline = Record<string, unknown>;

interface ProjectRow {
  id: string;
  title: string;
  genre_slug: string | null;
  outline: Outline | null;
}

/** Load the project, or answer 404. Ownership is checked here and nowhere else. */
async function loadProject(req: Request, res: Response): Promise<ProjectRow | null> {
  const projectId = String(req.params.projectId);
  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('id, title, genre_slug, outline')
    .eq('id', projectId)
    .eq('user_id', req.userId!)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
    return null;
  }
  return data as unknown as ProjectRow;
}

/**
 * Write the outline back.
 *
 * `updated_at` is stamped on every write. An outline change that leaves it alone is invisible to the
 * freshness checks, so nothing downstream notices the book was reorganised — a trap this codebase
 * has already been caught by once.
 */
async function saveOutline(projectId: string, userId: string, outline: Outline): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .update({ outline, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** The listing copy's key for a volume. Volume one and a single-volume book share `_marketing`. */
function marketingKey(volumeIndex?: number | null): string {
  return volumeIndex && volumeIndex > 1 ? `_marketing_v${volumeIndex}` : '_marketing';
}

/** The author's publishing choices, with the defaults spelled out rather than assumed. */
const PUBLISHING_DEFAULTS = {
  trim: '6x9',
  paper: 'cream' as keyof typeof PAPER_THICKNESS,
  volume_count: null as number | null,
  why_this_book: '',
  publisher: '',
  /** Per volume, because KDP issues one ISBN per paperback. Keyed by volume index as a string. */
  isbns: {} as Record<string, string>,
  dedication: '',
  epigraph: '',
  epigraph_attribution: '',
  authors_note: '',
  acknowledgements: '',
  body_size: 11,
};

type Publishing = typeof PUBLISHING_DEFAULTS;

function publishingOf(outline: Outline | null): Publishing {
  const stored = (outline?._publishing as Partial<Publishing> | undefined) ?? {};
  return { ...PUBLISHING_DEFAULTS, ...stored, isbns: { ...(stored.isbns ?? {}) } };
}

const SettingsSchema = z.object({
  trim: z.enum(Object.keys(TRIM_SIZES) as [string, ...string[]]).optional(),
  paper: z.enum(Object.keys(PAPER_THICKNESS) as [string, ...string[]]).optional(),
  /** null means "let the planner decide from the page cap". */
  volume_count: z.number().int().min(1).max(12).nullable().optional(),
  why_this_book: z.string().max(4000).optional(),
  publisher: z.string().max(200).optional(),
  isbns: z.record(z.string(), z.string().max(40)).optional(),
  dedication: z.string().max(2000).optional(),
  epigraph: z.string().max(2000).optional(),
  epigraph_attribution: z.string().max(300).optional(),
  authors_note: z.string().max(20000).optional(),
  acknowledgements: z.string().max(20000).optional(),
  body_size: z.number().min(9).max(14).optional(),
});

const PlanVolumesSchema = z.object({
  trim: z.enum(Object.keys(TRIM_SIZES) as [string, ...string[]]).optional(),
  volume_count: z.number().int().min(1).max(12).nullable().optional(),
  /**
   * Whether an LLM reads the closing pages of each candidate break and scores how badly it leaves
   * the reader hanging. Off falls back to a heuristic, which is a shortlist rather than a verdict.
   */
  judge_endings: z.boolean().optional().default(true),
});

const MarketingDraftSchema = z.object({
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
  /** Present = revise the existing draft against these words. Absent = write the first one. */
  instructions: z.string().max(4000).optional(),
});

/** Every field of the listing copy is hand-editable. Nothing here is generated-only. */
const MarketingEditSchema = z.object({
  volume_index: z.number().int().min(1).max(12).nullable().optional(),
  blurb: z.string().max(8000).optional(),
  back_cover: z.string().max(4000).optional(),
  hook: z.string().max(500).optional(),
  keywords: z.array(z.string().max(200)).max(7).optional(),
  categories: z.array(z.string().max(200)).max(3).optional(),
  comparable_titles: z.array(z.string().max(300)).max(6).optional(),
  author_bio: z.string().max(4000).optional(),
});

// ------------------------------------------------------------------------------------------------
// Reading the state
// ------------------------------------------------------------------------------------------------

/**
 * @openapi
 * /publishing/project/{projectId}:
 *   get:
 *     tags: [Publishing]
 *     summary: Everything the publishing screens need, in one call
 *     description: |
 *       The author's choices, the volume plan, the listing copy per volume with its history, the
 *       author profile, and what is still missing. One call because these are read together and a
 *       screen that fetches them separately shows a half-answered question.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.get('/project/:projectId', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const outline = project.outline ?? {};
    const publishing = publishingOf(outline);
    const plan = (outline._volume_plan as Record<string, unknown> | undefined) ?? null;
    const supabase = getSupabaseAdmin();

    // Chapter counts drive everything downstream: the planner needs words, the export needs to know
    // how much is approved, and "ready to publish" is a different question from "written".
    const { count: chapterCount } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('user_id', req.userId!)
      .eq('content_type', 'chapter')
      .is('deleted_at', null);
    const { count: approvedCount } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('user_id', req.userId!)
      .eq('content_type', 'chapter')
      .is('deleted_at', null)
      .in('status', ['approved', 'published']);

    const { data: art } = await supabase
      .from('generated_images_v2')
      .select('id, storage_path, created_at')
      .eq('project_id', project.id)
      .eq('image_type', 'cover_art')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: authorProfile } = await supabase
      .from('author_profiles_v2')
      .select('pen_name, bio, bio_source, why_this_book')
      .eq('user_id', req.userId!)
      .maybeSingle();

    // One marketing entry per planned volume, so the screen can show "volume 2 has no blurb yet"
    // instead of silently showing volume 1's.
    const volumeCount = Math.max(1, Number(plan?.volume_count ?? 1));
    const marketing: Record<string, unknown> = {};
    for (let i = 1; i <= volumeCount; i += 1) {
      marketing[String(i)] = (outline[marketingKey(i)] as unknown) ?? null;
    }

    res.json({
      success: true,
      data: {
        project: { id: project.id, title: project.title, genre_slug: project.genre_slug },
        settings: publishing,
        volume_plan: plan,
        marketing,
        marketing_history: (outline._marketing_history as unknown[]) ?? [],
        author: {
          pen_name: String(authorProfile?.pen_name ?? ''),
          bio: String(authorProfile?.bio ?? ''),
          bio_source: (authorProfile?.bio_source as string | null) ?? null,
          profile_why_this_book: String(authorProfile?.why_this_book ?? ''),
        },
        chapters: { total: chapterCount ?? 0, approved: approvedCount ?? 0 },
        cover_art: art ? { id: art.id, created_at: art.created_at } : null,
        trim_options: Object.entries(TRIM_SIZES).map(([name, t]) => ({ trim: name, ...t })),
        paper_options: Object.keys(PAPER_THICKNESS),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------------------------------------
// The author's choices
// ------------------------------------------------------------------------------------------------

/**
 * @openapi
 * /publishing/project/{projectId}/settings:
 *   put:
 *     tags: [Publishing]
 *     summary: Save the publishing choices (trim, paper, ISBNs, front and back matter)
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.put(
  '/project/:projectId/settings',
  validateBody(SettingsSchema),
  async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const outline: Outline = { ...(project.outline ?? {}) };
      const current = publishingOf(outline);
      const body = req.body as z.infer<typeof SettingsSchema>;

      // Merge rather than replace: a screen that saves the trim size must not erase the ISBN.
      const next_: Publishing = { ...current };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        (next_ as unknown as Record<string, unknown>)[k] = v;
      }
      if (body.isbns) next_.isbns = { ...current.isbns, ...body.isbns };

      outline._publishing = next_;
      await saveOutline(project.id, req.userId!, outline);
      logger.info(
        { userId: req.userId, projectId: project.id, trim: next_.trim, paper: next_.paper },
        'publishing: settings saved',
      );
      res.json({ success: true, data: next_ });
    } catch (err) {
      next(err);
    }
  },
);

// ------------------------------------------------------------------------------------------------
// The volume plan
// ------------------------------------------------------------------------------------------------

/**
 * @openapi
 * /publishing/project/{projectId}/volumes/plan:
 *   post:
 *     tags: [Publishing]
 *     summary: Split the book into printed volumes, choosing breaks on story rather than page count
 *     description: |
 *       Async — the planner reads the closing pages of each candidate break and asks a model how
 *       badly each one leaves the reader hanging. Returns an engine job id to poll at
 *       `/api/jobs/engine/{id}`; the plan is persisted by the engine when it finishes.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post(
  '/project/:projectId/volumes/plan',
  validateBody(PlanVolumesSchema),
  async (req, res) => {
    const project = await loadProject(req, res);
    if (!project) return;
    const body = req.body as z.infer<typeof PlanVolumesSchema>;
    const outline: Outline = { ...(project.outline ?? {}) };
    const settings = publishingOf(outline);
    const trim = body.trim ?? settings.trim;
    const volumeCount = body.volume_count !== undefined ? body.volume_count : settings.volume_count;

    try {
      // The trim used for the plan becomes the project's trim. Otherwise the plan and the interior
      // PDF can disagree about how many pages a volume is, which is how a 900-page volume reaches
      // KDP and is refused.
      if (trim !== settings.trim || volumeCount !== settings.volume_count) {
        outline._publishing = { ...settings, trim, volume_count: volumeCount ?? null };
        await saveOutline(project.id, req.userId!, outline);
      }

      const job = await callEngineWriteTool('chapter', {
        op: 'plan-volumes',
        project_id: project.id,
        user_id: req.userId!,
        trim,
        volume_count: volumeCount ?? undefined,
        judge_endings: body.judge_endings,
        persist: true,
        async: true,
      });
      logger.info(
        { userId: req.userId, projectId: project.id, trim, jobId: job.job_id },
        'publishing: volume plan queued',
      );
      res.status(202).json({
        success: true,
        jobId: job.job_id,
        engineJob: true,
        status: job.status ?? 'queued',
        trim,
      });
    } catch (err) {
      logger.error({ err, projectId: project.id }, 'publishing: volume plan failed');
      res.status(502).json({
        success: false,
        error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
      });
    }
  },
);

// ------------------------------------------------------------------------------------------------
// The listing copy
// ------------------------------------------------------------------------------------------------

/**
 * @openapi
 * /publishing/project/{projectId}/marketing:
 *   post:
 *     tags: [Publishing]
 *     summary: Draft or revise the Amazon listing copy
 *     description: |
 *       With `instructions` this is a REVISION: the previous draft is the baseline and only what the
 *       instructions ask for changes, so the author does not lose the blurb they had already
 *       approved. Without them it writes the first draft from the manuscript. Async; poll
 *       `/api/jobs/engine/{id}`.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post(
  '/project/:projectId/marketing',
  validateBody(MarketingDraftSchema),
  async (req, res) => {
    const project = await loadProject(req, res);
    if (!project) return;
    const body = req.body as z.infer<typeof MarketingDraftSchema>;
    const outline: Outline = { ...(project.outline ?? {}) };
    const settings = publishingOf(outline);
    const volumeIndex = body.volume_index ?? null;
    const key = marketingKey(volumeIndex);
    const previous = (outline[key] as Record<string, unknown> | undefined) ?? null;
    const instructions = (body.instructions ?? '').trim();

    if (instructions && !previous) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NOTHING_TO_REVISE',
          message: 'There is no draft to revise yet. Write the first one, then ask for changes.',
        },
      });
      return;
    }

    try {
      // Snapshot BEFORE the run. The engine persists over the top of the current draft, so if the
      // history were taken afterwards there would be nothing left to compare the revision against.
      if (previous) {
        const history = Array.isArray(outline._marketing_history)
          ? [...(outline._marketing_history as unknown[])]
          : [];
        history.unshift({
          volume_index: volumeIndex ?? 1,
          saved_at: new Date().toISOString(),
          replaced_by: instructions ? 'revision' : 'new draft',
          instructions: instructions || null,
          draft: previous,
        });
        outline._marketing_history = history.slice(0, HISTORY_LIMIT);
        await saveOutline(project.id, req.userId!, outline);
      }

      // Volume-scoped when there is a plan: volume two's blurb must not promise volume one's
      // opening, and the writer only gets volume two's chapters to read.
      const plan = outline._volume_plan as { volume_count?: number; volumes?: Record<string, unknown>[] } | undefined;
      let volume: Record<string, unknown> | undefined;
      if (volumeIndex && plan?.volumes) {
        const v = plan.volumes.find((x) => Number(x.index) === volumeIndex);
        if (v) {
          volume = {
            index: volumeIndex,
            total: plan.volume_count ?? plan.volumes.length,
            first_chapter: v.first_chapter,
            last_chapter: v.last_chapter,
          };
        }
      }

      // The approved bio is a fact, not something for the copywriter to invent. Passed as the
      // author's name so the listing's `author_bio` has something true to fall back on.
      const { data: authorProfile } = await getSupabaseAdmin()
        .from('author_profiles_v2')
        .select('pen_name, bio')
        .eq('user_id', req.userId!)
        .maybeSingle();

      const job = await callEngineWriteTool('chapter', {
        op: 'marketing',
        project_id: project.id,
        user_id: req.userId!,
        author: String(authorProfile?.pen_name ?? ''),
        author_bio: String(authorProfile?.bio ?? '') || undefined,
        volume,
        previous: instructions ? previous : undefined,
        instructions: instructions || undefined,
        trim: settings.trim,
        persist: true,
        async: true,
      });
      logger.info(
        { userId: req.userId, projectId: project.id, volumeIndex, revising: Boolean(instructions), jobId: job.job_id },
        'publishing: marketing queued',
      );
      res.status(202).json({
        success: true,
        jobId: job.job_id,
        engineJob: true,
        status: job.status ?? 'queued',
        revising: Boolean(instructions),
      });
    } catch (err) {
      logger.error({ err, projectId: project.id }, 'publishing: marketing failed');
      res.status(502).json({
        success: false,
        error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
      });
    }
  },
);

/**
 * @openapi
 * /publishing/project/{projectId}/marketing:
 *   put:
 *     tags: [Publishing]
 *     summary: Save a hand edit of the listing copy
 *     description: |
 *       The author's own words win. The previous draft is pushed to history first, and the saved
 *       copy is marked `edited` so a later screen can tell signed-off copy from a draft nobody has
 *       read.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.put(
  '/project/:projectId/marketing',
  validateBody(MarketingEditSchema),
  async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const body = req.body as z.infer<typeof MarketingEditSchema>;
      const outline: Outline = { ...(project.outline ?? {}) };
      const volumeIndex = body.volume_index ?? null;
      const key = marketingKey(volumeIndex);
      const previous = (outline[key] as Record<string, unknown> | undefined) ?? null;

      if (previous) {
        const history = Array.isArray(outline._marketing_history)
          ? [...(outline._marketing_history as unknown[])]
          : [];
        history.unshift({
          volume_index: volumeIndex ?? 1,
          saved_at: new Date().toISOString(),
          replaced_by: 'hand edit',
          instructions: null,
          draft: previous,
        });
        outline._marketing_history = history.slice(0, HISTORY_LIMIT);
      }

      const merged: Record<string, unknown> = { ...(previous ?? {}) };
      for (const [k, v] of Object.entries(body)) {
        if (k === 'volume_index' || v === undefined) continue;
        merged[k] = v;
      }
      merged.keywords = Array.isArray(merged.keywords)
        ? (merged.keywords as string[]).map((s) => s.trim()).filter(Boolean).slice(0, 7)
        : [];
      merged.keyword_slots_used = (merged.keywords as string[]).length;
      merged.categories = Array.isArray(merged.categories)
        ? (merged.categories as string[]).slice(0, 3)
        : [];
      merged.source = 'edited';
      merged.edited_at = new Date().toISOString();
      merged.ok = true;

      outline[key] = merged;
      await saveOutline(project.id, req.userId!, outline);
      logger.info({ userId: req.userId, projectId: project.id, volumeIndex }, 'publishing: marketing edited');
      res.json({ success: true, data: merged });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @openapi
 * /publishing/project/{projectId}/marketing/restore:
 *   post:
 *     tags: [Publishing]
 *     summary: Put a previous draft back
 *     description: A review loop is only safe if it can be undone — otherwise nobody tries a revision.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post(
  '/project/:projectId/marketing/restore',
  validateBody(z.object({ index: z.number().int().min(0).max(HISTORY_LIMIT - 1) })),
  async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const { index } = req.body as { index: number };
      const outline: Outline = { ...(project.outline ?? {}) };
      const history = Array.isArray(outline._marketing_history)
        ? [...(outline._marketing_history as Record<string, unknown>[])]
        : [];
      const entry = history[index];
      if (!entry?.draft) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No such draft' } });
        return;
      }
      const volumeIndex = Number(entry.volume_index ?? 1);
      const key = marketingKey(volumeIndex);
      const current = outline[key];

      // The restore is itself a change, so what it replaced goes to the top of the history. The
      // alternative loses the newer draft the moment somebody looks back at an older one.
      if (current) {
        history.unshift({
          volume_index: volumeIndex,
          saved_at: new Date().toISOString(),
          replaced_by: 'restore',
          instructions: null,
          draft: current,
        });
      }
      outline[key] = { ...(entry.draft as Record<string, unknown>), restored_at: new Date().toISOString() };
      outline._marketing_history = history.slice(0, HISTORY_LIMIT);
      await saveOutline(project.id, req.userId!, outline);
      logger.info({ userId: req.userId, projectId: project.id, index }, 'publishing: marketing restored');
      res.json({ success: true, data: outline[key] });
    } catch (err) {
      next(err);
    }
  },
);

// ------------------------------------------------------------------------------------------------
// What is still missing
// ------------------------------------------------------------------------------------------------

export interface ReadinessFacts {
  outline: Outline | null;
  chapterCount: number;
  authorName: string;
  authorBio: string;
  hasCoverArt: boolean;
}

export interface ReadinessVerdict {
  ready: boolean;
  blockers: string[];
  gaps: string[];
  volume_count: number;
  trim: string;
}

/**
 * What is still missing, split into what stops the upload and what only makes it worse.
 *
 * The split is the whole value. A blocker is something KDP refuses or something that would make
 * the printed book wrong — no description, no cover art, no name on the copyright page. A gap is
 * something that publishes: three keywords instead of seven costs reach, and no dedication costs
 * nothing. Collapsing the two produces a list of nineteen "problems" that nobody reads, which is
 * the same mistake as blocking a chapter on prose clarity because the warning was rare.
 *
 * Pure, so the judgement can be tested without a database behind it.
 */
export function assessReadiness(facts: ReadinessFacts): ReadinessVerdict {
  const outline = facts.outline ?? {};
  const settings = publishingOf(outline);
  const plan = outline._volume_plan as { volume_count?: number } | undefined;
  const volumeCount = Math.max(1, Number(plan?.volume_count ?? 1));
  const blockers: string[] = [];
  const gaps: string[] = [];

  if (!facts.chapterCount) blockers.push('no chapters with text');
  if (!facts.authorName.trim()) {
    blockers.push('author name — the copyright line, the cover and the KDP listing all need it');
  }
  if (!facts.hasCoverArt) {
    blockers.push('no cover art — both the paperback wrap and the ebook cover are built from it');
  }
  if (!facts.authorBio.trim()) {
    gaps.push('author bio — the back cover and Author Central both ask for one');
  }
  if (!plan) gaps.push('volume plan — run the planner to see whether this is one book or three');

  for (let i = 1; i <= volumeCount; i += 1) {
    const m = outline[marketingKey(i)] as Record<string, unknown> | undefined;
    const label = volumeCount > 1 ? `volume ${i}: ` : '';
    if (!m) {
      blockers.push(`${label}no listing copy — KDP will not accept a book with no description`);
      continue;
    }
    if (!String(m.blurb ?? '').trim()) blockers.push(`${label}blurb is empty`);
    const keywords = Array.isArray(m.keywords) ? (m.keywords as string[]) : [];
    if (keywords.length < 7) {
      gaps.push(`${label}${keywords.length} of 7 keyword slots used — the unused ones are free reach`);
    }
    if (!(Array.isArray(m.categories) ? m.categories.length : 0)) {
      gaps.push(`${label}no categories chosen`);
    }
    if (!String(settings.isbns[String(i)] ?? '').trim()) {
      gaps.push(`${label}no ISBN (KDP issues one free for the paperback; ebooks need none)`);
    }
  }

  if (!settings.authors_note.trim()) {
    gaps.push("author's note — for a book built on documented history, close to obligatory");
  }
  if (!settings.publisher.trim()) gaps.push('publisher imprint (optional; your own name is fine)');
  if (!settings.dedication.trim()) gaps.push('dedication (optional)');

  return { ready: blockers.length === 0, blockers, gaps, volume_count: volumeCount, trim: settings.trim };
}

/**
 * @openapi
 * /publishing/project/{projectId}/readiness:
 *   get:
 *     tags: [Publishing]
 *     summary: What is still missing before this can be uploaded to KDP
 *     description: |
 *       Separated into blockers (KDP refuses the upload, or the book is wrong) and gaps (it would
 *       publish, but worse). The distinction is the point: a missing cover stops a paperback, and a
 *       missing dedication stops nothing.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.get('/project/:projectId/readiness', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const supabase = getSupabaseAdmin();

    const { count: total } = await supabase
      .from('published_content_v2')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('user_id', req.userId!)
      .eq('content_type', 'chapter')
      .is('deleted_at', null);

    const { data: authorProfile } = await supabase
      .from('author_profiles_v2')
      .select('pen_name, bio')
      .eq('user_id', req.userId!)
      .maybeSingle();

    const { data: art } = await supabase
      .from('generated_images_v2')
      .select('id')
      .eq('project_id', project.id)
      .eq('image_type', 'cover_art')
      .limit(1)
      .maybeSingle();

    res.json({
      success: true,
      data: assessReadiness({
        outline: project.outline,
        chapterCount: total ?? 0,
        authorName: String(authorProfile?.pen_name ?? ''),
        authorBio: String(authorProfile?.bio ?? ''),
        hasCoverArt: Boolean(art),
      }),
    });
  } catch (err) {
    next(err);
  }
});

export { marketingKey, publishingOf, PUBLISHING_DEFAULTS, type Publishing };

// ------------------------------------------------------------------------------------------------
// Promotion: the writing ABOUT the book, as opposed to the book
// ------------------------------------------------------------------------------------------------
//
// Both of these existed in the engine and could only be reached by asking Eve in conversation. The
// Social tab listed the results and said "use the chat"; the blog writer had no screen at all. That
// is fine as a second way in and hopeless as the only one — a composer with a platform picker and
// the book's own hook already in the box is a different proposition from remembering the sentence
// that makes a router choose the right tool.

const SOCIAL_PLATFORMS = ['twitter', 'linkedin', 'facebook', 'instagram'] as const;

const SocialSchema = z.object({
  platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1).max(4),
  /** What the post is about. Empty falls back to the listing copy, then to the title. */
  about: z.string().max(4000).optional(),
});

const BlogSchema = z.object({
  topic: z.string().min(8, 'Say what the post is about').max(500),
  keywords: z.string().max(500).optional(),
  target_length: z.number().int().min(300).max(5000).optional(),
  /** A headline the author has already decided on. Used verbatim when given. */
  title: z.string().max(300).optional(),
});

/** The book in one paragraph, for a writer that has not read it. */
function bookSummary(project: ProjectRow, outline: Outline): string {
  const m = (outline[marketingKey(1)] as Record<string, unknown> | undefined) ?? {};
  const parts = [
    project.title,
    String(m.hook ?? '').trim(),
    String(m.back_cover ?? m.blurb ?? '').trim(),
  ].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * @openapi
 * /publishing/project/{projectId}/social:
 *   post:
 *     tags: [Publishing]
 *     summary: Write social posts about this book
 *     description: |
 *       Defaults to the book's own hook and back-cover copy, so the posts promise what the listing
 *       promises. Async; the results land in the project's Social tab.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post('/project/:projectId/social', validateBody(SocialSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof SocialSchema>;
  const outline = project.outline ?? {};
  const about = (body.about ?? '').trim() || bookSummary(project, outline);

  if (about.length < 3) {
    res.status(400).json({
      success: false,
      error: {
        code: 'NOTHING_TO_SAY',
        message:
          'Say what the post should be about, or write the listing copy first — a post generated ' +
          'from a title alone is filler.',
      },
    });
    return;
  }

  try {
    const job = await callEngineWriteTool('media', {
      op: 'social-posts',
      project_id: project.id,
      user_id: req.userId!,
      title: project.title,
      platforms: body.platforms,
      summary: about,
      async: true,
    });
    logger.info(
      { userId: req.userId, projectId: project.id, platforms: body.platforms, jobId: job.job_id },
      'publishing: social posts queued',
    );
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'publishing: social posts failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});

/**
 * @openapi
 * /publishing/project/{projectId}/blog:
 *   post:
 *     tags: [Publishing]
 *     summary: Write a blog post about this book or its subject
 *     description: |
 *       Researched and SEO-structured, in the project's genre. Async; the result lands in the
 *       Content Library under Blog Posts.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post('/project/:projectId/blog', validateBody(BlogSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof BlogSchema>;

  try {
    // The author's own name goes with it. Without the book's facts the writer invented a novel to
    // match the title — including an author who does not exist — and published it to the project.
    const { data: authorProfile } = await getSupabaseAdmin()
      .from('author_profiles_v2')
      .select('pen_name')
      .eq('user_id', req.userId!)
      .maybeSingle();

    const job = await callEngineWriteTool('chapter', {
      op: 'blog',
      project_id: project.id,
      user_id: req.userId!,
      author: String(authorProfile?.pen_name ?? ''),
      // The title is how the engine finds this project's research reports: they are filed by
      // topic ("<title> — Chapter N research"), not by a project_id column.
      project_title: project.title,
      topic: body.topic.trim(),
      title: body.title?.trim() || undefined,
      genre_slug: project.genre_slug ?? '',
      keywords: body.keywords?.trim() || '',
      target_length: body.target_length ?? 1500,
      persist: true,
      async: true,
    });
    logger.info(
      { userId: req.userId, projectId: project.id, jobId: job.job_id },
      'publishing: blog post queued',
    );
    // The job's own result carries `pronoun_warning` when the post refers to the author by a
    // pronoun they never set; the client reads it off the completed job.
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'publishing: blog post failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});

export { bookSummary, SOCIAL_PLATFORMS };

// ------------------------------------------------------------------------------------------------
// Reference photographs: real pictures, from named archives, into the project's image archive
// ------------------------------------------------------------------------------------------------

const ImageSearchSchema = z.object({
  q: z.string().min(2).max(300),
  sources: z.array(z.enum(['wikimedia', 'loc', 'smithsonian'])).optional(),
});

const SaveImageSchema = z.object({
  source: z.enum(['wikimedia', 'loc', 'smithsonian']),
  source_id: z.string().max(500),
  image_url: z.string().url(),
  title: z.string().max(500),
  description: z.string().max(2000).optional(),
  creator: z.string().max(500).optional(),
  date_taken: z.string().max(200).optional(),
  institution: z.string().max(500).optional(),
  collection_ref: z.string().max(500).optional(),
  license: z.string().max(300),
  license_url: z.string().max(500).optional(),
  source_page_url: z.string().max(1000).optional(),
  reuse: z.enum(['open', 'check']),
});

/** 25MB. An archival master can be enormous and this is a reference copy, not a print file. */
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

/**
 * @openapi
 * /publishing/project/{projectId}/image-search:
 *   post:
 *     tags: [Publishing]
 *     summary: Search named archives for real photographs
 *     description: |
 *       Not image generation — a catalogue search. Every result carries the holding institution,
 *       the catalogue reference, the photographer, the date and the licence, plus the record page
 *       where a human can check all of it. Archives that failed are reported as failed rather than
 *       silently returning nothing.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post(
  '/project/:projectId/image-search',
  validateBody(ImageSearchSchema),
  async (req, res) => {
    const project = await loadProject(req, res);
    if (!project) return;
    const { q, sources } = req.body as z.infer<typeof ImageSearchSchema>;
    try {
      const result = await searchArchives({ query: q, sources });
      logger.info(
        { userId: req.userId, projectId: project.id, q, found: result.images.length },
        'publishing: archive image search',
      );
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error({ err, projectId: project.id, q }, 'publishing: image search failed');
      res.status(502).json({
        success: false,
        error: { code: 'ARCHIVE_UNREACHABLE', message: err instanceof Error ? err.message : 'Search failed' },
      });
    }
  },
);

/**
 * @openapi
 * /publishing/project/{projectId}/images:
 *   post:
 *     tags: [Publishing]
 *     summary: Save an archival photograph into the project's image archive
 *     description: |
 *       Downloads the file and stores it beside the project's other images, with its provenance in
 *       metadata. Refuses anything not clearly public domain or openly licensed: saving a row means
 *       holding a copy, and holding a copy of something whose rights are unclear is a decision for
 *       the author to make with the archive, not one to take on their behalf.
 *     security: [{ bearerAuth: [] }]
 */
publishingRouter.post('/project/:projectId/images', validateBody(SaveImageSchema), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const body = req.body as z.infer<typeof SaveImageSchema>;

  if (body.reuse !== 'open') {
    res.status(400).json({
      success: false,
      error: {
        code: 'RIGHTS_UNCLEAR',
        message:
          `This record does not state an open licence (${body.license || 'no licence given'}). ` +
          'Ask the holding institution for permission, then add it with the licence they give you. ' +
          'The catalogue link is kept so you can cite it meanwhile.',
      },
    });
    return;
  }

  try {
    const supabase = getSupabaseAdmin();
    const resp = await fetch(body.image_url, {
      headers: { 'user-agent': 'WritersWorkbench/1.0 (archival image research)' },
    });
    if (!resp.ok) {
      res.status(502).json({
        success: false,
        error: { code: 'DOWNLOAD_FAILED', message: `The archive returned ${resp.status} for that file` },
      });
      return;
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES) {
      res.status(413).json({
        success: false,
        error: {
          code: 'TOO_LARGE',
          message: `That file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; the limit is 25MB.`,
        },
      });
      return;
    }
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
    const ext = /png/.test(contentType) ? 'png' : /tiff/.test(contentType) ? 'tiff' : 'jpg';
    const storagePath = `${req.userId}/${project.id}/reference/${crypto.randomUUID()}.${ext}`;

    const upload = await supabase.storage
      .from('cover-images')
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (upload.error) {
      logger.error({ err: upload.error, projectId: project.id }, 'publishing: photo upload failed');
      res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: upload.error.message } });
      return;
    }

    const { data, error } = await supabase
      .from('generated_images_v2')
      .insert({
        user_id: req.userId!,
        project_id: project.id,
        image_type: 'reference_photo',
        storage_path: storagePath,
        image_format: ext,
        file_size_bytes: bytes.length,
        // NOT a prompt — nothing generated this. The field is reused to record what it is.
        original_prompt: body.title,
        // Honest about origin: this is an archival retrieval, not a model's output.
        generation_model: `archive:${body.source}`,
        genre_slug: project.genre_slug ?? null,
        metadata: {
          reference: true,
          source: body.source,
          source_id: body.source_id,
          title: body.title,
          description: body.description ?? '',
          creator: body.creator ?? '',
          date_taken: body.date_taken ?? '',
          institution: body.institution ?? '',
          collection_ref: body.collection_ref ?? '',
          license: body.license,
          license_url: body.license_url ?? '',
          source_page_url: body.source_page_url ?? '',
          retrieved_at: new Date().toISOString(),
        },
      })
      .select('id')
      .single();
    if (error) {
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }

    logger.info(
      { userId: req.userId, projectId: project.id, source: body.source, bytes: bytes.length },
      'publishing: reference photo saved',
    );
    res.status(201).json({ success: true, data: { id: data.id, storage_path: storagePath } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'publishing: save photo failed');
    res.status(502).json({
      success: false,
      error: { code: 'SAVE_FAILED', message: err instanceof Error ? err.message : 'Could not save' },
    });
  }
});
