import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import SeriesBiblePanel, { parseSeriesBible, pickSeriesBible, isSeriesBibleEntry } from './SeriesBiblePanel';
import type { StoryBibleEntry } from '../../types/database';

// The exact shape writer_engine.persist_helpers.persist_canon writes.
const DESC =
  'SYNOPSIS: A preservation officer fights to repatriate ossuary remains.\nThe story moves between two centuries.\n' +
  'STORY ARC: The Descent and Return\n' +
  'TARGET CHAPTER COUNT: 4\n' +
  'DRAMATIC QUESTION: Can Renee win recognition before the file closes?';

const entry = (o: Partial<StoryBibleEntry> = {}): StoryBibleEntry =>
  ({
    id: 'sb1', user_id: 'u1', project_id: 'p1', entry_type: 'concept', name: 'Series Bible', description: DESC,
    chapter_introduced: null, metadata: {}, created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T23:11:54Z', ...o,
  }) as StoryBibleEntry;

describe('parseSeriesBible', () => {
  it('reads every labelled field the engine writes, keeping a multi-line synopsis', () => {
    expect(parseSeriesBible(DESC)).toEqual({
      synopsis: 'A preservation officer fights to repatriate ossuary remains.\nThe story moves between two centuries.',
      storyArc: 'The Descent and Return',
      targetChapterCount: 4,
      dramaticQuestion: 'Can Renee win recognition before the file closes?',
      other: [],
    });
  });

  it('keeps an unknown label, and treats an unlabelled description as the synopsis', () => {
    expect(parseSeriesBible(`${DESC}\nTHEMES: grief, memory`).other).toEqual([{ label: 'THEMES', value: 'grief, memory' }]);
    expect(parseSeriesBible('Just a premise.')).toMatchObject({ synopsis: 'Just a premise.', targetChapterCount: null });
  });
});

describe('pickSeriesBible / isSeriesBibleEntry', () => {
  it('finds the most recently updated Series Bible and only that kind of row', () => {
    const older = entry({ id: 'old', updated_at: '2026-01-01T00:00:00Z' });
    const character = entry({ id: 'c1', entry_type: 'character', name: 'Renee' });
    expect(pickSeriesBible([older, character, entry()])!.id).toBe('sb1');
    expect(isSeriesBibleEntry(character)).toBe(false);
    expect(isSeriesBibleEntry(entry({ entry_type: 'character' }))).toBe(false);
    expect(pickSeriesBible([character])).toBeNull();
  });
});

describe('SeriesBiblePanel', () => {
  it('shows synopsis, arc, chapter count and dramatic question', () => {
    renderWithProviders(<SeriesBiblePanel entry={entry()} outlineChapterCount={4} />);
    expect(screen.getByTestId('series-bible-synopsis')).toHaveTextContent('repatriate ossuary remains');
    expect(screen.getByTestId('series-bible-arc')).toHaveTextContent('The Descent and Return');
    expect(screen.getByTestId('series-bible-chapters')).toHaveTextContent('4');
    expect(screen.getByTestId('series-bible-question')).toHaveTextContent('Can Renee win recognition');
    expect(screen.queryByTestId('series-bible-stale')).toBeNull();
  });

  it('flags a chapter count the outline has moved past', () => {
    renderWithProviders(<SeriesBiblePanel entry={entry()} outlineChapterCount={9} />);
    expect(screen.getByTestId('series-bible-stale')).toHaveTextContent('The outline now has 9 chapters');
  });

  it('says there is none yet', () => {
    renderWithProviders(<SeriesBiblePanel entry={null} />);
    expect(screen.getByTestId('series-bible-empty')).toHaveTextContent('none yet');
  });
});
