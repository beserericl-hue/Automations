/**
 * A drift finding points at the chapter, and a fix shows what it changed.
 *
 * Before this, "Outstanding drift" was a sentence of prose and the author had to hunt the chapter for
 * the line it meant; a kept fix listed whole paragraphs, old above new, and the changed words were
 * wherever the eye found them. Now each finding has "Show in chapter", which asks the editor for the
 * passage the finding quotes — the sentence before the name, because the name occurs on every page —
 * and each changed paragraph is a word diff with its own "Show in chapter" on the corrected text.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '../../test/test-utils';
import { EngineQaPanel } from './ContentDetail';

vi.mock('../../hooks/useChapterRepair', () => ({
  useChapterRepair: () => ({ state: 'idle', jobId: null, queue: vi.fn(), cancel: vi.fn(), cancelling: false }),
}));

const FINDING =
  "Maka-Taka: The chapter uses 'Maka-Taka' as the character's name throughout, however the chapter also " +
  "introduces 'Taka-Maka' in the opening sentence ('Taka-Maka was still the one people came to').";

describe('EngineQaPanel: show a drift finding in the chapter', () => {
  it('offers one button per quoted passage, the sentence first, and asks the editor for the one clicked', () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(
      <EngineQaPanel
        contentId="c1"
        onReveal={onReveal}
        metadata={{ drift_report: { aligned: false, character_drift: [FINDING] } }}
      />,
    );
    const buttons = screen.getAllByTestId('show-in-chapter');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '“Taka-Maka was still the one people came to”',
      '“Maka-Taka”',
      '“Taka-Maka”',
    ]);
    fireEvent.click(buttons[0]);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith('Taka-Maka was still the one people came to');
  });

  it('marks a quote the chapter no longer contains, and leaves the others clickable', () => {
    const onReveal = vi.fn((q: string) => (q === 'Taka-Maka' ? 'exact' : 'missing'));
    renderWithProviders(
      <EngineQaPanel contentId="c1" onReveal={onReveal} metadata={{ drift_report: { aligned: false, story_drift: [FINDING] } }} />,
    );
    const [sentence, , name] = screen.getAllByTestId('show-in-chapter');
    fireEvent.click(sentence);
    expect(sentence.textContent).toContain('not found in chapter');
    fireEvent.click(name);
    expect(name.textContent).toBe('“Taka-Maka”');
    expect(onReveal.mock.calls.map((c) => c[0])).toEqual(['Taka-Maka was still the one people came to', 'Taka-Maka']);
  });

  it('says so when a finding quotes nothing to look for', () => {
    renderWithProviders(
      <EngineQaPanel contentId="c1" onReveal={vi.fn()} metadata={{ drift_report: { aligned: false, story_drift: ['the pacing sags in the middle'] } }} />,
    );
    expect(screen.queryByTestId('show-in-chapter')).toBeNull();
    expect(screen.getByText('no passage quoted')).toBeTruthy();
  });
});

describe('EngineQaPanel: what a kept fix changed', () => {
  const repair = {
    kept: true,
    at: '2026-11-04T12:00:00Z',
    resolved: ['Maka-Taka'],
    changes: [
      {
        paragraph: 1,
        before: 'Taka-Maka was still the one people came to when a pot cracked.',
        after: 'Maka-Taka was still the one people came to when a pot cracked.',
      },
    ],
  };

  it('marks the removed and added words, and can show the corrected paragraph', () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(
      <EngineQaPanel contentId="c1" onReveal={onReveal} metadata={{ drift_report: { aligned: true }, last_repair: repair }} />,
    );
    const diff = screen.getByTestId('repair-diff');
    expect(diff.querySelector('del')?.textContent).toBe('Taka-Maka');
    expect(diff.querySelector('ins')?.textContent).toBe('Maka-Taka');
    // The unchanged words are neither struck out nor marked added.
    expect(diff.textContent).toContain('was still the one people came to');
    expect(diff.querySelectorAll('del, ins')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('show-in-chapter'));
    expect(onReveal).toHaveBeenCalledWith(repair.changes[0].after);
  });

  it('offers no "show in chapter" for a fix that was not kept — the chapter does not contain it', () => {
    renderWithProviders(
      <EngineQaPanel
        contentId="c1"
        onReveal={vi.fn()}
        metadata={{ drift_report: { aligned: false, story_drift: [] }, last_repair: { ...repair, kept: false, verdict: 'ROLLED BACK — broke a fact' } }}
      />,
    );
    expect(screen.getByTestId('repair-diff')).toBeTruthy();
    expect(screen.queryByTestId('show-in-chapter')).toBeNull();
  });
});
