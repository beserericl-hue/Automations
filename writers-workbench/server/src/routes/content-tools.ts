/**
 * The editor's working tools, beside Q/A and Review in a chapter's side rail: characters across the
 * whole book, and the humanizer.
 *
 * CHARACTERS. A chapter is read alone, but a character is not. To see what the book says about
 * someone you need every place the name is used, in every chapter, in context — and to rename them,
 * a rename that touches only the uses you chose (see manuscript-tools.ts for why "Seven" made that
 * necessary). The consistency check and the name suggestions use a model; both are checked here
 * before anything reaches the author: a finding must quote the chapters word for word, and a
 * suggested name must quote the project's own research.
 *
 * HUMANIZER. One selected passage through StealthGPT, via the engine's existing client (which keeps
 * the passage's names, re-applies the dash ban, and falls back to the original). Nothing is written
 * until the author chooses to replace; then the chapter is snapshotted first, like any other change.
 *
 * Routes (all under /api/content/:id):
 *   GET  /characters                  — who appears in this chapter
 *   GET  /characters/threads?name=    — every use of a name across the book
 *   POST /characters/check            — contradictions and ambiguity, each with its quotes
 *   POST /characters/suggest          — names the research supports
 *   POST /characters/rename           — rename at the uses the author ticked
 *   POST /humanize                    — a passage through StealthGPT (nothing saved)
 *   POST /humanize/apply              — replace the passage with the chosen version
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { callEngineWriteToolSync } from '../lib/engine-hub.js';
import { logger } from '../lib/logger.js';
import { parseWith } from '../lib/claude-structured.js';
import { normalize, rankResearch, type ResearchReport } from '../lib/landing-page.js';
import { applyRename, findMentions, nameAmbiguity, namesInText, type Mention } from '../lib/manuscript-tools.js';

export const contentToolsRouter = Router();
contentToolsRouter.use(requireAuth);

interface ChapterRow {
  id: string;
  project_id: string | null;
  chapter_number: number | null;
  title: string | null;
  content_text: string | null;
}

async function loadChapter(req: Request, res: Response): Promise<ChapterRow | null> {
  const { data } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('id, project_id, chapter_number, title, content_text')
    .eq('id', String(req.params.id))
    .eq('user_id', req.userId!)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Content not found' } });
    return null;
  }
  return data as ChapterRow;
}

/** Every chapter of the book this chapter belongs to, in order; just this one when it has no project. */
async function bookChapters(userId: string, chapter: ChapterRow): Promise<ChapterRow[]> {
  if (!chapter.project_id) return [chapter];
  const { data } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('id, project_id, chapter_number, title, content_text')
    .eq('user_id', userId)
    .eq('project_id', chapter.project_id)
    .eq('content_type', 'chapter')
    .is('deleted_at', null)
    .order('chapter_number', { ascending: true });
  return (data ?? []) as ChapterRow[];
}

interface Thread {
  content_id: string;
  chapter_number: number | null;
  title: string | null;
  mentions: Mention[];
}

function threadsFor(chapters: ChapterRow[], name: string, span = 160): Thread[] {
  return chapters
    .map((c) => ({ content_id: c.id, chapter_number: c.chapter_number, title: c.title, mentions: findMentions(c.content_text ?? '', name, c.id, span) }))
    .filter((t) => t.mentions.length > 0);
}

async function sendError(res: Response, err: unknown, code: string, what: string): Promise<void> {
  logger.error({ err }, `content-tools: ${what} failed`);
  res.status(502).json({ success: false, error: { code, message: err instanceof Error ? err.message : `${what} failed` } });
}

const NameQuery = z.object({ name: z.string().trim().min(2).max(80) });

// ------------------------------------------------------------------------------------------------
// Characters
// ------------------------------------------------------------------------------------------------

contentToolsRouter.get('/:id/characters', async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const text = chapter.content_text ?? '';
  const supabase = getSupabaseAdmin();
  const listed = new Map<string, { name: string; source: string; description: string }>();

  if (chapter.project_id) {
    const [{ data: project }, { data: bible }] = await Promise.all([
      supabase.from('writing_projects_v2').select('outline').eq('id', chapter.project_id).eq('user_id', req.userId!).maybeSingle(),
      supabase
        .from('story_bible_v2')
        .select('name, description')
        .eq('project_id', chapter.project_id)
        .eq('entry_type', 'character')
        .is('deleted_at', null)
        .limit(2000),
    ]);
    const cast = ((project?.outline as { characters?: Array<{ name?: string; description?: string }> } | null)?.characters ?? []);
    for (const c of cast) {
      if (c.name && findMentions(text, c.name, chapter.id).length) listed.set(c.name, { name: c.name, source: 'cast', description: c.description ?? '' });
    }
    for (const b of (bible ?? []) as Array<{ name: string; description: string | null }>) {
      if (!b.name || listed.has(b.name)) continue;
      if (findMentions(text, b.name, chapter.id).length) listed.set(b.name, { name: b.name, source: 'story bible', description: b.description ?? '' });
    }
  }
  for (const n of namesInText(text)) {
    if (![...listed.keys()].some((k) => k.split(/\s+/).includes(n))) listed.set(n, { name: n, source: 'found in this chapter', description: '' });
  }
  const characters = [...listed.values()].map((c) => ({ ...c, mentions_here: findMentions(text, c.name, chapter.id).length }));
  characters.sort((a, b) => b.mentions_here - a.mentions_here);
  res.json({ success: true, data: { characters } });
});

