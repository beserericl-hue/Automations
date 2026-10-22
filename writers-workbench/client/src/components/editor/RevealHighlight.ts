/**
 * Find a passage in the manuscript and mark it, without touching the manuscript.
 *
 * WHY A DECORATION. The obvious way to highlight text is to wrap it in a mark, and that would be
 * wrong twice over: it edits the document, so the chapter goes dirty and auto-saves two seconds
 * later with a highlight baked into the prose — and the highlight would then travel into the EPUB.
 * A ProseMirror decoration is presentation only. It lives beside the document, never in it, and
 * disappears the moment it is cleared.
 *
 * WHY THE MATCHING IS FUZZY. The quote in a Q/A finding was taken from the stored plain text. The
 * editor holds HTML parsed into blocks. Between the two, a paragraph break becomes a node boundary
 * rather than a newline, runs of whitespace collapse, and a quote that spans two paragraphs has a
 * gap in it that exists in one representation and not the other. An exact string search finds
 * nothing most of the time. So the search runs over a whitespace-normalised projection of the
 * document, and the match is mapped back to real positions through an index kept while building it.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const revealPluginKey = new PluginKey<DecorationSet>('reveal-highlight');

/** The class the decoration carries. Also how the scroller finds the element afterwards. */
export const REVEAL_CLASS = 'reveal-highlight';

export interface RevealRange {
  from: number;
  to: number;
}

/** What `setMeta` carries: a range to show, or null to clear. */
type RevealMeta = RevealRange | null;

export const RevealHighlight = Extension.create({
  name: 'revealHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: revealPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, current) {
            const meta = tr.getMeta(revealPluginKey) as RevealMeta | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: REVEAL_CLASS }),
              ]);
            }
            // No instruction of its own: follow the document through the change, so a highlight
            // survives an edit somewhere else in the chapter instead of sliding off the passage.
            return current.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => revealPluginKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

/**
 * A whitespace-normalised view of the document, with a way back to real positions.
 *
 * `text` collapses every run of whitespace to one space. `posAt[i]` is the ProseMirror position of
 * the character at `text[i]`, so a match found in `text` can be turned into a document range.
 */
interface DocIndex {
  text: string;
  posAt: number[];
}

function buildIndex(doc: PMNode): DocIndex {
  const chars: string[] = [];
  const posAt: number[] = [];
  let pendingGap = false;

  doc.descendants((node, pos) => {
    if (node.isText) {
      const raw = node.text ?? '';
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          pendingGap = true;
          continue;
        }
        if (pendingGap && chars.length) {
          // The space stands in for whatever whitespace was there, and is pinned to the position
          // of the character that follows it so a match starting on it still lands inside the text.
          chars.push(' ');
          posAt.push(pos + i);
        }
        pendingGap = false;
        chars.push(ch);
        posAt.push(pos + i);
      }
      return false;
    }
    // A block boundary reads as whitespace. Without this, the last word of one paragraph and the
    // first of the next are run together and no quote spanning them can ever match.
    if (node.isBlock && chars.length) pendingGap = true;
    return true;
  });

  return { text: chars.join(''), posAt };
}

/** The same projection, applied to the needle. */
function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Typographic variants that the same sentence can be written with on either side.
 *
 * The prose is full of curly quotes and em dashes; a finding's quote may carry the straight ASCII
 * forms, or the reverse, depending on what wrote it. Folding both to one shape is the difference
 * between finding a passage and reporting it missing.
 */
function fold(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

export interface FindResult extends RevealRange {
  /** False when only the opening of the quote matched — the passage has been edited since. */
  exact: boolean;
}

/**
 * Locate a quote in the document.
 *
 * Three attempts, in decreasing confidence. The last one matters more than it looks: a chapter gets
 * edited after its Q/A report is written, and a finding whose quote no longer matches character for
 * character is still pointing at a real paragraph the author wants to look at. Landing them near it
 * is better than telling them it is gone.
 */
export function findInDoc(doc: PMNode, quote: string): FindResult | null {
  const needle = normalise(quote);
  if (needle.length < 4) return null;
  const index = buildIndex(doc);
  if (!index.text) return null;

  const haystacks = [index.text, fold(index.text).toLowerCase()];
  const needles = [needle, fold(needle).toLowerCase()];

  for (let attempt = 0; attempt < haystacks.length; attempt += 1) {
    const at = haystacks[attempt].indexOf(needles[attempt]);
    if (at < 0) continue;
    return {
      from: index.posAt[at],
      to: index.posAt[Math.min(at + needle.length - 1, index.posAt.length - 1)] + 1,
      exact: true,
    };
  }

  // FALL BACK TO THE LONGEST OPENING THAT STILL MATCHES.
  //
  // A chapter gets edited after its Q/A report is written, and the edit is usually at the end of
  // the flagged sentence — the beginning is what survives. So drop one word at a time off the end
  // until what is left is found. A fixed-length prefix does not work: cutting at 48 characters
  // still includes the edit when the divergence began at 39.
  //
  // The floor is there because a short enough prefix matches somewhere by accident, and landing on
  // an arbitrary paragraph is worse than saying the passage is gone.
  const words = needles[1].split(' ');
  for (let count = words.length - 1; count >= 4; count -= 1) {
    const head = words.slice(0, count).join(' ');
    if (head.length < MIN_PARTIAL_CHARS) break;
    const at = haystacks[1].indexOf(head);
    if (at < 0) continue;
    return {
      from: index.posAt[at],
      to: index.posAt[Math.min(at + head.length - 1, index.posAt.length - 1)] + 1,
      exact: false,
    };
  }
  return null;
}

/** Below this, an opening is common enough to match a paragraph it has nothing to do with. */
const MIN_PARTIAL_CHARS = 24;
