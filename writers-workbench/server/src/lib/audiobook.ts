/**
 * The audiobook of a book: what is narrated, in what order, and what changes it.
 *
 * An audiobook is one recording per chapter (so a listener can move between chapters and a retailer
 * can take them as separate files), an opening-credits track and a closing-credits track, and a
 * retail sample cut from the first chapter. This module turns the manuscript into that list — pure,
 * no I/O — so the route, the screen's "what is stale" check and the tests all read the same plan.
 *
 * The narration itself (speech, mastering, storage) is the engine's `media.audiobook-chapter` op;
 * see engine/packages/writer_engine/src/writer_engine/audiobook/.
 */
import { createHash } from 'node:crypto';
import type { BookSource } from './book-source.js';
import { plannedVolumes, volumeParts } from './kdp-package.js';

export const BUCKET = 'audiobooks';

/** Narration is priced per started 1,000 words of chapter text. */
export const CREDIT_WORDS = 1000;

/** The cover an audiobook retailer takes: square, 2400 px. */
export const COVER_SIDE_PX = 2400;

export type ItemKind = 'opening' | 'chapter' | 'closing' | 'sample';

export interface Voice {
  id: string;
  label: string;
  note?: string;
}

/** The narrator voices the speech model offers (American English; the direction asks for it). */
export const VOICES: readonly Voice[] = [
  { id: 'marin', label: 'Marin', note: 'Recommended — the provider’s most natural voice' },
  { id: 'cedar', label: 'Cedar', note: 'Recommended — the provider’s most natural voice' },
  { id: 'ash', label: 'Ash' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'nova', label: 'Nova' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
  { id: 'alloy', label: 'Alloy' },
];

export interface Style {
  id: string;
  label: string;
  description: string;
}

/** The narrator's direction presets; the wording the voice is given is in the engine (audiobook/styles.py). */
export const STYLES: readonly Style[] = [
  { id: 'fiction', label: 'Storyteller', description: 'Warm, engaged and expressive. The default for most novels.' },
  { id: 'thriller', label: 'Tense', description: 'Low and controlled, quickening through action, quiet before danger.' },
  { id: 'intimate', label: 'Intimate', description: 'Soft and unhurried, as if told to one person close by.' },
  { id: 'epic', label: 'Epic', description: 'Grand and dramatic, with weight on the big moments.' },
];

export interface AudioSettings {
  voice: string;
  style: string;
  custom_style: string;
  credits: boolean;
}

export const DEFAULT_SETTINGS: AudioSettings = { voice: 'marin', style: 'fiction', custom_style: '', credits: true };

export const MAX_CUSTOM_STYLE = 600;

/** Settings from a stored row or a request body: unknown voices/styles fall back, the note is bounded. */
export function normalizeSettings(raw: Partial<Record<keyof AudioSettings, unknown>> | null | undefined): AudioSettings {
  const voice = String(raw?.voice ?? '');
  const style = String(raw?.style ?? '');
  return {
    voice: VOICES.some((v) => v.id === voice) ? voice : DEFAULT_SETTINGS.voice,
    style: STYLES.some((s) => s.id === style) ? style : DEFAULT_SETTINGS.style,
    custom_style: String(raw?.custom_style ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_STYLE),
    credits: raw?.credits === undefined ? DEFAULT_SETTINGS.credits : Boolean(raw.credits),
  };
}

export interface PlannedItem {
  kind: ItemKind;
  /** The manuscript's chapter number for a chapter; 0 for the other kinds. */
  chapter_number: number;
  /** Listening order. Fixed slots for the credits and the sample so a toggle never renumbers a chapter. */
  position: number;
  /** What the screen lists, and — for a chapter — the line spoken before it. */
  title: string;
  source_text: string;
  words: number;
}

export interface AudiobookPlan {
  title: string;
  author: string;
  volumes: number;
  items: PlannedItem[];
}

export const OPENING_POSITION = 0;
export const CLOSING_POSITION = 9998;
export const SAMPLE_POSITION = 9999;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** "Chapter 3. The Door" — unless the author's title already says what it is ("Prologue", "Chapter 3: …"). */
export function spokenChapterTitle(number: number, title: string | null | undefined): string {
  const t = String(title ?? '').trim();
  if (/^(chapter|prologue|epilogue|interlude|part|book|afterword|foreword|introduction)\b/i.test(t)) {
    return t.replace(/^(chapter\s+[\w-]+)\s*[:\-–—]\s*/i, '$1. ');
  }
  if (number > 0) return t ? `Chapter ${number}. ${t}` : `Chapter ${number}`;
  return t || 'Untitled';
}

/** The words spoken before the first chapter. The narrator is named for what it is. */
export function openingText(title: string, author: string): string {
  const by = author.trim() ? ` Written by ${author.trim()}.` : '';
  return `${title.trim()}.${by} Narrated by an A.I. voice.`;
}

export function closingText(title: string, author: string): string {
  const by = author.trim() ? `, written by ${author.trim()}` : '';
  return `This has been ${title.trim()}${by}. Thank you for listening.`;
}

/**
 * The recordings of one book of the project (`volumeIndex`; 1 for a single book), or null when that
 * book is not in the volume plan or has no chapter text.
 */
export function planAudiobook(source: BookSource, volumeIndex: number, settings: AudioSettings): AudiobookPlan | null {
  const all = source.chapters.filter((c) => String(c.content_text ?? '').trim());
  if (!all.length) return null;
  const planned = plannedVolumes(source, all);
  const v = planned.find((p) => p.index === volumeIndex);
  if (!v) return null;
  const parts = volumeParts({ ...source }, planned, all, v);
  if (!parts.rows.length) return null;

  const items: PlannedItem[] = [];
  if (settings.credits) {
    const text = openingText(parts.fullTitle, source.author);
    items.push({ kind: 'opening', chapter_number: 0, position: OPENING_POSITION, title: 'Opening credits', source_text: text, words: countWords(text) });
  }
  parts.rows.forEach((c, i) => {
    const number = Number(c.chapter_number ?? i + 1);
    const text = String(c.content_text ?? '');
    items.push({
      kind: 'chapter',
      chapter_number: number,
      position: i + 1,
      title: spokenChapterTitle(number, c.title),
      source_text: text,
      words: countWords(text),
    });
  });
  if (settings.credits) {
    const text = closingText(parts.fullTitle, source.author);
    items.push({ kind: 'closing', chapter_number: 0, position: CLOSING_POSITION, title: 'Closing credits', source_text: text, words: countWords(text) });
  }
  return { title: parts.fullTitle, author: source.author, volumes: planned.length, items };
}

/** Identity of a recording's input: the same hash means the same words, voice and direction. */
export function hashItem(item: Pick<PlannedItem, 'kind' | 'title' | 'source_text'>, s: AudioSettings): string {
  return createHash('sha256')
    .update([item.kind, item.title, item.source_text, s.voice, s.style, s.custom_style].join('\u0000'))
    .digest('hex');
}

/** Identity of the narrator settings alone (voice, style, the author's note). */
export function styleHash(s: AudioSettings): string {
  return createHash('sha256').update([s.voice, s.style, s.custom_style].join('\u0000')).digest('hex');
}

/** Credits for narrating these chapter recordings: per started 1,000 words each. Credits tracks are free. */
export function narrationUnits(items: Pick<PlannedItem, 'kind' | 'words'>[]): number {
  return items.reduce((n, i) => (i.kind === 'chapter' ? n + Math.max(1, Math.ceil(i.words / CREDIT_WORDS)) : n), 0);
}

function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

/** The file name a recording downloads as: sorts in listening order in any file manager. */
export function filenameFor(item: Pick<PlannedItem, 'kind' | 'chapter_number' | 'title'>, ordinal: number): string {
  const n = String(ordinal).padStart(2, '0');
  switch (item.kind) {
    case 'opening':
      return `${n} - Opening Credits.mp3`;
    case 'closing':
      return `${n} - Closing Credits.mp3`;
    case 'sample':
      return 'Retail Sample.mp3';
    default:
      return `${n} - ${slug(item.title) || `Chapter ${item.chapter_number}`}.mp3`;
  }
}

/**
 * The book cover as an audiobook cover: square, 2400 px, JPEG.
 *
 * A book's cover is portrait and a retailer's audiobook cover is square, so the cover is not cropped
 * (that would cut the title) or stretched: it is centred whole on a soft, darkened enlargement of
 * itself, so the sides carry the cover's own colours rather than a flat bar.
 */
export async function squareCover(art: Buffer): Promise<Buffer> {
  const sharpMod = (await import('sharp')) as unknown as { default: (b: Buffer) => import('sharp').Sharp };
  const sharp = sharpMod.default;
  const side = COVER_SIDE_PX;
  const backdrop = await sharp(art)
    .resize(side, side, { fit: 'cover' })
    .blur(60)
    .modulate({ brightness: 0.55 })
    .toBuffer();
  const front = await sharp(art).resize(side, side, { fit: 'inside', withoutEnlargement: false }).toBuffer();
  return sharp(backdrop)
    .composite([{ input: front, gravity: 'centre' }])
    .flatten({ background: '#000000' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
