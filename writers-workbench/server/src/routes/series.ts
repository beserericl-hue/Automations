/**
 * Series: the routes that turn planned volumes into books of a series.
 *
 *   PUT  /api/publishing/project/:projectId/series                         name, book titles, pitch
 *   POST /api/publishing/project/:projectId/series/titles                  suggest titles per book
 *   POST /api/publishing/project/:projectId/series/description             draft the series pitch
 *   POST /api/publishing/project/:projectId/series/books/:index/ending     draft a revised close
 *   POST /api/publishing/project/:projectId/series/books/:index/ending/apply
 *   DELETE /api/publishing/project/:projectId/series/books/:index/ending   discard the draft
 *   POST /api/publishing/project/:projectId/series/books/:index/coda       draft a closing scene (engine job)
 *   PUT  .../series/books/:index/coda          edit the draft's words
 *   POST .../series/books/:index/coda/apply    add it after the book's last chapter, and update the outline
 *   DELETE .../series/books/:index/coda        discard it
 *   POST/PUT/POST apply/DELETE .../series/books/:index/recap   the same for a recap at the front of a book
 *
 * The engine writes the suggestions; it never chooses. A title, a pitch and an ending all reach the
 * book only when the author picks them, and a changed chapter is snapshotted first.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool, callEngineWriteToolSync } from '../lib/engine-hub.js';
import { sendEmail } from '../lib/email.js';
import { pieceAppliedEmail } from '../lib/series-mail.js';
import { logger } from '../lib/logger.js';
import { loadProject, marketingKey, saveOutline } from './publishing.js';
import {
  chapterWithCoda,
  chapterWithRecap,
  outlineWithCoda,
  outlineWithRecap,
  bookTitle,
  plannedBooks,
  seriesName,
  seriesView,
  storedSeries,
  textHash,
  withSeries,
  type CodaDraft,
  type EndingDraft,
  type RecapPiece,
  type TitleSuggestion,
} from '../lib/series.js';

export const seriesRouter = Router();
seriesRouter.use(requireAuth);

type Outline = Record<string, unknown>;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

function marketingOf(outline: Outline, index: number): { hook?: string; blurb?: string } {
  return (outline[marketingKey(index)] as { hook?: string; blurb?: string } | undefined) ?? {};
}

const SeriesSchema = z.object({
  /** null resets to the project title. */
  name: z.string().trim().max(120).nullable().optional(),
  /** Book index -> title. An empty string clears that book's title. */
  titles: z.record(z.string().regex(/^\d+$/), z.string().trim().max(80)).optional(),
  /** Which titles were taken from a suggestion as-is, so the screen can say so. */
  from_suggestion: z.array(z.string().regex(/^\d+$/)).optional(),
  description: z
    .object({ text: z.string().trim().max(3000), tagline: z.string().trim().max(200) })
    .nullable()
    .optional(),
});

seriesRouter.put('/project/:projectId/series', validateBody(SeriesSchema), async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const body = req.body as z.infer<typeof SeriesSchema>;
    const outline: Outline = { ...(project.outline ?? {}) };
    const planned = plannedBooks(outline);
    const now = new Date().toISOString();
    const next_ = withSeries(outline, (s) => {
      const out = { ...s, books: { ...(s.books ?? {}) } };
      if (body.name !== undefined) out.name = body.name?.trim() || undefined;
      for (const [key, title] of Object.entries(body.titles ?? {})) {
        const book = planned.find((b) => String(b.index) === key);
        if (!title) {
          delete out.books[key];
          continue;
        }
        if (!book) continue;
        out.books[key] = {
          title,
          first_chapter: book.first_chapter,
          last_chapter: book.last_chapter,
          source: body.from_suggestion?.includes(key) ? 'suggested' : 'edited',
          chosen_at: now,
        };
      }
      if (body.description !== undefined) {
        out.description = body.description
          ? { ...body.description, source: 'edited', updated_at: now }
          : undefined;
      }
      return out;
    });
    await saveOutline(project.id, req.userId!, next_);
    logger.info({ userId: req.userId, projectId: project.id, titles: Object.keys(body.titles ?? {}) }, 'series: saved');
    res.json({ success: true, data: { series: seriesView(next_, project.title) } });
  } catch (err) {
    next(err);
  }
});

