/**
 * Editing a Q/A suggestion before applying it.
 *
 * The server has always accepted a `replacementText` of the caller's choosing, and the UI never
 * offered one — so the only two answers available on a flagged passage were "take the model's
 * wording" and "do nothing". These tests pin the third: the author's own words, replacing the exact
 * span the finding pins.
 *
 * What is asserted is the request body, not the button. A box you can type in that quietly posts
 * the model's wording anyway is worse than no box.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import AnnotationsPanel from './AnnotationsPanel';
import { apiFetch } from '../../lib/api';

// Partial mock: the providers this component renders inside also use the impersonation helpers,
// and replacing the whole module takes those away.
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));

const TARGET = 'She did not get out of the truck, and the heater ticked as it cooled.';
const SUGGESTED = 'She stayed in the truck. The heater ticked as it cooled.';

const ANNOTATION = {
  id: 'craft_qa:ch7:1',
  source: 'craft_qa' as const,
  severity: 'medium' as const,
  message: 'Two sentences doing one sentence of work.',
  evidence_quote: TARGET,
  evidence_context: null,
  chapter_number: 7,
  suggestion: {
    action: 'replace' as const,
    target_text: TARGET,
    replacement_text: SUGGESTED,
    delta_chars: SUGGESTED.length - TARGET.length,
  },
  dismissed: false,
};

const RESPONSE = {
  success: true,
  annotations: [ANNOTATION],
  counts: { total: 1, active: 1, by_source: { genre_eval: 0, drift_scan: 0, craft_qa: 1 } },
};

const mockFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/annotations')) return RESPONSE as never;
    return { success: true } as never;
  });
});

/** The body of the one apply call, parsed. */
function appliedBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls.find(([p]) => String(p).endsWith('/annotations/apply'));
  expect(call, 'no apply request was made').toBeTruthy();
  return JSON.parse(String((call![1] as { body?: string }).body));
}

describe('applying a craft suggestion', () => {
  it('sends no replacement when the suggestion is taken as written', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    const apply = await screen.findByRole('button', { name: 'Apply Fix' });
    fireEvent.click(apply);
    await waitFor(() => expect(appliedBody().annotationId).toBe(ANNOTATION.id));
    // Absent, not empty: the server reads the absence as "use the stored suggestion".
    expect(appliedBody()).not.toHaveProperty('replacementText');
  });

  it("sends the author's own wording when it is edited first", async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));

    const box = screen.getByRole('textbox');
    // Pre-filled with the model's wording, so a small change is a small edit.
    expect((box as HTMLTextAreaElement).value).toBe(SUGGESTED);

    const mine = 'She stayed in the truck. The heater ticked as it went cold.';
    fireEvent.change(box, { target: { value: mine } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply my version' }));

    await waitFor(() => expect(appliedBody().replacementText).toBe(mine));
  });

  it('will not apply an empty replacement, which would delete the passage', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    const button = screen.getByRole('button', { name: 'Apply my version' });
    expect(button).toBeDisabled();
  });

  it('shows what the edit costs in characters as it is typed', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: TARGET } });
    expect(screen.getByText('same length')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: `${TARGET} And then she did.` } });
    expect(screen.getByText(/^\+18 characters$/)).toBeInTheDocument();
  });

  it('can be put back to the suggestion after an edit', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'reset to suggestion' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(SUGGESTED);
  });

  it('leaves the chapter alone when the edit is cancelled', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([p]) => String(p).endsWith('/annotations/apply'))).toBe(false);
  });

  it('starts from the flagged passage when the model offered no wording', async () => {
    const noSuggestion = {
      ...RESPONSE,
      annotations: [
        {
          ...ANNOTATION,
          suggestion: { action: 'replace' as const, target_text: TARGET },
        },
      ],
    };
    mockFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/annotations')) return noSuggestion as never;
      return { success: true } as never;
    });
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(TARGET);
  });
});

describe('showing a finding in the manuscript', () => {
  it('sends the evidence quote up when the quote is clicked', async () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.click(await screen.findByText(TARGET));
    expect(onReveal).toHaveBeenCalledWith(TARGET);
  });

  it('is reachable from the keyboard', async () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.keyDown(await screen.findByText(TARGET), { key: 'Enter' });
    expect(onReveal).toHaveBeenCalledWith(TARGET);
  });

  it('warns when only the opening matched — the suggestion may answer a sentence that is gone', async () => {
    const onReveal = vi.fn().mockReturnValue('approximate');
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show in manuscript' }));
    expect(await screen.findByText(/only the opening matched/)).toBeInTheDocument();
  });

  it('says plainly when the passage is no longer in the text', async () => {
    const onReveal = vi.fn().mockReturnValue('missing');
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show in manuscript' }));
    expect(await screen.findByText(/not found in the current text/)).toBeInTheDocument();
  });

  it('scrolls there on the way into the edit box, where the context is most needed', async () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit first' }));
    expect(onReveal).toHaveBeenCalledWith(TARGET);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('is inert, not broken, where there is no editor beside the panel', async () => {
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    await screen.findByText(TARGET);
    expect(screen.queryByRole('button', { name: 'Show in manuscript' })).not.toBeInTheDocument();
    // The quote is still readable — it just is not a link to anywhere.
    expect(screen.getByText(TARGET)).not.toHaveAttribute('role', 'button');
  });

  it('falls back to the flagged span when a finding carries no quote of its own', async () => {
    const onReveal = vi.fn().mockReturnValue('exact');
    mockFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/annotations')) {
        return {
          ...RESPONSE,
          annotations: [{ ...ANNOTATION, evidence_quote: null }],
        } as never;
      }
      return { success: true } as never;
    });
    renderWithProviders(<AnnotationsPanel contentId="c1" onReveal={onReveal} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show in manuscript' }));
    expect(onReveal).toHaveBeenCalledWith(TARGET);
  });
});

describe('a finding whose passage has been rewritten', () => {
  const FIXED = {
    ...ANNOTATION,
    id: 'craft_qa:ch7:2',
    message: 'Pacing — no story turn: the slab section repeats itself.',
    evidence_quote: null,
    suggestion: { action: 'note' as const },
    resolved: true,
  };

  it('shows as fixed, with no Apply Fix, and is not counted as active', async () => {
    mockFetch.mockImplementation(async (path: string) =>
      path.endsWith('/annotations')
        ? ({ ...RESPONSE, annotations: [ANNOTATION, FIXED] } as never)
        : ({ success: true } as never),
    );
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    expect(await screen.findByText('1 active')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Apply Fix' })).toHaveLength(1);
    expect(screen.getByTestId('fixed-annotations')).toHaveTextContent('1 fixed since the report');
    expect(screen.getByTestId('fixed-annotations')).toHaveTextContent(FIXED.message);
  });

  it('says the report is dealt with when every finding is fixed', async () => {
    mockFetch.mockImplementation(async (path: string) =>
      path.endsWith('/annotations') ? ({ ...RESPONSE, annotations: [FIXED] } as never) : ({ success: true } as never),
    );
    renderWithProviders(<AnnotationsPanel contentId="c1" />);
    expect(await screen.findByText(/has been dealt with/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply Fix' })).toBeNull();
  });
});
