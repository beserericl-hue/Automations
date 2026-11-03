/**
 * The author's per-book copy that has no home on the project row (migration 054, book_copy_v2):
 * subtitle and inside flap per book, and the Also-by list. Read by the Publish screen, the KDP
 * package and the print files alike, so all three print the same words.
 */
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from './logger.js';

export const COPY_FIELDS = ['subtitle', 'inside_flap', 'also_by'] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

export interface SavedCopy {
  /** Per book (volume index as a string): subtitle and inside flap. */
  books: Record<string, { subtitle: string; inside_flap: string }>;
  also_by: string[];
}

export async function loadSavedCopy(projectId: string, userId: string): Promise<SavedCopy> {
  const { data, error } = await getSupabaseAdmin()
    .from('book_copy_v2')
    .select('volume_index, field, value')
    .eq('project_id', projectId)
    .eq('user_id', userId);
  // A missing table (migration 054 not applied) reads as "nothing saved" rather than breaking the
  // package export; the save route says what is wrong.
  if (error) {
    logger.warn({ err: error, projectId }, 'copy-assist: book_copy_v2 unreadable');
    return { books: {}, also_by: [] };
  }
  const out: SavedCopy = { books: {}, also_by: [] };
  for (const r of (data ?? []) as { volume_index: number; field: CopyField; value: string }[]) {
    if (r.field === 'also_by') {
      if (Number(r.volume_index) === 1) out.also_by = r.value.split('\n').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const k = String(r.volume_index);
    const book = out.books[k] ?? { subtitle: '', inside_flap: '' };
    book[r.field] = r.value;
    out.books[k] = book;
  }
  return out;
}

