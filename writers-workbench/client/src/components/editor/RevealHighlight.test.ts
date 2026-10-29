/**
 * Finding a quoted passage in the manuscript.
 *
 * The quote in a review finding came from the stored plain text; the editor holds that text parsed
 * into HTML blocks. Between the two, paragraph breaks stop being newlines, whitespace collapses,
 * and a quote spanning two paragraphs has a gap in one representation and not the other. An exact
 * string search fails on most real findings, which is why the matching is what it is — and why it
 * is worth pinning down here rather than discovering in the pane.
 *
 * The positions are asserted by reading the text back out of the document, so a test cannot pass
 * by agreeing with the implementation about an offset that is wrong.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { findInDoc, RevealHighlight, revealPluginKey, REVEAL_CLASS } from './RevealHighlight';

// Every editor is destroyed after its test. A live ProseMirror view keeps a DOM-observer timer, and
// one left running fires after the test environment is torn down ("document is not defined"),
// which fails the whole run on timing alone.
const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function makeEditor(html: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), RevealHighlight],
    content: html,
  });
  editors.push(editor);
  return editor;
}

function docOf(html: string) {
  // The document is immutable, so it outlives the editor that parsed it.
  return makeEditor(html).state.doc;
}

/** What the found range actually covers, with whitespace normalised as the matcher sees it. */
function textAt(doc: ReturnType<typeof docOf>, from: number, to: number): string {
  return doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim();
}

const CHAPTER = [
  '<p>The spring ran on below him, thin and clear, catching the light where it moved over the dark rocks.</p>',
  '<p>He crouched at the bluff edge, slowly, his knees making the sound they always made now, and looked at the face of the stone.</p>',
  '<p>His hand was larger. The print was a young person&rsquo;s hand, or a woman&rsquo;s. He did not know which. He did not need to know.</p>',
  '<p>The stone had kept it.</p>',
].join('');

describe('finding the passage a finding points at', () => {
  it('finds a sentence sitting inside a paragraph', () => {
    const doc = docOf(CHAPTER);
    const hit = findInDoc(doc, 'He did not know which.')!;
    expect(hit).toBeTruthy();
    expect(hit.exact).toBe(true);
    expect(textAt(doc, hit.from, hit.to)).toBe('He did not know which.');
  });

  it('finds a whole short paragraph', () => {
    const doc = docOf(CHAPTER);
    const hit = findInDoc(doc, 'The stone had kept it.')!;
    expect(textAt(doc, hit.from, hit.to)).toBe('The stone had kept it.');
  });

  it('does not run the end of one paragraph into the start of the next', () => {
    const doc = docOf(CHAPTER);
    // If block boundaries were ignored, "rocks.He crouched" would be one word and this would match.
    expect(findInDoc(doc, 'dark rocks.He crouched at the bluff')).toBeNull();
  });

  it('finds a quote that spans a paragraph break', () => {
    const doc = docOf(CHAPTER);
    const hit = findInDoc(doc, 'He did not need to know.\n\nThe stone had kept it.')!;
    expect(hit).toBeTruthy();
    expect(textAt(doc, hit.from, hit.to)).toBe('He did not need to know. The stone had kept it.');
  });

  it('survives the quote being stored with different whitespace', () => {
    const doc = docOf(CHAPTER);
    const hit = findInDoc(doc, '  He   crouched at the bluff edge,\n slowly,  ')!;
    expect(textAt(doc, hit.from, hit.to)).toBe('He crouched at the bluff edge, slowly,');
  });

  it('matches across straight and curly quotes', () => {
    const doc = docOf(CHAPTER);
    // The prose has a typographic apostrophe; the finding carries the ASCII one.
    const hit = findInDoc(doc, "The print was a young person's hand")!;
    expect(hit).toBeTruthy();
    expect(textAt(doc, hit.from, hit.to)).toBe('The print was a young person’s hand');
  });

  it('matches across dash forms', () => {
    const doc = docOf('<p>Seven was not old enough — and yet. He had received the name at twelve.</p>');
    const hit = findInDoc(doc, 'Seven was not old enough - and yet.')!;
    expect(hit).toBeTruthy();
    expect(textAt(doc, hit.from, hit.to)).toBe('Seven was not old enough — and yet.');
  });

  it('falls back to the opening when the end of the sentence has been edited', () => {
    const doc = docOf(CHAPTER);
    const hit = findInDoc(doc, 'He crouched at the bluff edge, slowly, and thought about nothing at all.')!;
    expect(hit).toBeTruthy();
    // Flagged as inexact, so the panel can warn rather than imply the quote is still accurate.
    expect(hit.exact).toBe(false);
    expect(textAt(doc, hit.from, hit.to)).toContain('He crouched at the bluff edge');
  });

  it('reports a passage that is simply gone', () => {
    const doc = docOf(CHAPTER);
    expect(findInDoc(doc, 'She drove the truck back down the fire road and did not look behind her.')).toBeNull();
  });

  it('refuses to match on something too short to be distinctive', () => {
    const doc = docOf(CHAPTER);
    // "the" appears everywhere; landing on an arbitrary one is worse than saying nothing.
    expect(findInDoc(doc, 'the')).toBeNull();
    expect(findInDoc(doc, '  ')).toBeNull();
  });

  it('handles an empty document without throwing', () => {
    expect(findInDoc(docOf('<p></p>'), 'anything at all here')).toBeNull();
  });

  it('finds a passage in the last paragraph of a long chapter', () => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `<p>Paragraph ${i}: the gravel gave one sharp crack and then went quiet.</p>`,
    ).join('');
    const doc = docOf(`${filler}<p>He had carried the slab eleven days.</p>`);
    const hit = findInDoc(doc, 'He had carried the slab eleven days.')!;
    expect(textAt(doc, hit.from, hit.to)).toBe('He had carried the slab eleven days.');
  });

  it('finds the whole of a quote that carries markdown italics the editor shows as italics', () => {
    // The finding from OSSUARY II, Stratum XV: three paragraphs, the middle one italic. Matching
    // stopped at the asterisk, so only the first paragraph lit up and it read as "changed".
    const doc = docOf(
      '<p>He thought: what is the name for?</p>' +
        '<p>He had asked the woman this, when he was twelve. He had asked it because he did not know better.</p>' +
        '<p>She had said: <em>the name is for the place.</em></p>' +
        '<p>He had not understood that either.</p><p>He thought about the boy.</p>',
    );
    const hit = findInDoc(
      doc,
      'He had asked the woman this, when he was twelve. He had asked it because he did not know better.\n\n' +
        'She had said: *the name is for the place.*\n\nHe had not understood that either.',
    )!;
    expect(hit.exact).toBe(true);
    expect(textAt(doc, hit.from, hit.to)).toBe(
      'He had asked the woman this, when he was twelve. He had asked it because he did not know better. ' +
        'She had said: the name is for the place. He had not understood that either.',
    );
  });

  it('lands on the passage, not a few characters off, when an ellipsis comes before it', () => {
    // The folded projection writes … as three dots; each must still point at the one real character.
    const doc = docOf('<p>He waited… and waited… and then the gravel cracked.</p><p>The boy’s hand was steady.</p>');
    const hit = findInDoc(doc, "The boy's hand was steady.")!;
    expect(textAt(doc, hit.from, hit.to)).toBe('The boy’s hand was steady.');
  });
});

