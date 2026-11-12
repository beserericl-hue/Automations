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

/** One line of the author's pronunciation guide: the word as written, and how it sounds in plain letters. */
export interface Pronunciation {
  word: string;
  say: string;
}

export const MAX_PRONUNCIATIONS = 200;

export const ELEVEN_VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

/** Who speaks: the Workbench's own narrator voices (OpenAI), or the author's own ElevenLabs account. */
export type Provider = 'openai' | 'elevenlabs';

export interface AudioSettings {
  provider: Provider;
  voice: string;
  style: string;
  custom_style: string;
  credits: boolean;
  pronunciations: Pronunciation[];
  /** The author's own ElevenLabs voice's name, for "Narrated by <name>". Empty: say it is an A.I. voice. */
  narrator_name: string;
}

export const DEFAULT_SETTINGS: AudioSettings = { provider: 'openai', voice: 'marin', style: 'fiction', custom_style: '', credits: true, pronunciations: [], narrator_name: '' };

/** A guide from a request or a stored row: trimmed, no blanks, one line per word (the last one wins), bounded. */
export function normalizePronunciations(raw: unknown): Pronunciation[] {
  if (!Array.isArray(raw)) return [];
  const byWord = new Map<string, Pronunciation>();
  for (const e of raw) {
    const word = String((e as Pronunciation | null)?.word ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const say = String((e as Pronunciation | null)?.say ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (word && say) byWord.set(word, { word, say });
  }
  return [...byWord.values()].slice(0, MAX_PRONUNCIATIONS);
}

export const MAX_CUSTOM_STYLE = 600;

/** Settings from a stored row or a request body: unknown voices/styles fall back, the note is bounded. */
export function normalizeSettings(raw: Partial<Record<keyof AudioSettings, unknown>> | null | undefined): AudioSettings {
  const voice = String(raw?.voice ?? '');
  const style = String(raw?.style ?? '');
  // An ElevenLabs voice is whatever voice id the author's account has: an id, not one of our names.
  const elevenVoice = raw?.provider === 'elevenlabs' && ELEVEN_VOICE_ID.test(voice);
  return {
    provider: elevenVoice ? 'elevenlabs' : 'openai',
    voice: elevenVoice ? voice : VOICES.some((v) => v.id === voice) ? voice : DEFAULT_SETTINGS.voice,
    style: STYLES.some((s) => s.id === style) ? style : DEFAULT_SETTINGS.style,
    custom_style: String(raw?.custom_style ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_STYLE),
    credits: raw?.credits === undefined ? DEFAULT_SETTINGS.credits : Boolean(raw.credits),
    pronunciations: normalizePronunciations(raw?.pronunciations),
    // Only an ElevenLabs voice can carry a person's name; the built-in voices are always A.I. voices.
    narrator_name: elevenVoice ? String(raw?.narrator_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
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

/**
 * The words spoken before the first chapter. The narrator is named for what it is: a person's name when the
 * author reads in their own cloned voice, an A.I. voice otherwise.
 */
export function openingText(title: string, author: string, narrator = ''): string {
  const by = author.trim() ? ` Written by ${author.trim()}.` : '';
  const who = narrator.trim() ? narrator.trim() : 'an A.I. voice';
  return `${title.trim()}.${by} Narrated by ${who}.`;
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
    const text = openingText(parts.fullTitle, source.author, settings.narrator_name);
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
  // Only the guide entries that occur in THIS recording's words count: adding "Siobhan" re-records the
  // chapters Siobhan is in, not the whole book.
  const haystack = `${item.title}\n${item.source_text}`;
  const guide = s.pronunciations
    .filter((p) => haystack.includes(p.word))
    .map((p) => `${p.word}=${p.say}`)
    .sort()
    .join('|');
  const parts = [item.kind, item.title, item.source_text, s.voice, s.style, s.custom_style];
  // Only for the author's own ElevenLabs voice (an OpenAI recording keeps its original fingerprint).
  // The delivery note does not reach ElevenLabs, so it is not part of what makes a recording "changed".
  if (s.provider === 'elevenlabs') {
    parts.splice(5, 1, 'elevenlabs');
  }
  // Appended only when there is something to say, so a recording made before the guide existed (or one
  // the guide does not touch) keeps the fingerprint it was made with and is not called "changed".
  if (guide) parts.push(guide);
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Words most often capitalized mid-sentence in the chapters: the names a voice is most likely to get wrong. */
export function suggestNames(texts: string[], skip: string[] = [], limit = 40): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  const known = new Set(skip.map((w) => w.toLowerCase()));
  for (const text of texts) {
    // A capitalized word not at the start of a sentence: the previous visible character is not . ! ? or an opening quote.
    for (const m of text.matchAll(/(?<=[a-z,;:)—-]["”’']?\s+)[A-Z][a-z]+(?:['’-][A-Za-z]+)*/g)) {
      const w = m[0].replace(/['’]s$/, '');
      if (w.length < 3 || known.has(w.toLowerCase()) || COMMON_CAPITALIZED.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/** Capitalized in running text but never a name worth a guide. */
const COMMON_CAPITALIZED = new Set([
  'God', 'Lord', 'Sir', 'Lady', 'Mister', 'Doctor', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'Christmas', 'Yes', 'The', 'And', 'But', 'Not', 'That', 'This',
]);

/** Identity of the narrator settings alone (voice, style, the author's note). */
export function styleHash(s: AudioSettings): string {
  return createHash('sha256').update([s.voice, s.style, s.custom_style].join('\u0000')).digest('hex');
}

/** The single-file audiobook (.m4b): how small it is made. Sizes are per hour of audio. */
export const EXPORT_QUALITIES = [
  { id: 'compact', label: 'Compact', detail: 'AAC mono 48 kbps · about 22 MB an hour', mb_per_hour: 22 },
  { id: 'high', label: 'Higher quality', detail: 'AAC mono 64 kbps · about 30 MB an hour', mb_per_hour: 30 },
  { id: 'small', label: 'Smallest', detail: 'AAC mono 32 kbps · about 15 MB an hour — listen to a chapter first', mb_per_hour: 15 },
] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number]['id'];
export const DEFAULT_EXPORT_QUALITY: ExportQuality = 'compact';

export function normalizeQuality(raw: unknown): ExportQuality {
  return EXPORT_QUALITIES.some((q) => q.id === raw) ? (raw as ExportQuality) : DEFAULT_EXPORT_QUALITY;
}

/** A URL-safe file name for the .m4b, from the book's title (the engine names the stored file the same way). */
export function exportFileName(title: string): string {
  return `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'audiobook'}.m4b`;
}

/**
 * Identity of what a single-file audiobook was made from: which recordings (and when each was made) and
 * how small it was made. Re-narrate any chapter and the fingerprint moves, so the screen can say the file
 * is out of date instead of handing over an audiobook that no longer matches its chapters.
 */
export function exportFingerprint(rows: { id: string; position: number; built_at: string | null }[], quality: ExportQuality): string {
  return createHash('sha256')
    .update([...rows].sort((a, b) => a.position - b.position).map((r) => `${r.position}:${r.id}:${r.built_at ?? ''}`).join('|') + `|q=${quality}`)
    .digest('hex');
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
