import { describe, it, expect } from 'vitest';
import { driftQuotes } from './driftQuotes';

const MAKA =
  "Maka-Taka: The chapter uses 'Maka-Taka' as the character's name throughout, but the outline beat names her " +
  "'Maka-Taka' in the label — however the chapter also introduces 'Taka-Maka' in the opening sentence " +
  "('Taka-Maka was still the one people came to'), which appears to be an inversion of the character's name.";

describe('driftQuotes', () => {
  it('returns the quoted passages, longest first, with the label last', () => {
    expect(driftQuotes(MAKA)).toEqual([
      'Taka-Maka was still the one people came to',
      'Maka-Taka',
      'Taka-Maka',
    ]);
  });

  it('does not treat possessive apostrophes as quotes', () => {
    expect(driftQuotes("Ben: the character's name and the author's note differ")).toEqual(['Ben']);
  });

  it('falls back to the label when nothing is quoted', () => {
    expect(driftQuotes('Sir Reginald: appears before he is introduced')).toEqual(['Sir Reginald']);
  });

  it('is empty for a finding with no anchor at all', () => {
    expect(driftQuotes('the pacing sags in the middle')).toEqual([]);
  });
});
