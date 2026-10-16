/**
 * A6 — no story-bible row may ever be invisible.
 *
 * The bug: StoryBiblePanel grouped by a hardcoded ENTRY_TYPES list, so any row whose entry_type was
 * not in that list got filtered out and never rendered. On DEV that was 2341 of 3226 live rows
 * (72%), which is why the Story Bible tab looked like it was missing most of its content.
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_ENTRY_TYPES,
  ENTRY_TYPE_ORDER,
  entryTypeLabel,
  entryTypesPresent,
} from './story-bible-types';

const e = (entry_type: string) => ({ entry_type });

describe('entryTypesPresent', () => {
  it('returns only the types actually present, so no empty headings render', () => {
    expect(entryTypesPresent([e('character'), e('character'), e('event')])).toEqual([
      'character',
      'event',
    ]);
  });

  it('includes the engine vocabulary that the old hardcoded list dropped', () => {
    // place/object/concept were 1848 of the hidden rows on DEV.
    const types = entryTypesPresent([e('place'), e('object'), e('concept')]);
    expect(types).toContain('place');
    expect(types).toContain('object');
    expect(types).toContain('concept');
  });

  it('never drops an unrecognised type', () => {
    const types = entryTypesPresent([e('character'), e('wildly_new_type')]);
    expect(types).toContain('wildly_new_type');
  });

  it('orders canonical types first, then legacy, then unknowns', () => {
    const types = entryTypesPresent([
      e('zzz_unknown'),
      e('plot_thread'),
      e('character'),
      e('place'),
    ]);
    expect(types).toEqual(['character', 'place', 'plot_thread', 'zzz_unknown']);
  });

  it('sorts unknowns so output is stable across renders', () => {
    expect(entryTypesPresent([e('b_type'), e('a_type')])).toEqual(['a_type', 'b_type']);
  });

  it('tolerates null, undefined and empty input', () => {
    expect(entryTypesPresent(null)).toEqual([]);
    expect(entryTypesPresent(undefined)).toEqual([]);
    expect(entryTypesPresent([])).toEqual([]);
  });

  it('ignores falsy entry_type values rather than rendering a blank section', () => {
    expect(entryTypesPresent([e(''), e('character')])).toEqual(['character']);
  });
});

describe('canonical vocabulary', () => {
  it('is the engine vocabulary (the decision taken 2026-10-16)', () => {
    expect([...CANONICAL_ENTRY_TYPES]).toEqual([
      'character',
      'place',
      'object',
      'concept',
      'event',
    ]);
  });

  it('lists every canonical type before any legacy type', () => {
    const lastCanonical = Math.max(
      ...CANONICAL_ENTRY_TYPES.map((t) => ENTRY_TYPE_ORDER.indexOf(t)),
    );
    expect(lastCanonical).toBe(CANONICAL_ENTRY_TYPES.length - 1);
  });
});

describe('entryTypeLabel', () => {
  it('humanises a type it has never seen', () => {
    expect(entryTypeLabel('world_building')).toBe('World Building');
    expect(entryTypeLabel('concept')).toBe('Concept');
  });
});
