/**
 * The copy assistant beside a field: draft, revise, undo — and never over the author's text unasked.
 * All of these fail on the code before this change, which had no assistant on any of these fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import AiField, { countOf, useFieldHistory, type AssistInfo } from './AiField';
import { apiFetch, ApiError } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const ASSIST: AssistInfo = {
  price: 3,
  charged: true,
  package_fields: ['blurb', 'hook', 'keywords'],
  fields: {
    blurb: { label: 'Description', kind: 'text', limit: 4000, max_items: null, free: false },
    hook: { label: 'Hook', kind: 'text', limit: 20, max_items: null, free: false },
    keywords: { label: 'Keywords', kind: 'list', limit: 50, max_items: 7, free: false },
  },
};

const result = (value: string, warnings: string[] = []) => ({
  success: true,
  data: { field: 'blurb', value, items: [], chars: value.length, limit: 4000, over_limit: false, warnings, credits_charged: 3, credits_remaining: 97 },
});

function Harness({ initial = '', field = 'blurb' }: { initial?: string; field?: string }) {
  const [value, setValue] = useState(initial);
  const history = useFieldHistory();
  return (
    <>
      <AiField projectId="p1" volumeIndex={2} field={field} label="Description" value={value} onChange={setValue} assist={ASSIST} history={history} />
      <output data-testid="saved-value">{value}</output>
    </>
  );
}

const bodyOf = (n = 0) => JSON.parse(String((mockFetch.mock.calls[n][1] as { body: string }).body));

beforeEach(() => {
  mockFetch.mockReset();
});

describe('AiField', () => {
  it('Draft with AI fills an EMPTY field at once, shows the price, and Undo empties it again', async () => {
    mockFetch.mockResolvedValue(result('Cogwheel wakes in a gaslit room.') as never);
    renderWithProviders(<Harness />);
    const draft = screen.getByTestId('ai-draft-blurb');
    expect(draft).toHaveTextContent('Draft with AI · 3 cr');
    fireEvent.click(draft);
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Cogwheel wakes in a gaslit room.'));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/copy-assist/project/p1/assist');
    expect(bodyOf()).toEqual({ field: 'blurb', volume_index: 2, mode: 'draft' });
    expect(screen.getByTestId('count-blurb')).toHaveTextContent('32 / 4,000');
    fireEvent.click(screen.getByTestId('ai-undo-blurb'));
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.queryByTestId('ai-undo-blurb')).toBeNull();
  });

  it('a draft for a field that already has text is shown beside it; the text changes only on "Use this"', async () => {
    mockFetch.mockResolvedValue(result('A brand new description.', ['not in the book\'s material, check them: Halvorsen']) as never);
    renderWithProviders(<Harness initial="My own words." />);
    fireEvent.click(screen.getByTestId('ai-draft-blurb'));
    const proposal = await screen.findByTestId('ai-proposal-blurb');
    expect(proposal).toHaveTextContent('A brand new description.');
    expect(proposal).toHaveTextContent('Check: not in the book\'s material, check them: Halvorsen');
    expect(screen.getByLabelText('Description')).toHaveValue('My own words.');

    fireEvent.click(screen.getByTestId('ai-discard-blurb'));
    expect(screen.queryByTestId('ai-proposal-blurb')).toBeNull();
    expect(screen.getByLabelText('Description')).toHaveValue('My own words.');

    fireEvent.click(screen.getByTestId('ai-draft-blurb'));
    fireEvent.click(await screen.findByTestId('ai-accept-blurb'));
    expect(screen.getByLabelText('Description')).toHaveValue('A brand new description.');
    fireEvent.click(screen.getByTestId('ai-undo-blurb'));
    expect(screen.getByLabelText('Description')).toHaveValue('My own words.');
  });

  it('Revise with AI sends the current text and the instruction, and is undoable', async () => {
    mockFetch.mockResolvedValue(result('Shorter. Darker.') as never);
    renderWithProviders(<Harness initial="A long, slow description of the book." />);
    fireEvent.click(screen.getByTestId('ai-revise-blurb'));
    fireEvent.change(screen.getByTestId('ai-instruction-blurb'), { target: { value: 'shorter, more suspense' } });
    fireEvent.click(screen.getByTestId('ai-revise-go-blurb'));
    fireEvent.click(await screen.findByTestId('ai-accept-blurb'));
    expect(bodyOf()).toEqual({ field: 'blurb', volume_index: 2, mode: 'revise', instruction: 'shorter, more suspense', current: 'A long, slow description of the book.' });
    expect(screen.getByLabelText('Description')).toHaveValue('Shorter. Darker.');
    fireEvent.click(screen.getByTestId('ai-undo-blurb'));
    expect(screen.getByLabelText('Description')).toHaveValue('A long, slow description of the book.');
  });

  it('says how many credits it needs when the balance is short, and leaves the field alone', async () => {
    mockFetch.mockRejectedValue(new ApiError(402, 'INSUFFICIENT_CREDITS', 'no', { error: { creditsRequired: 3, creditsRemaining: 1 } }));
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByTestId('ai-draft-blurb'));
    expect(await screen.findByText(/Not enough credits: this needs 3, you have 1/)).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('shows the count against the limit and flags it in red when over', () => {
    renderWithProviders(<Harness field="hook" initial={'x'.repeat(25)} />);
    expect(screen.getByTestId('count-hook')).toHaveTextContent('25 / 20 · over the limit');
  });

  it('counts a list in items and the longest item', () => {
    expect(countOf('a\nbb\n\nccc', ASSIST.fields.keywords)).toEqual({ text: '3 of 7 · longest 3/50', over: false });
    expect(countOf(Array.from({ length: 8 }, (_, i) => `k${i}`).join('\n'), ASSIST.fields.keywords).over).toBe(true);
    expect(countOf('y'.repeat(51), ASSIST.fields.keywords).over).toBe(true);
  });
});