contentToolsRouter.get('/:id/characters/threads', async (req, res) => {
  const parsed = NameQuery.safeParse({ name: req.query.name });
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'BAD_NAME', message: 'Give a name of 2 to 80 characters.' } });
    return;
  }
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const chapters = await bookChapters(req.userId!, chapter);
  const threads = threadsFor(chapters, parsed.data.name);
  const corpus = chapters.map((c) => c.content_text ?? '').join('\n');
  res.json({
    success: true,
    data: {
      name: parsed.data.name,
      total: threads.reduce((n, t) => n + t.mentions.length, 0),
      chapters_with_mentions: threads.length,
      ambiguity: nameAmbiguity(parsed.data.name, corpus),
      threads,
    },
  });
});

const CheckOutput = z.object({
  findings: z.array(
    z.object({
      kind: z.enum(['contradiction', 'ambiguity']),
      explanation: z.string(),
      quotes: z.array(z.string()),
      suggestion: z.string(),
    }),
  ),
});

/** The model's quote, if it is really in one of the passages it was shown. */
function verifiedQuotes(quotes: string[], passages: string[]): string[] {
  const hay = passages.map(normalize);
  return quotes.filter((q) => q.trim().length >= 8 && hay.some((p) => p.includes(normalize(q))));
}

contentToolsRouter.post('/:id/characters/check', validateBody(NameQuery), async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const { name } = req.body as z.infer<typeof NameQuery>;
  try {
    const chapters = await bookChapters(req.userId!, chapter);
    // This chapter's uses first, then the rest in book order, with room around each for pronouns.
    const threads = threadsFor(chapters, name, 420).sort((a, b) => (a.content_id === chapter.id ? -1 : b.content_id === chapter.id ? 1 : 0));
    const passages: Array<{ chapter: number | null; text: string }> = [];
    for (const t of threads) for (const m of t.mentions) if (passages.length < 60) passages.push({ chapter: t.chapter_number, text: `${m.before}${m.match}${m.after}` });
    if (!passages.length) {
      res.json({ success: true, data: { name, findings: [], dropped: 0, passages: 0 } });
      return;
    }
    const prompt = [
      `Below is every passage (up to 60) in a novel where the word "${name}" appears, with the chapter number.`,
      `Act as a careful line editor. Report only real problems with how the text treats "${name}":`,
      `- contradiction: the passages say incompatible things — about age, name, who received or holds a name, relationships, role, appearance, or when events happened.`,
      `- ambiguity: a reader could reasonably take "${name}" as a person's name in one place and an ordinary word (a number, an age) in another, or it is unclear which person a nearby "he" or "she" refers to.`,
      `For each finding give: kind; a plain one-sentence explanation; the exact quotes that show it, copied character for character from the passages; and a suggested rewrite of the clearest quote that removes the problem, in the novel's own voice, with no em dashes.`,
      `If a reading is possible but the text is consistent on a careful read, report it as ambiguity, not contradiction, and say what the two readings are. If there is nothing to flag, return no findings.`,
      '',
      ...passages.map((p, i) => `<passage n="${i + 1}" chapter="${p.chapter ?? '?'}">\n${p.text}\n</passage>`),
    ].join('\n');
    const out = await parseWith(CheckOutput, prompt, 'high');
    const texts = passages.map((p) => p.text);
    const findings = out.findings
      .map((f) => ({ ...f, quotes: verifiedQuotes(f.quotes, texts) }))
      .filter((f) => f.quotes.length > 0);
    logger.info({ userId: req.userId, contentId: chapter.id, name, findings: findings.length, dropped: out.findings.length - findings.length }, 'content-tools: character check');
    res.json({ success: true, data: { name, findings, dropped: out.findings.length - findings.length, passages: passages.length } });
  } catch (err) {
    await sendError(res, err, 'CHECK_FAILED', 'character check');
  }
});

