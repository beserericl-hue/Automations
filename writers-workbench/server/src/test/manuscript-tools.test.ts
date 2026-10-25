/**
 * Finding and renaming a name across a manuscript, on the case that prompted it: "Seven" in The
 * Ossuary, which is the boy's age, a number elsewhere, and reads as a name.
 */
import { describe, it, expect } from 'vitest';
import { applyRename, findMentions, nameAmbiguity, namesInText } from '../lib/manuscript-tools.js';

const PASSAGE =
  'The boy would be seven now. Or near enough.\n\nSeven was not old enough. He had received the name at twelve. ' +
  'Seven days later Bent-Reed came down to the fire. Sevenfold, the old saying went. Strikes-Twice watched from the bank.';

describe('finding mentions', () => {
  it('finds whole, case-sensitive words with context, and nothing inside longer words', () => {
    const m = findMentions(PASSAGE, 'Seven', 'c1');
    expect(m.map((x) => x.match)).toEqual(['Seven', 'Seven']);
    expect(m[0].id).toBe(`c1:${PASSAGE.indexOf('Seven was')}`);
    expect(m[0].after.startsWith(' was not old enough')).toBe(true);
    expect(m.every((x) => !x.after.startsWith('fold'))).toBe(true);
  });

  it('handles hyphenated names', () => {
    expect(findMentions(PASSAGE, 'Bent-Reed', 'c1')).toHaveLength(1);
  });
});

describe('a name a reader may not take as a name', () => {
  it('says why: a number word, also used lower-case in the manuscript', () => {
    expect(nameAmbiguity('Seven', PASSAGE)).toBe(
      '"Seven" is also a number, and the manuscript also uses "seven" as an ordinary word 1 time, so a reader may not take it as a name.',
    );
    expect(nameAmbiguity('Bent-Reed', PASSAGE)).toBeNull();
  });
});

describe('renaming at the places the author chose', () => {
  it('changes only the ticked mentions', () => {
    const [nameUse, dayUse] = findMentions(PASSAGE, 'Seven', 'c1');
    const out = applyRename(PASSAGE, 'Seven', 'Tashaw', [nameUse.offset]);
    expect(out.text).toContain('Tashaw was not old enough');
    expect(out.text).toContain('Seven days later');
    expect(out.applied).toEqual([nameUse.offset]);
    expect(dayUse.offset).toBeGreaterThan(nameUse.offset);
  });

  it('keeps later offsets right when several change, whatever the new length', () => {
    const offs = findMentions(PASSAGE, 'Seven', 'c1').map((m) => m.offset);
    const out = applyRename(PASSAGE, 'Seven', 'Ni', offs);
    expect(out.text).toContain('Ni was not old enough');
    expect(out.text).toContain('Ni days later');
    expect(out.skipped).toEqual({});
  });

  it('refuses a mention that no longer holds the name, and says so', () => {
    const edited = PASSAGE.replace('Seven was', 'Eight was');
    const off = PASSAGE.indexOf('Seven was');
    const out = applyRename(edited, 'Seven', 'Tashaw', [off]);
    expect(out.text).toBe(edited);
    expect(out.skipped[off]).toMatch(/changed/);
  });
});

describe('names in a chapter that the story bible may not have', () => {
  it('finds mid-sentence capitalised names, including hyphenated ones', () => {
    const names = namesInText(`${PASSAGE} Later Strikes-Twice and Bent-Reed spoke.`);
    expect(names).toEqual(expect.arrayContaining(['Bent-Reed', 'Strikes-Twice']));
    expect(names).not.toContain('Seven');
  });
});
