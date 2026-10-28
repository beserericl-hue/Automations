/**
 * Everything a printed book is built from, read once from the project.
 *
 * Shared by the KDP package and the print orders. Two copies of this read would drift — a print
 * copy built from a different bio, or different volume breaks, than the KDP upload of the same book
 * is two different books.
 */

import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { downloadCover, findCover } from './book-cover.js';
import { marketingKey, publishingOf } from '../routes/publishing.js';
import { logger } from './logger.js';
import type { BuildPackageOptions, PackageChapter, PackageSettings } from './kdp-package.js';

export type BookSource = Omit<BuildPackageOptions, 'onlyVolume' | 'onlyApproved'>;

/** Null when the project is not this user's (or does not exist). Throws on a failed read. */
export async function loadBookSource(projectId: string, userId: string): Promise<BookSource | null> {
  const supabase = getSupabaseAdmin();
  const { data: project, error: projError } = await supabase
    .from('writing_projects_v2')
    .select('id, title, outline')
    .eq('id', projectId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (projError || !project) return null;
  const outline = (project.outline as Record<string, unknown> | null) ?? {};
  const settings = publishingOf(outline) as unknown as PackageSettings;

  // Paged. PostgREST caps a response at 1000 rows and `data.length` is a page size, not a
  // count — reading it as one is a mistake this codebase has already paid for.
  const chapters: PackageChapter[] = [];
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('published_content_v2')
      .select('title, chapter_number, content_text, status')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('content_type', 'chapter')
      .is('deleted_at', null)
      .order('chapter_number', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error('CHAPTERS_UNREADABLE');
    chapters.push(...((data || []) as unknown as PackageChapter[]));
    if ((data || []).length < 1000) break;
  }

  const { data: authorProfile } = await supabase
    .from('author_profiles_v2')
    .select('pen_name, bio')
    .eq('user_id', userId)
    .maybeSingle();
  let authorName = String(authorProfile?.pen_name ?? '').trim();
  if (!authorName) {
    const { data: account } = await supabase
      .from('users_v2')
      .select('display_name')
      .eq('user_id', userId)
      .maybeSingle();
    authorName = String(account?.display_name ?? '').trim();
  }

  const plan = outline._volume_plan as
    | { volumes?: { index: number; first_chapter: number; last_chapter: number }[] }
    | undefined;

  // The whole book's cover, and each book's own where the author chose one for it.
  let art: Buffer | null = null;
  const artByVolume: Record<string, Buffer> = {};
  try {
    const whole = await findCover(supabase, projectId, outline);
    art = await downloadCover(supabase, whole);
    for (const v of plan?.volumes ?? []) {
      const own = await findCover(supabase, projectId, outline, v.index);
      if (!own || own.id === whole?.id) continue;
      const bytes = await downloadCover(supabase, own);
      if (bytes) artByVolume[String(v.index)] = bytes;
    }
  } catch (err) {
    logger.warn({ err, projectId }, 'book source: cover art unavailable');
  }

  const volumeCount = Math.max(1, plan?.volumes?.length ?? 1);
  const marketing: Record<string, unknown> = {};
  for (let i = 1; i <= volumeCount; i += 1) {
    marketing[String(i)] = outline[marketingKey(i)] ?? null;
  }

  const stored = (outline._series as { name?: string; books?: Record<string, { title?: string }> } | undefined) ?? {};
  const titles = Object.fromEntries(
    Object.entries(stored.books ?? {}).map(([k, b]) => [k, String(b?.title ?? '').trim()]),
  );

  return {
    title: String(project.title ?? ''),
    // The series exists as soon as there is more than one book; its name defaults to the title.
    series: { name: String(stored.name ?? '').trim() || String(project.title ?? ''), titles },
    author: authorName,
    authorBio: String(authorProfile?.bio ?? ''),
    chapters,
    settings,
    volumes: plan?.volumes,
    art,
    artByVolume,
    marketing: marketing as BuildPackageOptions['marketing'],
  };
}