seriesRouter.post('/project/:projectId/series/titles', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline: Outline = { ...(project.outline ?? {}) };
  const books = plannedBooks(outline);
  if (books.length < 2) return fail(res, 400, 'NOT_A_SERIES', 'Plan the books first: there is only one.');
  try {
    const result = await callEngineWriteToolSync<{ ok: boolean; reason?: string; books?: { index: number; candidates: TitleSuggestion[] }[]; dropped?: number }>(
      'chapter',
      {
        op: 'series-titles',
        project_id: project.id,
        user_id: req.userId!,
        series_name: seriesName(outline, project.title),
        books: books.map((b) => ({ index: b.index, first_chapter: b.first_chapter, last_chapter: b.last_chapter, blurb: marketingOf(outline, b.index).blurb ?? '' })),
      },
    );
    if (!result.ok) return fail(res, 422, 'NO_TITLES', result.reason || 'No titles came back.');
    const next_ = withSeries(outline, (s) => ({
      ...s,
      suggestions: Object.fromEntries((result.books ?? []).map((b) => [String(b.index), b.candidates])),
      suggested_at: new Date().toISOString(),
    }));
    await saveOutline(project.id, req.userId!, next_);
    logger.info({ projectId: project.id, dropped: result.dropped }, 'series: titles suggested');
    res.json({ success: true, data: { series: seriesView(next_, project.title), dropped: result.dropped ?? 0 } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'series: title suggestion failed');
    fail(res, 502, 'ENGINE', err instanceof Error ? err.message : 'Engine error');
  }
});

seriesRouter.post('/project/:projectId/series/description', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline: Outline = { ...(project.outline ?? {}) };
  const books = plannedBooks(outline);
  const s = storedSeries(outline);
  if (books.length < 2) return fail(res, 400, 'NOT_A_SERIES', 'Plan the books first: there is only one.');
  try {
    const result = await callEngineWriteToolSync<{ ok: boolean; reason?: string; description?: string; tagline?: string }>('chapter', {
      op: 'series-description',
      user_id: req.userId!,
      series_name: seriesName(outline, project.title),
      books: books.map((b) => ({
        index: b.index,
        title: s.books?.[String(b.index)]?.title ?? '',
        hook: marketingOf(outline, b.index).hook ?? '',
        blurb: marketingOf(outline, b.index).blurb ?? '',
      })),
    });
    if (!result.ok) return fail(res, 422, 'NO_DESCRIPTION', result.reason || 'No description came back.');
    const next_ = withSeries(outline, (st) => ({
      ...st,
      description: { text: result.description ?? '', tagline: result.tagline ?? '', source: 'generated', updated_at: new Date().toISOString() },
    }));
    await saveOutline(project.id, req.userId!, next_);
    res.json({ success: true, data: { series: seriesView(next_, project.title) } });
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'series: description failed');
    fail(res, 502, 'ENGINE', err instanceof Error ? err.message : 'Engine error');
  }
});

function bookIndex(req: Request): number {
  return Number(req.params.index);
}

seriesRouter.post('/project/:projectId/series/books/:index/ending', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline: Outline = { ...(project.outline ?? {}) };
  const books = plannedBooks(outline);
  const index = bookIndex(req);
  const book = books.find((b) => b.index === index);
  if (!book) return fail(res, 404, 'NO_SUCH_BOOK', 'That book is not in the current plan.');
  const next = books.find((b) => b.index === index + 1);
  try {
    const result = await callEngineWriteToolSync<{ ok: boolean; reason?: string } & Omit<EndingDraft, 'drafted_at'>>('chapter', {
      op: 'draft-book-ending',
      project_id: project.id,
      user_id: req.userId!,
      book: { index, first_chapter: book.first_chapter, last_chapter: book.last_chapter },
      next_book: next ? { index: next.index, first_chapter: next.first_chapter, last_chapter: next.last_chapter } : null,
      resolves: book.ending_resolves ?? '',
      carries: book.ending_carries ?? '',
    });
    if (!result.ok) return fail(res, 422, 'NO_ENDING', result.reason || 'No ending came back.');
    const { ok: _ok, reason: _reason, ...draft } = result;
    const next_ = withSeries(outline, (s) => ({
      ...s,
      endings: { ...(s.endings ?? {}), [String(index)]: { ...draft, drafted_at: new Date().toISOString() } },
    }));
    await saveOutline(project.id, req.userId!, next_);
    logger.info({ projectId: project.id, index, words: draft.words, newNames: draft.new_names?.length }, 'series: ending drafted');
    res.json({ success: true, data: { series: seriesView(next_, project.title) } });
  } catch (err) {
    logger.error({ err, projectId: project.id, index }, 'series: ending draft failed');
    fail(res, 502, 'ENGINE', err instanceof Error ? err.message : 'Engine error');
  }
});

