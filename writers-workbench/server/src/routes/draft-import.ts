/**
 * Import a human-edited Word draft back into a project, chapter by chapter.
 *
 *   POST /api/draft-import/project/:id/preview   (multipart `file`)  what would happen, changing nothing
 *   POST /api/draft-import/project/:id/apply     (multipart `file`)  do it, then queue a Q/A run per chapter
 *
 * Chapters are matched by chapter number and the book divisions are never touched. A chapter that is
 * still a draft has its text replaced. A chapter that is approved, published, scheduled or rejected is
 * preserved: its current text is kept in version history, the editor's text becomes the newer version
 * and the chapter goes back to draft until the Q/A passes and the author approves it again. A chapter
 * in the file that the project does not have is added (a partly written project fills in).
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteTool } from '../lib/engine-hub.js';
import { getCreditCost } from '../services/credit-costs.js';
import { chargeCredits, refuseIfInsufficient } from '../lib/credit-charge.js';
import { chaptersFromDocx, type ImportedChapter } from '../lib/draft-import.js';
import { logger } from '../lib/logger.js';

export const draftImportRouter = Router();
draftImportRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new Error('NOT_DOCX'));
  },
});

type Action = 'replace' | 'new_version' | 'add';
interface Existing {
  id: string;
  chapter_number: number;
  title: string | null;
  status: string;
  content_text: string | null;
}
export interface PlanItem {
  chapter_number: number;
  title: string;
  words: number;
  action: Action;
  status: string | null;
  existing_words: number;
  /** The saved chapter has formatting blocks (letters, poems) that Word cannot carry back. */
  has_blocks: boolean;
}

const wordCount = (t: string | null) => (t && t.trim() ? t.trim().split(/\s+/).length : 0);

async function loadExisting(projectId: string, userId: string): Promise<Map<number, Existing>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<number, Existing>();
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('published_content_v2')
      .select('id, chapter_number, title, status, content_text, updated_at')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('content_type', 'chapter')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Existing[]) if (r.chapter_number != null && !map.has(r.chapter_number)) map.set(r.chapter_number, r);
    if ((data ?? []).length < 1000) break;
  }
  return map;
}

function planOf(chapters: ImportedChapter[], existing: Map<number, Existing>): PlanItem[] {
  return chapters.map((c) => {
    const e = existing.get(c.chapter_number);
    return {
      chapter_number: c.chapter_number,
      title: c.title || e?.title || '',
      words: c.words,
      action: !e ? 'add' : e.status === 'draft' ? 'replace' : 'new_version',
      status: e?.status ?? null,
      existing_words: wordCount(e?.content_text ?? null),
      has_blocks: Boolean(e?.content_text && /:::block|data-format-block/.test(e.content_text)),
    };
  });
}

async function readUpload(req: Request, res: Response): Promise<{ project: { id: string; title: string; genre_slug: string | null }; chapters: ImportedChapter[] } | null> {
  const supabase = getSupabaseAdmin();
  const { data: project } = await supabase
    .from('writing_projects_v2')
    .select('id, title, genre_slug')
    .eq('id', String(req.params.id))
    .eq('user_id', req.userId!)
    .is('deleted_at', null)
    .maybeSingle();
  if (!project) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
    return null;
  }
  if (!req.file) {
    res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'Choose the edited Word file (.docx).' } });
    return null;
  }
  let chapters: ImportedChapter[];
  try {
    chapters = await chaptersFromDocx(req.file.buffer);
  } catch (err) {
    logger.warn({ err }, 'draft-import: unreadable docx');
    res.status(422).json({ success: false, error: { code: 'UNREADABLE', message: 'That file could not be read as a Word document.' } });
    return null;
  }
  if (!chapters.length) {
    res.status(422).json({
      success: false,
      error: { code: 'NO_CHAPTERS_IN_FILE', message: 'No chapters found. Each chapter must start at a heading like "Chapter 12: Title", "Prologue" or "Epilogue".' },
    });
    return null;
  }
  return { project: project as { id: string; title: string; genre_slug: string | null }, chapters };
}

const withUpload = (req: Request, res: Response, next: (err?: unknown) => void) =>
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const notDocx = err instanceof Error && err.message === 'NOT_DOCX';
      res.status(400).json({ success: false, error: { code: notDocx ? 'NOT_DOCX' : 'UPLOAD_FAILED', message: notDocx ? 'Only .docx files can be imported.' : 'The file could not be uploaded (40 MB limit).' } });
      return;
    }
    next();
  });

