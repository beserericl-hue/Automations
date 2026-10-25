/**
 * The review rail's new tools: the AI-written flag on suggestions, Characters, and the Humanizer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import { aiTells, summarizeTells } from '../../lib/aiTells';
import CharactersPanel from './CharactersPanel';
import HumanizerPanel from './HumanizerPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);
beforeEach(() => mockFetch.mockReset());

const bodyOf = (suffix: string) => {
  const call = mockFetch.mock.calls.find(([p, o]) => String(p).endsWith(suffix) && (o as { method?: string })?.method === 'POST');
  expect(call, `no POST to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
};

describe('AI tells', () => {
  it('counts em dashes and stock phrases, and names them', () => {
    const t = aiTells('Seven was not old enough — and yet. He had been — in that moment — afraid.');
    expect(summarizeTells(t)).toBe('3 em dashes, “and yet”, “in that moment”');
    expect(aiTells('He walked to the river and sat down.')).toEqual([]);
  });
});

const THREADS = {
  name: 'Seven', total: 2, chapters_with_mentions: 2,
  ambiguity: '"Seven" is also a number, so a reader may not take it as a name.',
  threads: [
    { content_id: 'c4', chapter_number: 4, title: 'Ochre slab', mentions: [{ id: 'c4:30', offset: 30, before: 'enough.\n\n', match: 'Seven', after: ' was not old enough.' }] },
    { content_id: 'c5', chapter_number: 5, title: 'The spring', mentions: [{ id: 'c5:0', offset: 0, before: '', match: 'Seven', after: ' days later the band moved.' }] },
  ],
};

describe('Characters', () => {
  function serve() {
    mockFetch.mockImplementation(async (p, o) => {
      const path = String(p);
      if (path.endsWith('/characters')) return { success: true, data: { characters: [{ name: 'Bent-Reed', source: 'cast', description: '', mentions_here: 1 }] } } as never;
      if (path.includes('/characters/threads')) return { success: true, data: THREADS } as never;
      if (path.endsWith('/characters/rename') && (o as { method?: string })?.method === 'POST')
        return { success: true, data: { applied: 1, skipped: 0, chapters: [{ applied: 1 }], records_updated: 0 } } as never;
      if (path.endsWith('/characters/check'))
        return { success: true, data: { findings: [{ kind: 'ambiguity', explanation: 'Reads as a name and an age.', quotes: ['Seven was not old enough.'], suggestion: 'Seven winters was not old enough.' }], dropped: 0, passages: 2 } } as never;
      return { success: true, data: {} } as never;
    });
  }

  it('shows every use of a looked-up name across chapters, and warns when it is also a word', async () => {
    serve();
    renderWithProviders(<CharactersPanel contentId="c4" />);
    fireEvent.change(screen.getByLabelText('Look up a name'), { target: { value: 'Seven' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('2 uses in 2 chapters')).toBeInTheDocument();
    expect(screen.getByText(/also a number/)).toBeInTheDocument();
    expect(screen.getByText(/Ch 5/)).toBeInTheDocument();
  });

  it('starts an ambiguous rename with nothing ticked, and sends only the uses ticked', async () => {
    serve();
    renderWithProviders(<CharactersPanel contentId="c4" />);
    fireEvent.change(screen.getByLabelText('Look up a name'), { target: { value: 'Seven' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByText('2 uses in 2 chapters');
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    expect(screen.getByText('0 of 2 uses ticked')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Rename “Seven” to/), { target: { value: 'Tashaw' } });
    fireEvent.click(screen.getByLabelText('Rename this use in chapter 4'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename 1 use' }));
    await waitFor(() => expect(bodyOf('/characters/rename')).toMatchObject({ from: 'Seven', to: 'Tashaw', mention_ids: ['c4:30'] }));
  });

  it('shows a consistency finding with its quote, its kind, and its suggestion flagged as AI-written', async () => {
    serve();
    renderWithProviders(<CharactersPanel contentId="c4" />);
    fireEvent.change(screen.getByLabelText('Look up a name'), { target: { value: 'Seven' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByText('2 uses in 2 chapters');
    fireEvent.click(screen.getByRole('button', { name: 'Check consistency' }));
    const findings = await screen.findByTestId('character-findings');
    expect(findings).toHaveTextContent('ambiguity');
    expect(findings).toHaveTextContent('Seven was not old enough.');
    expect(findings).toHaveTextContent('AI-written');
  });
});

describe('Humanizer', () => {
  it('runs the selected passage and replaces it only when asked', async () => {
    mockFetch.mockImplementation(async (p) =>
      (String(p).endsWith('/humanize')
        ? { success: true, data: { original: 'Seven was not old enough — not yet.', text: 'He was too young yet.', changed: true, detectability: 18, charged_credits: 22 } }
        : { success: true, data: { replaced: true } }) as never,
    );
    renderWithProviders(<HumanizerPanel contentId="c4" getSelection={() => 'Seven was not old enough — not yet.'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the selected text' }));
    expect(screen.getByTestId('humanizer-before')).toHaveTextContent('Seven was not old enough');
    expect(screen.getByText(/1 em dash/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run through the humanizer' }));
    const result = await screen.findByTestId('humanizer-result');
    expect(result).toHaveTextContent('He was too young yet.');
    expect(result).toHaveTextContent('detection score 18');
    expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/humanize/apply'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace in manuscript' }));
    await waitFor(() => expect(bodyOf('/humanize/apply')).toEqual({ original: 'Seven was not old enough — not yet.', replacement: 'He was too young yet.' }));
  });

  it('asks for a selection when there is none', () => {
    renderWithProviders(<HumanizerPanel contentId="c4" getSelection={() => ''} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the selected text' }));
    expect(screen.getByText('Select a passage in the editor first.')).toBeInTheDocument();
  });

  it('humanizes a suggestion sent from Review, to replace the passage it would fix', async () => {
    mockFetch.mockResolvedValue({ success: true, data: { text: 'Better.', changed: true } } as never);
    renderWithProviders(<HumanizerPanel contentId="c4" getSelection={() => ''} seed={{ text: 'Suggested — text.', passage: 'Original passage.', nonce: 1 }} />);
    expect(screen.getByText(/Replacing will put the result in place of: “Original passage.”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run through the humanizer' }));
    await screen.findByTestId('humanizer-result');
    fireEvent.click(screen.getByRole('button', { name: 'Replace in manuscript' }));
    await waitFor(() => expect(bodyOf('/humanize/apply')).toEqual({ original: 'Original passage.', replacement: 'Better.' }));
  });
});