seriesRouter.post('/project/:projectId/series/books/:index/ending/apply', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const outline: Outline = { ...(project.outline ?? {}) };
    const index = bookIndex(req);
    const draft = storedSeries(outline).endings?.[String(index)];
    if (!draft) return fail(res, 404, 'NO_DRAFT', 'There is no drafted ending for that book.');
    if (draft.applied_at) return fail(res, 409, 'ALREADY_APPLIED', 'That ending is already in the book.');
    const supabase = getSupabaseAdmin();
    const { data: chapter } = await supabase
      .from('published_content_v2')
      .select('id, content_text')
      .eq('id', draft.content_id)
      .eq('user_id', req.userId!)
      .maybeSingle();
    const text = String(chapter?.content_text ?? '');
    // The chapter must still end the way it did when the draft was written. If it was edited since,
    // splicing at the old offset would cut into whatever replaced it.
    if (!chapter || text.slice(draft.offset) !== draft.current_ending) {
      return fail(res, 409, 'CHAPTER_CHANGED', 'The chapter has changed since this ending was drafted. Draft it again.');
    }
    const { data: last } = await supabase
      .from('content_versions_v2')
      .select('version_number')
      .eq('content_id', draft.content_id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    await supabase.from('content_versions_v2').insert({
      content_id: draft.content_id,
      user_id: req.userId!,
      version_number: ((last?.version_number as number | undefined) ?? 0) + 1,
      content_text: text,
      changed_by: 'series_ending',
      change_note: `Before replacing the close of book ${index} with a revised series ending`,
    });
    const updated = text.slice(0, draft.offset) + draft.new_ending;
    const { error } = await supabase
      .from('published_content_v2')
      .update({ content_text: updated, updated_at: new Date().toISOString() })
      .eq('id', draft.content_id)
      .eq('user_id', req.userId!);
    if (error) throw new Error(error.message);
    const next_ = withSeries(outline, (s) => ({
      ...s,
      endings: { ...(s.endings ?? {}), [String(index)]: { ...draft, applied_at: new Date().toISOString() } },
    }));
    await saveOutline(project.id, req.userId!, next_);
    logger.info({ userId: req.userId, projectId: project.id, index, contentId: draft.content_id }, 'series: ending applied');
    res.json({ success: true, data: { series: seriesView(next_, project.title) } });
  } catch (err) {
    next(err);
  }
});