const SuggestOutput = z.object({
  suggestions: z.array(
    z.object({ name: z.string(), meaning: z.string(), why: z.string(), quote: z.string(), report_id: z.string() }),
  ),
  note: z.string(),
});

contentToolsRouter.post('/:id/characters/suggest', validateBody(NameQuery), async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const { name } = req.body as z.infer<typeof NameQuery>;
  try {
    const supabase = getSupabaseAdmin();
    let reports: ResearchReport[] = [];
    let bookTitle = '';
    if (chapter.project_id) {
      const { data: project } = await supabase.from('writing_projects_v2').select('title').eq('id', chapter.project_id).maybeSingle();
      bookTitle = String(project?.title ?? '');
      const { data } = await supabase
        .from('research_reports_v2')
        .select('id, topic, content')
        .eq('user_id', req.userId!)
        .like('topic', `${bookTitle.replace(/[%_]/g, '')}%`)
        .is('deleted_at', null);
      const text = chapter.content_text ?? '';
      const terms = ['name', 'names', 'named', 'naming', 'called', ...namesInText(text, 12), ...String(chapter.title ?? '').split(/[^A-Za-z]+/).filter((w) => w.length > 4)];
      reports = rankResearch((data ?? []) as ResearchReport[], terms, 50_000);
    }
    if (!reports.length) {
      res.json({ success: true, data: { name, suggestions: [], note: 'This book has no research reports to ground a name in. Type a name yourself.', dropped: 0 } });
      return;
    }
    const sample = threadsFor([chapter], name, 300)[0]?.mentions.slice(0, 6).map((m) => `${m.before}${m.match}${m.after}`) ?? [];
    const prompt = [
      `"${name}" is used for a character in ${bookTitle || 'a novel'}, in the chapter "${chapter.title ?? ''}". Passages:`,
      ...sample.map((s) => `<passage>\n${s}\n</passage>`),
      '',
      `The author wants a name that fits this people and period, and is supported by their own research below.`,
      `Using ONLY the research reports, propose up to five names. For each: the name; its meaning if the research gives one; one sentence on why it fits; an exact quote from a report, copied character for character, that attests the name or the naming practice it follows; and that report's id.`,
      `Do not invent names the research does not support. If the reports attest no names or naming practice for this people and period, return no suggestions and say so in note. Otherwise note may be empty.`,
      '',
      ...reports.map((r) => `<report id="${r.id}" topic="${r.topic.replace(/"/g, "'")}">\n${r.content}\n</report>`),
    ].join('\n');
    const out = await parseWith(SuggestOutput, prompt, 'medium');
    const byId = new Map(reports.map((r) => [r.id, r]));
    const suggestions = out.suggestions
      .filter((s) => {
        const r = byId.get(s.report_id);
        return r && s.quote.trim().length >= 12 && normalize(r.content).includes(normalize(s.quote));
      })
      .map((s) => ({ ...s, report_topic: byId.get(s.report_id)!.topic }));
    res.json({ success: true, data: { name, suggestions, note: out.note, dropped: out.suggestions.length - suggestions.length } });
  } catch (err) {
    await sendError(res, err, 'SUGGEST_FAILED', 'name suggestion');
  }
});

const RenameBody = z.object({
  from: z.string().trim().min(2).max(80),
  to: z.string().trim().min(1).max(80),
  mention_ids: z.array(z.string().max(80)).min(1).max(5000),
  /** Also rename the story-bible entry and the cast list when their name is exactly `from`. */
  update_records: z.boolean().default(true),
});

