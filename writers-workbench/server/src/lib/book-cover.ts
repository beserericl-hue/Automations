/**
 * Which picture is the book's cover.
 *
 * Every cover the author generates lands in the project's gallery, so "the newest one" is not a
 * choice — a cover made to try an idea out would quietly replace the one the author meant. The
 * author picks: one picture for the whole book, and, in a series, one per book. Without a choice the
 * newest cover art is used, as before.
 *
 * Stored on the outline's `_publishing` as `cover_image_id` and `cover_image_ids` (volume index as
 * a string → image id), next to the trim and the ISBNs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CoverChoice {
  /** The picture for the whole book, or for any book of the series without its own. */
  default: string | null;
  /** Per book of a series, keyed by volume index as a string. */
  books: Record<string, string>;
}

export function coverChoice(outline: Record<string, unknown> | null | undefined): CoverChoice {
  const p = ((outline ?? {})._publishing ?? {}) as Record<string, unknown>;
  const books: Record<string, string> = {};
  for (const [k, v] of Object.entries((p.cover_image_ids ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' && v) books[k] = v;
  }
  return { default: typeof p.cover_image_id === 'string' && p.cover_image_id ? p.cover_image_id : null, books };
}

export interface CoverRow {
  id: string;
  storage_path: string | null;
  created_at: string;
  /** True when the author chose it; false when it is the newest cover art by default. */
  chosen: boolean;
}

/**
 * The cover for the whole book (`volumeIndex` null) or for one book of the series. A chosen picture
 * that has since been deleted falls through to the next choice rather than leaving the book bare.
 */
export async function findCover(
  supabase: SupabaseClient,
  projectId: string,
  outline: Record<string, unknown> | null | undefined,
  volumeIndex: number | null = null,
): Promise<CoverRow | null> {
  const choice = coverChoice(outline);
  const wanted = [volumeIndex != null ? choice.books[String(volumeIndex)] : undefined, choice.default].filter(
    (id): id is string => Boolean(id),
  );
  for (const id of wanted) {
    const { data } = await supabase
      .from('generated_images_v2')
      .select('id, storage_path, created_at')
      .eq('id', id)
      .eq('project_id', projectId)
      .maybeSingle();
    if (data) return { ...(data as Omit<CoverRow, 'chosen'>), chosen: true };
  }
  const { data } = await supabase
    .from('generated_images_v2')
    .select('id, storage_path, created_at')
    .eq('project_id', projectId)
    .eq('image_type', 'cover_art')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { ...(data as Omit<CoverRow, 'chosen'>), chosen: false } : null;
}

/** The picture's bytes, or null when it cannot be read. */
export async function downloadCover(supabase: SupabaseClient, row: CoverRow | null): Promise<Buffer | null> {
  if (!row?.storage_path) return null;
  const dl = await supabase.storage.from('cover-images').download(row.storage_path);
  return dl.data ? Buffer.from(await dl.data.arrayBuffer()) : null;
}
