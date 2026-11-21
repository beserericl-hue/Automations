import { describe, it, expect } from 'vitest';
import { readPresets } from '../routes/format-presets.js';

describe('saved formatting looks', () => {
  it('reads a stored list, cleaning every style and dropping duplicates and nameless entries', () => {
    const stored = JSON.stringify([
      { name: 'Letter', style: { font: 'typewriter', size: 95, indent: 2 } },
      { name: 'letter', style: { font: 'serif' } },
      { name: '  ', style: {} },
      { name: 'Poem', style: { font: 'not-a-font', align: 'center', size: 5000 } },
    ]);
    const out = readPresets(stored);
    expect(out.map((p) => p.name)).toEqual(['Letter', 'Poem']);
    expect(out[0].style).toMatchObject({ preset: 'Letter', font: 'typewriter', size: 95, indent: 2 });
    expect(out[1].style).toMatchObject({ font: 'serif', align: 'center', size: 150 });
  });

  it('treats anything unexpected as an empty list', () => {
    expect(readPresets(null)).toEqual([]);
    expect(readPresets('not json')).toEqual([]);
    expect(readPresets({ a: 1 })).toEqual([]);
  });
});