seriesRouter.delete('/project/:projectId/series/books/:index/ending', async (req, res, next) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const outline: Outline = { ...(project.outline ?? {}) };
    const key = String(bookIndex(req));
    const next_ = withSeries(outline, (s) => {
      const endings = { ...(s.endings ?? {}) };
      delete endings[key];
      return { ...s, endings };
    });
    await saveOutline(project.id, req.userId!, next_);
    res.json({ success: true, data: { series: seriesView(next_, project.title) } });
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------------------------
// Closing scenes and recaps
//
// The engine writes them through the chapter pipeline (a planned chapter-outline entry, research, the
// book's craft, arc and cast, a drift check against the scene's own beat, a QA score) and keeps the draft on
// the project. Nothing reaches the book until the author applies it, after reading it and editing it. Applying
// snapshots the chapter and the outline first, adds the piece, and brings the outline into line with the book.
// ---------------------------------------------------------------------------------------------

const DirectionBody = z.object({ direction: z.string().trim().max(1200).optional() });
const PieceTextBody = z.object({ text: z.string().trim().min(40).max(30000) });

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const range = (b: { index: number; first_chapter: number; last_chapter: number }) => ({
  index: b.index,
  first_chapter: b.first_chapter,
  last_chapter: b.last_chapter,
});

seriesRouter.post('/project/:projectId/series/books/:index/coda', validateBody(DirectionBody), async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline: Outline = { ...(project.outline ?? {}) };
  const books = plannedBooks(outline);
  const index = bookIndex(req);
  const book = books.find((b) => b.index === index);
  if (!book) return fail(res, 404, 'NO_SUCH_BOOK', 'That book is not in the current plan.');
  const next = books.find((b) => b.index === index + 1);
  if (storedSeries(outline).codas?.[String(index)]?.applied_at) {
    return fail(res, 409, 'ALREADY_APPLIED', 'That closing scene is already in the book. Edit the chapter to change it.');
  }
  try {
    const job = await callEngineWriteTool('chapter', {
      op: 'draft-book-coda',
      project_id: project.id,
      user_id: req.userId!,
      book: range(book),
      next_book: next ? range(next) : null,
      direction: (req.body as { direction?: string }).direction ?? '',
      resolves: book.ending_resolves ?? '',
      carries: book.ending_carries ?? '',
      persist: true,
      async: true,
    });
    logger.info({ projectId: project.id, index, jobId: job.job_id }, 'series: closing scene queued');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, projectId: project.id, index }, 'series: closing scene failed to start');
    fail(res, 502, 'ENGINE', err instanceof Error ? err.message : 'Engine error');
  }
});

seriesRouter.post('/project/:projectId/series/books/:index/recap', async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  const outline: Outline = { ...(project.outline ?? {}) };
  const books = plannedBooks(outline);
  const index = bookIndex(req);
  const book = books.find((b) => b.index === index);
  if (!book) return fail(res, 404, 'NO_SUCH_BOOK', 'That book is not in the current plan.');
  const previous = books.filter((b) => b.index < index);
  if (!previous.length) return fail(res, 422, 'FIRST_BOOK', 'The first book has no earlier book to recap.');
  if (storedSeries(outline).recaps?.[String(index)]?.applied_at) {
    return fail(res, 409, 'ALREADY_APPLIED', 'That recap is already in the book. Edit the chapter to change it.');
  }
  try {
    const job = await callEngineWriteTool('chapter', {
      op: 'draft-book-recap',
      project_id: project.id,
      user_id: req.userId!,
      book: range(book),
      previous_books: previous.map(range),
      series_name: seriesName(outline, project.title),
      persist: true,
      async: true,
    });
    logger.info({ projectId: project.id, index, jobId: job.job_id }, 'series: recap queued');
    res.status(202).json({ success: true, jobId: job.job_id, engineJob: true, status: job.status ?? 'queued' });
  } catch (err) {
    logger.error({ err, projectId: project.id, index }, 'series: recap failed to start');
    fail(res, 502, 'ENGINE', err instanceof Error ? err.message : 'Engine error');
  }
});

type PieceKind = 'coda' | 'recap';
const BUCKET: Record<PieceKind, 'codas' | 'recaps'> = { coda: 'codas', recap: 'recaps' };