describe('revealing does not touch the manuscript', () => {
  const editorOf = makeEditor;

  it('leaves the document unchanged and never fires onUpdate', () => {
    const editor = editorOf(CHAPTER);
    const before = editor.getHTML();
    let updates = 0;
    editor.on('update', () => {
      updates += 1;
    });

    const hit = findInDoc(editor.state.doc, 'The stone had kept it.')!;
    editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, { from: hit.from, to: hit.to }));

    // The highlight is a decoration. If it were a mark, this chapter would be dirty, the two-second
    // auto-save would fire, and the highlight would be written into the prose — and from there into
    // the EPUB. The assertion is the whole reason for the extension.
    expect(editor.getHTML()).toBe(before);
    expect(updates).toBe(0);
    expect(editor.getHTML()).not.toContain(REVEAL_CLASS);
  });

  it('puts the decoration on the passage, and clears it on request', () => {
    const editor = editorOf(CHAPTER);
    const hit = findInDoc(editor.state.doc, 'The stone had kept it.')!;

    editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, { from: hit.from, to: hit.to }));
    const set = revealPluginKey.getState(editor.state)!;
    const decorations = set.find();
    expect(decorations).toHaveLength(1);
    expect(decorations[0].from).toBe(hit.from);
    expect(decorations[0].to).toBe(hit.to);

    editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, null));
    expect(revealPluginKey.getState(editor.state)!.find()).toHaveLength(0);
  });

  it('follows the passage when the author edits somewhere above it', () => {
    const editor = editorOf(CHAPTER);
    const hit = findInDoc(editor.state.doc, 'The stone had kept it.')!;
    editor.view.dispatch(editor.state.tr.setMeta(revealPluginKey, { from: hit.from, to: hit.to }));

    // Insert text near the top. A decoration pinned to a fixed offset would now be sitting on the
    // wrong words; one mapped through the transaction stays on the sentence it marked.
    editor.view.dispatch(editor.state.tr.insertText('Once more. ', 1));

    const moved = revealPluginKey.getState(editor.state)!.find()[0];
    expect(editor.state.doc.textBetween(moved.from, moved.to, ' ', ' ').trim()).toBe(
      'The stone had kept it.',
    );
  });
});
