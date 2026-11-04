/**
 * A flagged Consistency Report check says where in the chapter it is looking.
 *
 * Eric, 2026-11-04: "I want the Consistency Report items located too." The engine now writes the
 * passages a check's findings quote onto the check; reports stored before that are matched to their
 * stored findings by dimension, and failing that to whatever the advice quotes. A passing check
 * offers nothing — there is nothing to fix.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '../../test/test-utils';
import QAReportPanel, { quotesFor } from './QAReportPanel';

// Partial mock: the module has other exports the providers rely on.
vi.mock('../../hooks/useEngineJobQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useEngineJobQueue')>()),
  useEngineJobQueue: () => ({ stateOf: () => 'idle', trackJob: vi.fn() }),
}));

const SENTENCE = 'She sat with this idea for a moment.';

describe('quotesFor', () => {
  it('uses the quotes the engine wrote on the check', () => {
    expect(quotesFor({ name: 'Story turns / pacing', status: 'NEEDS_REVIEW', details: 'add a setback', quotes: [SENTENCE] }, [])).toEqual([SENTENCE]);
  });

  it('matches an older check to the stored findings by its name', () => {
    const findings = [
      { dimension: 'story_turn_density', quote: SENTENCE },
      { dimension: 'prose_transparent', quote: 'elsewhere' },
    ];
    expect(quotesFor({ name: 'Story turns / pacing', status: 'NEEDS_REVIEW', details: 'add a setback' }, findings)).toEqual([SENTENCE]);
  });

  it('falls back to what the advice itself quotes', () => {
    expect(
      quotesFor({ name: 'Period language', status: 'NEEDS_REVIEW', details: "The phrase 'okay, whatever' is modern." }, []),
    ).toEqual(['okay, whatever']);
  });

  it('reads the misspelt names out of a character-consistency check', () => {
    expect(
      quotesFor({ name: 'Character consistency', status: 'NEEDS_REVIEW', details: 'Possible renames: Meara→Mara, Taka-Maka→Maka-Taka; missing: Shenk' }, []),
    ).toEqual(['Meara', 'Taka-Maka']);
  });

  it('offers nothing for a passing check', () => {
    expect(quotesFor({ name: 'Dialogue', status: 'PASS', details: 'score 0.91', quotes: [SENTENCE] }, [])).toEqual([]);
  });
});

describe('QAReportPanel: show a flagged check in the chapter', () => {
  const metadata = {
    qa_report: {
      generated_at: '2026-11-04T12:00:00Z',
      overall_status: 'NEEDS_REVIEW',
      checks: [
        { name: 'Dialogue', status: 'PASS', details: 'score 0.91' },
        { name: 'Story turns / pacing', status: 'NEEDS_REVIEW', details: 'Add a fourth story turn.', quotes: [SENTENCE] },
        { name: 'No flat paragraphs', status: 'NEEDS_REVIEW', details: 'Paragraph 12 is flat.', quotes: [] },
      ],
    },
  };

  it('puts a button on the flagged check and asks the editor for its passage', () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(
      <QAReportPanel metadata={metadata} contentId="c1" contentTitle="Ch" chapterNumber={1} projectId="p" userId="u" contentText="x" onReveal={onReveal} />,
    );
    const buttons = screen.getAllByTestId('show-in-chapter');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(`“${SENTENCE}”`);
    fireEvent.click(buttons[0]);
    expect(onReveal).toHaveBeenCalledWith(SENTENCE);
    // The passing check and the flagged check with no quotes get no button; the latter says why.
    expect(screen.getByText('no passage quoted')).toBeTruthy();
  });

  it('shows nothing extra when the page cannot reveal', () => {
    renderWithProviders(
      <QAReportPanel metadata={metadata} contentId="c1" contentTitle="Ch" chapterNumber={1} projectId="p" userId="u" contentText="x" />,
    );
    expect(screen.queryByTestId('show-in-chapter')).toBeNull();
  });
});