for (const kind of ['coda', 'recap'] as PieceKind[]) {
  const bucket = BUCKET[kind];
  const noun = kind === 'coda' ? 'closing scene' : 'recap';

  // The author's own words win: the draft's text is replaced, and nothing else about it.
  seriesRouter.put(`/project/:projectId/series/books/:index/${kind}`, validateBody(PieceTextBody), async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const outline: Outline = { ...(project.outline ?? {}) };
      const index = bookIndex(req);
      const piece = storedSeries(outline)[bucket]?.[String(index)] as CodaDraft | RecapPiece | undefined;
      if (!piece || piece.failed) return fail(res, 404, 'NO_DRAFT', `There is no drafted ${noun} for that book.`);
      if (piece.applied_at) return fail(res, 409, 'ALREADY_APPLIED', `That ${noun} is already in the book; edit the chapter.`);
      const text = (req.body as { text: string }).text;
      const next_ = withSeries(outline, (s) => ({
        ...s,
        [bucket]: { ...(s[bucket] ?? {}), [String(index)]: { ...piece, text, words: wordCount(text), edited_at: new Date().toISOString() } },
      }));
      await saveOutline(project.id, req.userId!, next_);
      res.json({ success: true, data: { series: seriesView(next_, project.title) } });
    } catch (err) {
      next(err);
    }
  });

  seriesRouter.delete(`/project/:projectId/series/books/:index/${kind}`, async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const outline: Outline = { ...(project.outline ?? {}) };
      const key = String(bookIndex(req));
      const next_ = withSeries(outline, (s) => {
        const pieces = { ...(s[bucket] ?? {}) };
        delete pieces[key];
        return { ...s, [bucket]: pieces };
      });
      await saveOutline(project.id, req.userId!, next_);
      res.json({ success: true, data: { series: seriesView(next_, project.title) } });
    } catch (err) {
      next(err);
    }
  });

  seriesRouter.post(`/project/:projectId/series/books/:index/${kind}/apply`, async (req, res, next) => {
    try {
      const project = await loadProject(req, res);
      if (!project) return;
      const outline: Outline = { ...(project.outline ?? {}) };
      const index = bookIndex(req);
      const piece = storedSeries(outline)[bucket]?.[String(index)] as CodaDraft | RecapPiece | undefined;
      if (!piece || piece.failed) return fail(res, 404, 'NO_DRAFT', `There is no drafted ${noun} for that book.`);
      if (piece.applied_at) return fail(res, 409, 'ALREADY_APPLIED', `That ${noun} is already in the book.`);
      // A private copy of the outline as it stands: the snapshot and any rollback must not depend on an object
      // that something later in this request might change.
      const originalOutline: Outline = JSON.parse(JSON.stringify(project.outline ?? {}));
      const supabase = getSupabaseAdmin();
      const { data: chapter } = await supabase
        .from('published_content_v2')
        .select('id, content_text')
        .eq('id', piece.content_id)
        .eq('user_id', req.userId!)
        .maybeSingle();
      const text = String(chapter?.content_text ?? '');
      // Written for the chapter as it was. If it has been edited since, the piece may no longer fit it.
      if (!chapter || textHash(text) !== piece.base_hash) {
        return fail(res, 409, 'CHAPTER_CHANGED', `The chapter has changed since this ${noun} was drafted. Draft it again.`);
      }
      const { data: last } = await supabase
        .from('content_versions_v2')
        .select('version_number')
        .eq('content_id', piece.content_id)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { error: chapterSnapError } = await supabase.from('content_versions_v2').insert({
        content_id: piece.content_id,
        user_id: req.userId!,
        version_number: ((last?.version_number as number | undefined) ?? 0) + 1,
        content_text: text,
        changed_by: kind === 'coda' ? 'series_coda' : 'series_recap',
        change_note: `Before adding the ${noun} for book ${index}`,
      });
      // No snapshot, no change: the message promises the earlier text can be taken back.
      if (chapterSnapError) throw new Error(`could not save the chapter's earlier text: ${chapterSnapError.message}`);
      // The outline too: a prior copy is kept so the change can be taken back, then it is brought into line.
      const { data: lastOutline } = await supabase
        .from('outline_versions_v2')
        .select('version_number')
        .eq('project_id', project.id)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { error: outlineSnapError } = await supabase.from('outline_versions_v2').insert({
        user_id: req.userId!,
        project_id: project.id,
        version_number: ((lastOutline?.version_number as number | undefined) ?? 0) + 1,
        outline: originalOutline,
        revision_note: `Before adding the ${noun} for book ${index}`,
      });
      if (outlineSnapError) throw new Error(`could not save the outline's earlier version: ${outlineSnapError.message}`);
      const updated =
        kind === 'coda'
          ? chapterWithCoda(text, piece.text)
          : chapterWithRecap(text, seriesName(outline, project.title), piece.text);
      const withText = kind === 'coda' ? outlineWithCoda(outline, piece as CodaDraft) : outlineWithRecap(outline, piece.chapter_number);
      const next_ = withSeries(withText, (s) => ({
        ...s,
        [bucket]: { ...(s[bucket] ?? {}), [String(index)]: { ...piece, applied_at: new Date().toISOString() } },
      }));
      // The outline first: saving it checks the new outline against its schema and throws before anything has
      // changed. The chapter is written last, and if that fails the outline is put back, so the two never
      // disagree about what the book holds.
      await saveOutline(project.id, req.userId!, next_);
      const { error } = await supabase
        .from('published_content_v2')
        .update({ content_text: updated, updated_at: new Date().toISOString() })
        .eq('id', piece.content_id)
        .eq('user_id', req.userId!);
      if (error) {
        await saveOutline(project.id, req.userId!, originalOutline).catch((e) =>
          logger.error({ err: e, projectId: project.id }, 'series: outline could not be put back after a failed apply'),
        );
        throw new Error(error.message);
      }
      logger.info({ userId: req.userId, projectId: project.id, index, kind, contentId: piece.content_id }, 'series: piece applied');
      // Told in writing, with the words in the message. Best-effort: the change is made whether or not mail goes.
      try {
        const { data: user } = await supabase.from('users_v2').select('email').eq('user_id', req.userId!).maybeSingle();
        const to = String((user as { email?: string } | null)?.email ?? '').trim();
        if (to) {
          const sameChapter = (outline.chapters as Record<string, unknown>[] | undefined)?.find((c) => String(c?.chapter_number) === String(piece.chapter_number));
          const subs = (sameChapter?.chapter_outline as { sub_chapters?: unknown[] } | null | undefined)?.sub_chapters;
          const coda = piece as CodaDraft;
          const changes =
            kind === 'coda'
              ? [
                  coda.outline_beat ? `Chapter ${piece.chapter_number}'s outline beat now includes: ${coda.outline_beat}` : '',
                  Array.isArray(subs) && subs.length ? `Chapter ${piece.chapter_number}'s chapter outline gained the scene as sub-chapter ${subs.length + 1}` : '',
                  coda.next_chapter_number != null && coda.next_bridge ? `Chapter ${coda.next_chapter_number} now records how it picks up: ${coda.next_bridge}` : '',
                ].filter(Boolean)
              : [`Chapter ${piece.chapter_number}'s outline now notes that it opens with a recap of the previous book`];
          const checks =
            kind === 'coda'
              ? [
                  coda.hook ? `ends on: ${coda.hook}` : '',
                  coda.research_topics?.length ? `researched: ${coda.research_topics.join(', ')}` : '',
                  `drift check: ${(coda.drift as { findings?: unknown[] } | null)?.findings?.length ? `${(coda.drift as { findings: unknown[] }).findings.length} finding(s) corrected or noted` : 'no drift found'}`,
                  piece.new_names?.length ? `names not yet in the book: ${piece.new_names.join(', ')}` : 'no names outside the book',
                ].filter(Boolean)
              : [`drawn from ${(piece as RecapPiece).sources} chapters of the earlier books`, piece.new_names?.length ? `names not yet in the book: ${piece.new_names.join(', ')}` : 'no names outside the earlier books'];
          const base = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, '') ?? '';
          const mail = pieceAppliedEmail({
            kind, bookIndex: index, bookTitle: bookTitle(outline, index), seriesTitle: seriesName(outline, project.title),
            chapterNumber: piece.chapter_number, chapterTitle: piece.chapter_title, text: piece.text, words: piece.words,
            outlineChanges: changes, checks, link: base ? `${base}/projects/${project.id}/publish` : '',
          });
          await sendEmail({ to, ...mail });
        }
      } catch (err) {
        logger.warn({ err, projectId: project.id, index, kind }, 'series: the change email could not be sent');
      }
      res.json({ success: true, data: { series: seriesView(next_, project.title) } });
    } catch (err) {
      next(err);
    }
  });
}
