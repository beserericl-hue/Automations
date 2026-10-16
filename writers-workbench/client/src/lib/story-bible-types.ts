/**
 * Canonical story-bible entry types (A6).
 *
 * Three layers used to disagree about what an `entry_type` may be, and only `character` and `event`
 * were common to all three:
 *
 *   story_bible_v2 CHECK      character event item     location organization plot_thread
 *   engine BibleEntry         character event object   place    concept
 *   this client (old)         character event location timeline plot_thread  world_rule
 *
 * Measured on DEV: 2341 of 3226 live rows (72%) carried a type outside the table's documented set,
 * and — crucially — `pg_constraint` shows **no CHECK on the column at all**, so that documented set
 * was never enforced. The engine's vocabulary is therefore what is actually in the data.
 *
 * Decision: the ENGINE vocabulary is canonical. No data migration is needed; the consumers move.
 *
 * The real bug this fixes: `StoryBiblePanel` grouped by a hardcoded list, so any row whose type was
 * not in that list was filtered out and NEVER RENDERED — which is why the Story Bible tab appeared
 * to be missing most of its content. Grouping now covers the canonical order PLUS any type actually
 * present, so a future vocabulary drift can degrade the ordering but can never hide a row again.
 */

/** What the engine writes today (`writer_engine.schemas.chapter.BibleEntry`). */
export const CANONICAL_ENTRY_TYPES = [
  'character',
  'place',
  'object',
  'concept',
  'event',
] as const;

/**
 * Types that exist in historical rows or other layers. Kept only so they sort in a sensible place
 * when present — never used to decide what is shown.
 */
export const LEGACY_ENTRY_TYPES = [
  'location',
  'item',
  'organization',
  'plot_thread',
  'timeline',
  'world_rule',
  'world_building',
  'research',
] as const;

/** Display order: canonical first, then known legacy types. */
export const ENTRY_TYPE_ORDER: readonly string[] = [
  ...CANONICAL_ENTRY_TYPES,
  ...LEGACY_ENTRY_TYPES,
];

/** Human label for a type, including ones we have never seen before. */
export function entryTypeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Every type to render for a set of entries: the canonical order, restricted to types actually
 * present, followed by any unrecognised type found in the data (sorted, so output is stable).
 *
 * Returning only *present* types keeps empty headings out of the UI, while the trailing unknowns
 * guarantee nothing is silently dropped.
 */
export function entryTypesPresent(
  entries: readonly { entry_type: string }[] | null | undefined,
): string[] {
  const present = new Set((entries ?? []).map((e) => e.entry_type).filter(Boolean));
  const ordered = ENTRY_TYPE_ORDER.filter((t) => present.has(t));
  const unknown = [...present].filter((t) => !ENTRY_TYPE_ORDER.includes(t)).sort();
  return [...ordered, ...unknown];
}
