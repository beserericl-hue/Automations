/**
 * The author profile, and the bio written from it.
 *
 * WHY THIS EXISTS. A blurb can be written from a manuscript; a bio cannot. Every line of a bio is a
 * fact about a person — where they live, what they did before, what connects them to the material —
 * and a model asked for one without those facts either invents a career or writes "this is his debut
 * novel". The first is a false claim printed in a book, and it happened here: the first bio this
 * system produced was built on facts typed into a scratch script by hand, which is to say invented.
 *
 * So the facts get a home. `author_profiles_v2` (migration 032) holds them, one row per user, and
 * the generator reads that row rather than a parameter somebody filled in once. The approved bio is
 * stored beside them, because the reviewed output and the raw input are different things: the bio is
 * what the back cover prints, and `bio_source` says whether a human has signed off on it.
 *
 * Routes:
 *   GET  /api/author/profile   — the facts and the approved bio
 *   PUT  /api/author/profile   — save the facts
 *   POST /api/author/bio       — draft a bio from them (optionally with an instruction)
 *   PUT  /api/author/bio       — approve the bio, generated or hand-written
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteToolSync } from '../lib/engine-hub.js';
import { logger } from '../lib/logger.js';

export const authorRouter = Router();
authorRouter.use(requireAuth);

const TABLE = 'author_profiles_v2';

/** The columns the client may write. `bio*` is deliberately absent — it has its own endpoint. */
const FACT_COLUMNS = [
  'pen_name',
  'pronouns',
  'lives',
  'background',
  'credentials',
  'prior_work',
  'why_this_book',
  'personal',
  'links',
] as const;

const text = z.string().max(4000).optional();
const list = z.array(z.string().min(1).max(500)).max(25).optional();

const ProfileSchema = z.object({
  pen_name: z.string().max(200).optional(),
  pronouns: z.string().max(40).optional(),
  lives: z.string().max(300).optional(),
  background: text,
  credentials: list,
  prior_work: list,
  why_this_book: text,
  personal: text,
  links: z.array(z.string().max(500)).max(15).optional(),
});

const BioDraftSchema = z.object({
  /** A free-text steer: "mention the dig", "shorter", "drop the degree". */
  instructions: z.string().max(2000).optional(),
  /**
   * Draft for one project, so "why this book" is that book's reason rather than the profile
   * default. The project's own override wins when it has one.
   */
  project_id: z.string().uuid().optional(),
});

const BioApproveSchema = z.object({
  bio: z.string().max(4000),
  /** 'edited' when the author changed a word of it. The difference matters at publish time. */
  source: z.enum(['generated', 'edited']).default('edited'),
});

/** An empty profile is a valid state, not an error — the UI needs a form either way. */
const EMPTY = {
  pen_name: '',
  pronouns: '',
  lives: '',
  background: '',
  credentials: [] as string[],
  prior_work: [] as string[],
  why_this_book: '',
  personal: '',
  links: [] as string[],
  bio: '',
  bio_source: null as string | null,
  bio_updated_at: null as string | null,
};

type ProfileRow = Record<string, unknown> | null;

/**
 * Postgres' code for "that table does not exist".
 *
 * Worth handling by name: without it, a deploy that lands before migration 032 is applied answers
 * every request on this screen with an opaque 500, and the author is left guessing whether their
 * facts failed to save or were never storable in the first place.
 */
const UNDEFINED_TABLE = '42P01';

class MigrationPending extends Error {}

async function loadProfile(userId: string): Promise<ProfileRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (error.code === UNDEFINED_TABLE) throw new MigrationPending(error.message);
    throw new Error(error.message);
  }
  return data ?? null;
}

/** Answer a missing-table failure plainly. Returns false for anything else, to be re-thrown. */
function handleProfileError(err: unknown, res: Response): boolean {
  if (!(err instanceof MigrationPending)) return false;
  res.status(503).json({
    success: false,
    error: {
      code: 'MIGRATION_PENDING',
      message:
        'The author profile table does not exist yet. Apply migration ' +
        '032_author_profiles.sql to this database, then reload.',
    },
  });
  return true;
}

function shape(row: ProfileRow): typeof EMPTY {
  if (!row) return { ...EMPTY };
  const str = (k: string): string => String(row[k] ?? '');
  const arr = (k: string): string[] => (Array.isArray(row[k]) ? (row[k] as string[]) : []);
  return {
    pen_name: str('pen_name'),
    pronouns: str('pronouns'),
    lives: str('lives'),
    background: str('background'),
    credentials: arr('credentials'),
    prior_work: arr('prior_work'),
    why_this_book: str('why_this_book'),
    personal: str('personal'),
    links: arr('links'),
    bio: str('bio'),
    bio_source: (row.bio_source as string | null) ?? null,
    bio_updated_at: (row.bio_updated_at as string | null) ?? null,
  };
}

