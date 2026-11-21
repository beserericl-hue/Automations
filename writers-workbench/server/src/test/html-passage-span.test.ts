import { describe, it, expect } from 'vitest';
import { buildCraftAnnotations, locateSpan, replacementForSpan } from '../routes/content-actions.js';

// A chapter the editor has saved is HTML; a review finding quotes it as plain text with a blank line
// between paragraphs. The two used to be unrelated, so such a finding could be read and never applied.
const HTML = '<p>He put the binders in the passenger seat.</p><p>Renata did not know about the deadline. It was June.</p><p>Next.</p>';
const QUOTE = 'He put the binders in the passenger seat.\n\nRenata did not know about the deadline.';

describe('a quote that spans paragraphs of an HTML chapter', () => {
  it('is located by its words, through the tags between them', () => {
    const span = locateSpan(HTML, QUOTE)!;
    expect(HTML.slice(span.from, span.to)).toBe('He put the binders in the passenger seat.</p><p>Renata did not know about the deadline.');
  });

  it('is null when the passage has been rewritten', () => {
    expect(locateSpan(HTML, 'He put the folders in the passenger seat.\n\nRenata knew.')).toBeNull();
  });

  it('is found through entities for quotes and ampersands', () => {
    expect(locateSpan('<p>Tom &amp; Jerry said &quot;no way at all&quot; today.</p>', 'Tom & Jerry said "no way at all" today.')).not.toBeNull();
  });

  it('writes the replacement the way the chapter is written: paragraphs as <p>, markup escaped', () => {
    expect(replacementForSpan('One & two.\n\nThree <here>.', '<p>a</p><p>b')).toBe('One &amp; two.</p><p>Three &lt;here&gt;.');
    expect(replacementForSpan('Plain.\n\nText.', 'plain text span')).toBe('Plain.\n\nText.');
  });

  it('keeps a finding applicable instead of reducing it to a note', () => {
    const meta = {
      craft_findings: {
        findings: [{ dimension: 'story_turn_density', quote: QUOTE, problem: 'late turn', replacement: 'Rewritten.' }],
      },
    };
    const [a] = buildCraftAnnotations(meta, 35, HTML, new Set());
    expect(a.suggestion?.action).toBe('replace');
    expect(a.suggestion?.replacement_text).toBe('Rewritten.');
    expect(a.resolved).toBeUndefined();
  });
});