contentToolsRouter.post('/:id/characters/rename', validateBody(RenameBody), async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const { from, to, mention_ids, update_records } = req.body as z.infer<typeof RenameBody>;
  const supabase = getSupabaseAdmin();
  const userId = req.userId!;
  try {
    const chapters = await bookChapters(userId, chapter);
    const byId = new Map(chapters.map((c) => [c.id, c]));
    const wanted = new Map<string, number[]>();
    for (const mid of mention_ids) {
      const [cid, off] = [mid.slice(0, mid.lastIndexOf(':')), Number(mid.slice(mid.lastIndexOf(':') + 1))];
      if (!byId.has(cid) || !Number.isInteger(off)) continue;
      wanted.set(cid, [...(wanted.get(cid) ?? []), off]);
    }
    const results: Array<{ content_id: string; chapter_number: number | null; applied: number; skipped: number }> = [];
    for (const [cid, offsets] of wanted) {
      const c = byId.get(cid)!;
      const text = c.content_text ?? '';
      const outcome = applyRename(text, from, to, offsets);
      if (outcome.applied.length) {
        const { data: last } = await supabase.from('content_versions_v2').select('version_number').eq('content_id', cid).order('version_number', { ascending: false }).limit(1).maybeSingle();
        await supabase.from('content_versions_v2').insert({
          content_id: cid,
          user_id: userId,
          version_number: ((last?.version_number as number | undefined) ?? 0) + 1,
          content_text: text,
          changed_by: 'character_rename',
          change_note: `Before renaming "${from}" to "${to}" (${outcome.applied.length} use${outcome.applied.length === 1 ? '' : 's'})`,
        });
        await supabase.from('published_content_v2').update({ content_text: outcome.text, updated_at: new Date().toISOString() }).eq('id', cid).eq('user_id', userId);
      }
      results.push({ content_id: cid, chapter_number: c.chapter_number, applied: outcome.applied.length, skipped: Object.keys(outcome.skipped).length });
    }

    let records = 0;
    if (update_records && chapter.project_id) {
      const { data: bibleRows } = await supabase
        .from('story_bible_v2')
        .update({ name: to, updated_at: new Date().toISOString() })
        .eq('project_id', chapter.project_id)
        .eq('entry_type', 'character')
        .eq('name', from)
        .is('deleted_at', null)
        .select('id');
      records += (bibleRows ?? []).length;
      const { data: project } = await supabase.from('writing_projects_v2').select('outline').eq('id', chapter.project_id).eq('user_id', userId).maybeSingle();
      const outline = (project?.outline ?? {}) as { characters?: Array<{ name?: string }> } & Record<string, unknown>;
      if (outline.characters?.some((c) => c.name === from)) {
        outline.characters = outline.characters.map((c) => (c.name === from ? { ...c, name: to } : c));
        await supabase.from('writing_projects_v2').update({ outline, updated_at: new Date().toISOString() }).eq('id', chapter.project_id).eq('user_id', userId);
        records += 1;
      }
    }
    const applied = results.reduce((n, r) => n + r.applied, 0);
    logger.info({ userId, contentId: chapter.id, from, to, applied, chapters: results.filter((r) => r.applied).length, records }, 'content-tools: rename');
    res.json({ success: true, data: { from, to, applied, skipped: results.reduce((n, r) => n + r.skipped, 0), chapters: results, records_updated: records } });
  } catch (err) {
    await sendError(res, err, 'RENAME_FAILED', 'rename');
  }
});

// ------------------------------------------------------------------------------------------------
// Humanizer
// ------------------------------------------------------------------------------------------------

const HumanizeBody = z.object({ text: z.string().trim().min(1).max(20_000) });

contentToolsRouter.post('/:id/humanize', validateBody(HumanizeBody), async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const { text } = req.body as z.infer<typeof HumanizeBody>;
  try {
    const result = await callEngineWriteToolSync<Record<string, unknown>>('chapter', {
      op: 'humanize-passage',
      text,
      user_id: req.userId!,
      project_id: chapter.project_id ?? undefined,
    });
    logger.info({ userId: req.userId, contentId: chapter.id, words: result.words, changed: result.changed, skipped: result.skipped }, 'content-tools: humanize');
    res.json({ success: true, data: result });
  } catch (err) {
    await sendError(res, err, 'HUMANIZE_FAILED', 'humanize');
  }
});

const ApplyBody = z.object({ original: z.string().min(1).max(20_000), replacement: z.string().min(1).max(20_000) });

contentToolsRouter.post('/:id/humanize/apply', validateBody(ApplyBody), async (req, res) => {
  const chapter = await loadChapter(req, res);
  if (!chapter) return;
  const { original, replacement } = req.body as z.infer<typeof ApplyBody>;
  const text = chapter.content_text ?? '';
  const at = text.indexOf(original);
  if (at < 0) {
    res.status(422).json({
      success: false,
      error: {
        code: 'PASSAGE_NOT_FOUND',
        message: 'That passage is not in the saved chapter as selected. Save first, and select within the text of the paragraphs (not across a heading).',
      },
    });
    return;
  }
  const supabase = getSupabaseAdmin();
  const { data: last } = await supabase.from('content_versions_v2').select('version_number').eq('content_id', chapter.id).order('version_number', { ascending: false }).limit(1).maybeSingle();
  await supabase.from('content_versions_v2').insert({
    content_id: chapter.id,
    user_id: req.userId!,
    version_number: ((last?.version_number as number | undefined) ?? 0) + 1,
    content_text: text,
    changed_by: 'humanizer',
    change_note: 'Before replacing a passage with its humanized version',
  });
  const updated = text.slice(0, at) + replacement + text.slice(at + original.length);
  await supabase.from('published_content_v2').update({ content_text: updated, updated_at: new Date().toISOString() }).eq('id', chapter.id).eq('user_id', req.userId!);
  logger.info({ userId: req.userId, contentId: chapter.id }, 'content-tools: humanized passage applied');
  res.json({ success: true, data: { replaced: true } });
});
