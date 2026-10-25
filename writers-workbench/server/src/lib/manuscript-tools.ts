/**
 * Tools for working across a whole manuscript from one chapter: finding every place a name is
 * used, renaming it at exactly the places the author chose, and telling a name from a word.
 *
 * Pure text functions; the routes in content-tools.ts load and save the chapters.
 *
 * WHY "AT EXACTLY THE PLACES CHOSEN". A find-and-replace on a word is wrong as often as it is right.
 * "Seven" in The Ossuary is the boy's age in "Seven was not old enough", the number in "Seven days
 * later", and it reads as a name — a rename of every "Seven" would rename the days too. So a rename
 * is a list of mentions the author ticked, each identified by chapter and character offset, and each
 * is checked against the chapter as it is now before anything changes.
 */

export interface Mention {
  /** `${content_id}:${offset}` — what the author ticks to include it in a rename. */
  id: string;
  offset: number;
  before: string;
  match: string;
  after: string;
}

const WORD = /[\p{L}\p{N}'’-]/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is the match at `i` a whole word — not part of "Sevenfold" or "Bent-Reeds"? */
function isWholeWord(text: string, i: number, len: number): boolean {
  const prev = i > 0 ? text[i - 1] : '';
  const next = text[i + len] ?? '';
  return !(prev && WORD.test(prev)) && !(next && WORD.test(next) && next !== "'" && next !== '’');
}

/** Context either side, cut back to a word boundary so a snippet never opens mid-word. */
function window(text: string, start: number, end: number, span: number): { before: string; after: string } {
  let a = Math.max(0, start - span);
  let b = Math.min(text.length, end + span);
  if (a > 0) a = text.indexOf(' ', a) + 1 || a;
  if (b < text.length) b = text.lastIndexOf(' ', b) > end ? text.lastIndexOf(' ', b) : b;
  return { before: text.slice(a, start), after: text.slice(end, b) };
}

/** Every whole-word, case-sensitive use of `name` in `text`. Case-sensitive: "Seven" not "seven". */
export function findMentions(text: string, name: string, contentId: string, span = 160): Mention[] {
  const term = name.trim();
  if (!term) return [];
  const re = new RegExp(escapeRe(term), 'g');
  const out: Mention[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!isWholeWord(text, m.index, term.length)) continue;
    const { before, after } = window(text, m.index, m.index + term.length, span);
    out.push({ id: `${contentId}:${m.index}`, offset: m.index, before, match: m[0], after });
  }
  return out;
}

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
]);

/**
 * Why a reader might not take `name` as a name, or null when nothing suggests it. Two signals, both
 * cheap and both real: it is a number word, or the manuscript also uses it lower-case as an ordinary
 * word ("the seven of them").
 */
export function nameAmbiguity(name: string, corpus: string): string | null {
  const term = name.trim();
  const lower = term.toLowerCase();
  if (!term) return null;
  const reasons: string[] = [];
  if (NUMBER_WORDS.has(lower)) reasons.push(`"${term}" is also a number`);
  const ordinary = (corpus.match(new RegExp(`(?<![\\p{L}])${escapeRe(lower)}(?![\\p{L}])`, 'gu')) ?? []).length;
  if (ordinary > 0 && lower !== term) {
    reasons.push(`the manuscript also uses "${lower}" as an ordinary word ${ordinary} time${ordinary === 1 ? '' : 's'}`);
  }
  return reasons.length ? `${reasons.join(', and ')}, so a reader may not take it as a name.` : null;
}

export interface RenameOutcome {
  text: string;
  applied: number[];
  /** offset -> why it was not changed (the chapter changed since the preview). */
  skipped: Record<number, string>;
}

/**
 * Replace `from` with `to` at the given offsets only. Each offset is re-checked against the text as
 * it is now; one that no longer holds `from` as a whole word is skipped and reported, never forced.
 * Applied from the end backwards so earlier offsets stay valid.
 */
export function applyRename(text: string, from: string, to: string, offsets: number[]): RenameOutcome {
  const applied: number[] = [];
  const skipped: Record<number, string> = {};
  let out = text;
  for (const off of [...new Set(offsets)].sort((a, b) => b - a)) {
    if (out.slice(off, off + from.length) !== from || !isWholeWord(out, off, from.length)) {
      skipped[off] = 'the chapter changed here since the preview';
      continue;
    }
    out = out.slice(0, off) + to + out.slice(off + from.length);
    applied.push(off);
  }
  return { text: out, applied: applied.reverse(), skipped };
}

/** A name a reader would see as one: capitalised and used mid-sentence somewhere. */
const COMMON_CAPS = new Set([
  'The', 'He', 'She', 'They', 'It', 'His', 'Her', 'Their', 'But', 'And', 'Then', 'When', 'There',
  'This', 'That', 'Not', 'Just', 'What', 'Who', 'Why', 'How', 'Now', 'Still', 'Seven', 'One', 'Two',
]);

/**
 * Names that appear in a chapter but may not be in the story bible: capitalised tokens (hyphenated
 * compounds allowed, "Bent-Reed") seen at least once mid-sentence and never lower-cased in the text.
 * A candidate list for the author to look at, not a claim.
 */
export function namesInText(text: string, limit = 30): string[] {
  const lowerWords = new Set((text.match(/\b[a-z][a-z'-]+\b/g) ?? []).map((w) => w.toLowerCase()));
  const counts = new Map<string, number>();
  const re = /(?<=[a-z,;:'"’”)] )([A-Z][a-z]+(?:-[A-Z][a-z]+)*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[1];
    if (COMMON_CAPS.has(w) || lowerWords.has(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}