/**
 * What the bio still has no way of knowing, in the order it costs the reader.
 *
 * Reported alongside a draft rather than blocking it: a thin honest bio is publishable, and the
 * author is the only one who can close these gaps. The engine returns its own list; this one is for
 * the form, before anything is generated.
 */
/**
 * Is there anything here a bio could actually be written from?
 *
 * The name is excluded on purpose, and this mirrors `AuthorProfile.is_empty()` in the engine. A bio
 * built from a name alone is a bio about nobody, and the gap gets filled with a plausible career —
 * which is exactly the failure this whole screen exists to prevent. Exported so the rule has one
 * definition and the UI can disable the button for the same reason the server would refuse.
 */
export function hasSubstantiveFacts(p: {
  lives: string;
  background: string;
  why_this_book: string;
  personal: string;
  credentials: string[];
  prior_work: string[];
}): boolean {
  return Boolean(
    p.lives.trim() ||
      p.background.trim() ||
      p.why_this_book.trim() ||
      p.personal.trim() ||
      p.credentials.length ||
      p.prior_work.length,
  );
}

function gapsIn(p: typeof EMPTY): string[] {
  const gaps: string[] = [];
  if (!p.pen_name.trim()) gaps.push('the name to publish under — the bio has nothing to call you');
  if (!p.background.trim()) {
    gaps.push('background — what you did before this book, especially where it touches the material');
  }
  if (!p.why_this_book.trim()) {
    gaps.push('why this book — your connection to the subject; this is the sentence readers want');
  }
  if (!p.pronouns.trim()) {
    gaps.push(
      'pronouns (optional) — without them the bio uses your surname throughout rather than guessing',
    );
  }
  if (!p.lives.trim()) gaps.push('where you live (optional, conventional)');
  if (!p.personal.trim()) gaps.push('one human detail (optional) — it stops the bio reading as a CV');
  return gaps;
}

/**
 * @openapi
 * /author/profile:
 *   get:
 *     tags: [Author]
 *     summary: The facts a bio is written from, plus the approved bio
 *     security: [{ bearerAuth: [] }]
 */
authorRouter.get('/profile', async (req, res, next) => {
  try {
    const profile = shape(await loadProfile(req.userId!));
    res.json({ success: true, data: { ...profile, gaps: gapsIn(profile) } });
  } catch (err) {
    if (!handleProfileError(err, res)) next(err);
  }
});

/**
 * @openapi
 * /author/profile:
 *   put:
 *     tags: [Author]
 *     summary: Save the author's facts (upsert; one row per user)
 *     security: [{ bearerAuth: [] }]
 */