draftImportRouter.post('/project/:id/preview', withUpload, async (req, res) => {
  try {
    const got = await readUpload(req, res);
    if (!got) return;
    const existing = await loadExisting(got.project.id, req.userId!);
    const items = planOf(got.chapters, existing);
    const qaCost = await getCreditCost('qa_chapter');
    res.json({
      success: true,
      data: {
        items,
        counts: {
          replace: items.filter((i) => i.action === 'replace').length,
          new_version: items.filter((i) => i.action === 'new_version').length,
          add: items.filter((i) => i.action === 'add').length,
          untouched: [...existing.keys()].filter((n) => !got.chapters.some((c) => c.chapter_number === n)).length,
        },
        qa_cost_each: qaCost,
        qa_cost_total: qaCost * items.length,
        credits_remaining: req.creditsRemaining ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'draft-import: preview failed');
    res.status(500).json({ success: false, error: { code: 'PREVIEW_FAILED', message: 'Could not read the draft.' } });
  }
});

async function nextVersion(contentId: string): Promise<number> {
  const { data } = await getSupabaseAdmin()
    .from('content_versions_v2')
    .select('version_number, content_text')
    .eq('content_id', contentId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.version_number as number | undefined) ?? 0) + 1;
}

async function latestVersionText(contentId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from('content_versions_v2')
    .select('content_text')
    .eq('content_id', contentId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.content_text as string | undefined) ?? null;
}

draftImportRouter.post('/project/:id/apply', withUpload, async (req, res) => {
  const userId = req.userId!;
  try {
    const got = await readUpload(req, res);
    if (!got) return;
    const runQa = String(req.body?.run_qa ?? 'true') !== 'false';
    const qaCost = runQa ? await getCreditCost('qa_chapter') : 0;
    if (refuseIfInsufficient(req, res, qaCost * got.chapters.length)) return;

    const supabase = getSupabaseAdmin();
    const existing = await loadExisting(got.project.id, userId);
    const results: Array<PlanItem & { content_id: string | null; error?: string; qa_job?: string; qa_error?: string }> = [];
    const plan = planOf(got.chapters, existing);

    for (const [i, c] of got.chapters.entries()) {
      const item = plan[i];
      const e = existing.get(c.chapter_number);
      try {
        let contentId: string;
        if (e) {
          // Keep what is there before it is replaced (unless the history already ends with it).
          if (e.content_text && e.content_text.trim() && (await latestVersionText(e.id)) !== e.content_text) {
            await supabase.from('content_versions_v2').insert({
              content_id: e.id,
              user_id: userId,
              version_number: await nextVersion(e.id),
              content_text: e.content_text,
              changed_by: 'draft_import',
              change_note: `Before importing the edited draft (was ${e.status})`,
            });
          }
          const { error } = await supabase
            .from('published_content_v2')
            .update({ content_text: c.text, status: 'draft', updated_at: new Date().toISOString() })
            .eq('id', e.id)
            .eq('user_id', userId);
          if (error) throw new Error(error.message);
          contentId = e.id;
        } else {
          const { data: row, error } = await supabase
            .from('published_content_v2')
            .insert({
              user_id: userId,
              title: c.title || (c.chapter_number === 0 ? 'Prologue' : c.chapter_number === 999 ? 'Epilogue' : `Chapter ${c.chapter_number}`),
              content_type: 'chapter',
              genre_slug: got.project.genre_slug,
              content_text: c.text,
              status: 'draft',
              project_id: got.project.id,
              chapter_number: c.chapter_number,
              metadata: { imported_from: 'draft_import' },
            })
            .select('id')
            .single();
          if (error || !row) throw new Error(error?.message ?? 'insert failed');
          contentId = row.id as string;
        }
        await supabase.from('content_versions_v2').insert({
          content_id: contentId,
          user_id: userId,
          version_number: await nextVersion(contentId),
          content_text: c.text,
          changed_by: 'draft_import',
          change_note: e ? `Edited draft imported (${e.status === 'draft' ? 'replaced the draft' : `kept the ${e.status} text as the version before`})` : 'Added from an edited draft',
        });
        const out: (typeof results)[number] = { ...item, content_id: contentId };
        if (runQa) {
          try {
            const job = await callEngineWriteTool('chapter', {
              op: 'qa',
              project_id: got.project.id,
              chapter_number: c.chapter_number,
              user_id: userId,
              persist: true,
              async: true,
            });
            await chargeCredits(req, res, qaCost, 'draft-import:qa_chapter', job.job_id);
            out.qa_job = job.job_id;
          } catch (err) {
            out.qa_error = err instanceof Error ? err.message : 'Q/A could not be started';
          }
        }
        results.push(out);
      } catch (err) {
        results.push({ ...item, content_id: null, error: err instanceof Error ? err.message : 'failed' });
      }
    }
    logger.info({ userId, projectId: got.project.id, chapters: results.length, failed: results.filter((r) => r.error).length }, 'draft-import: applied');
    res.json({
      success: true,
      data: {
        results,
        imported: results.filter((r) => !r.error).length,
        failed: results.filter((r) => r.error).length,
        qa_started: results.filter((r) => r.qa_job).length,
        qa_failed: results.filter((r) => r.qa_error).length,
      },
    });
  } catch (err) {
    logger.error({ err, userId }, 'draft-import: apply failed');
    res.status(500).json({ success: false, error: { code: 'IMPORT_FAILED', message: 'The import failed before it finished. Check the chapter list: chapters already done are saved.' } });
  }
});