authorRouter.put('/profile', validateBody(ProfileSchema), async (req, res, next) => {
  try {
    const userId = req.userId!;
    const body = req.body as z.infer<typeof ProfileSchema>;
    const supabase = getSupabaseAdmin();

    // Only the keys actually sent are written, so a form that edits one field cannot blank the rest.
    const patch: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
    for (const col of FACT_COLUMNS) {
      const value = (body as Record<string, unknown>)[col];
      if (value === undefined) continue;
      patch[col] = Array.isArray(value)
        ? value.map((v) => String(v).trim()).filter(Boolean)
        : String(value).trim();
    }

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(patch, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) {
      if (error.code === UNDEFINED_TABLE) {
        handleProfileError(new MigrationPending(error.message), res);
        return;
      }
      logger.error({ err: error, userId }, 'author: profile save failed');
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }
    const profile = shape(data);
    res.json({ success: true, data: { ...profile, gaps: gapsIn(profile) } });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /author/bio:
 *   post:
 *     tags: [Author]
 *     summary: Draft a bio from the stored facts
 *     description: |
 *       Synchronous — a bio is a few hundred tokens. Returns the draft and `gaps`, and is NOT saved:
 *       the author approves it with PUT /author/bio. Refuses with ok:false when there are no facts
 *       at all, because the alternative is a model inventing a career.
 *     security: [{ bearerAuth: [] }]
 */
authorRouter.post('/bio', validateBody(BioDraftSchema), async (req, res) => {
  const userId = req.userId!;
  try {
    const { instructions, project_id: projectId } = req.body as z.infer<typeof BioDraftSchema>;
    const profile = shape(await loadProfile(userId));

    // A project's own "why this book" beats the profile default: the second novel is about
    // something else, and a bio that leads with the first book's reason is wrong on the back cover.
    let whyThisBook = profile.why_this_book;
    let projectTitle = '';
    if (projectId) {
      const supabase = getSupabaseAdmin();
      const { data: project } = await supabase
        .from('writing_projects_v2')
        .select('id, title, outline')
        .eq('id', projectId)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .maybeSingle();
      if (!project) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
        return;
      }
      projectTitle = String(project.title ?? '');
      const override = String(
        ((project.outline as Record<string, unknown> | null)?._why_this_book as string) ?? '',
      ).trim();
      if (override) whyThisBook = override;
    }

    // A NAME IS NOT A FACT. Deliberately excluded, matching the engine's own rule: given only a
    // name, a bio writer has nothing to say about the person and fills the gap with a career. So
    // the gate is the same on both sides — otherwise the button is enabled, the request is sent,
    // and the engine refuses it, which reads as a bug rather than as the answer it is.
    if (!hasSubstantiveFacts({ ...profile, why_this_book: whyThisBook })) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_FACTS',
          message:
            'A bio cannot be written from the manuscript, and a name on its own is not enough to ' +
            'write one from. Add your background or what connects you to this book.',
        },
        data: { gaps: gapsIn(profile) },
      });
      return;
    }

    // Sync, and unwrapped: the orchestrator answers a synchronous call with a step envelope, so
    // reading `ok` off the raw response yields undefined and every bio looks like a refusal.
    const result = await callEngineWriteToolSync<{
      ok?: boolean;
      author_bio?: string;
      reason?: string;
      gaps?: string[];
      pronoun_warning?: string;
    }>('chapter', {
      op: 'author-bio',
      user_id: userId,
      instructions: instructions || undefined,
      profile: {
        name: profile.pen_name,
        pronouns: profile.pronouns,
        lives: profile.lives,
        background: profile.background,
        credentials: profile.credentials,
        prior_work: profile.prior_work,
        why_this_book: whyThisBook,
        personal: profile.personal,
        links: profile.links,
      },
      project_title: projectTitle || undefined,
    });

    // An empty bio is NOT a success, whatever the engine reported. Asked for a bio from facts too
    // thin to say anything with, the writer is told to stay short rather than pad — and it can come
    // back with nothing at all. Reporting that as ok would tell the screen the operation worked
    // while handing it a blank paragraph to display.
    const bio = String(result.author_bio ?? '').trim();
    const ok = result.ok !== false && bio.length > 0;
    const reason =
      (result.reason as string | undefined) ??
      (ok
        ? null
        : 'There is not enough here to write a bio from. Add your background, or what connects ' +
          'you to this book.');

    logger.info(
      { userId, projectId, ok, chars: bio.length, revised: Boolean(instructions) },
      'author: bio drafted',
    );
    res.json({
      success: true,
      data: {
        ok,
        bio,
        reason,
        gaps: Array.isArray(result.gaps) ? result.gaps : gapsIn(profile),
        // Set when the writer referred to the author by a pronoun they never supplied and a
        // corrective pass did not remove it. Passed through rather than swallowed: the author is
        // the only one who can say whether it is right, and it is headed for a cover.
        pronoun_warning: result.pronoun_warning ?? null,
        why_this_book_used: whyThisBook,
      },
    });
  } catch (err) {
    if (handleProfileError(err, res)) return;
    logger.error({ err, userId }, 'author: bio draft failed');
    res.status(502).json({
      success: false,
      error: { code: 'ENGINE_UNREACHABLE', message: err instanceof Error ? err.message : 'Engine error' },
    });
  }
});

/**
 * @openapi
 * /author/bio:
 *   put:
 *     tags: [Author]
 *     summary: Approve a bio — generated as-is, or edited by hand
 *     security: [{ bearerAuth: [] }]
 */
authorRouter.put('/bio', validateBody(BioApproveSchema), async (req, res, next) => {
  try {
    const userId = req.userId!;
    const { bio, source } = req.body as z.infer<typeof BioApproveSchema>;
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, bio: bio.trim(), bio_source: source, bio_updated_at: now, updated_at: now },
        { onConflict: 'user_id' },
      )
      .select('*')
      .single();
    if (error) {
      if (error.code === UNDEFINED_TABLE) {
        handleProfileError(new MigrationPending(error.message), res);
        return;
      }
      res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
      return;
    }
    logger.info({ userId, source, chars: bio.trim().length }, 'author: bio approved');
    const profile = shape(data);
    res.json({ success: true, data: { ...profile, gaps: gapsIn(profile) } });
  } catch (err) {
    next(err);
  }
});
