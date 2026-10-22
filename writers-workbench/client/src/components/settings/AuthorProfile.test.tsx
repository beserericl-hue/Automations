/**
 * The author profile form.
 *
 * The test that matters most here is about words, not behaviour. An earlier version put a bare
 * "1 field still empty" immediately beside the Save button, and it was read — reasonably — as the
 * reason the form would not save. The form had saved. Nothing on this page is required, and the
 * page has to say so where the question gets asked.
 *
 * The rest guards the other way a form loses work: typing several paragraphs and navigating away
 * with no indication that none of it was stored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent, within } from '../../test/test-utils';
import AuthorProfile from './AuthorProfile';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

/** A profile with everything filled in except the one optional human detail — the real case. */
const ALMOST_COMPLETE = {
  pen_name: 'Eric L Beser',
  pronouns: '',
  lives: 'Owings Mills, Maryland',
  background: 'Thirty years in signal processing, and two years researching this subject.',
  credentials: ['MSW Social Work, University of Maryland, 1974'],
  prior_work: [] as string[],
  why_this_book: 'A friend of mine was a descendent of this people.',
  personal: '',
  links: [] as string[],
  bio: '',
  bio_source: null,
  bio_updated_at: null,
  gaps: ['one human detail (optional) — it stops the bio reading as a CV'],
};

const EMPTY_PROFILE = {
  ...ALMOST_COMPLETE,
  pen_name: '',
  lives: '',
  background: '',
  credentials: [],
  why_this_book: '',
  gaps: [
    'the name to publish under — the bio has nothing to call you',
    'background — what you did before this book, especially where it touches the material',
    'where you live (optional, conventional)',
  ],
};

function serve(profile: unknown) {
  mockFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/api/author/profile' && (!opts?.method || opts.method === 'GET')) {
      return { success: true, data: profile } as never;
    }
    return { success: true, data: profile } as never;
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  serve(ALMOST_COMPLETE);
});

describe('what the form says about saving', () => {
  it('says every field is optional, right beside the Save button', async () => {
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByText(/Every field is optional/)).toBeInTheDocument();
  });

  it('never says a bare "field still empty" next to Save — that reads as a blocker', async () => {
    renderWithProviders(<AuthorProfile />);
    await screen.findByText(/Every field is optional/);
    expect(screen.queryByText(/^\d+ fields? still empty$/)).not.toBeInTheDocument();
  });

  it('explains that an empty field only means the bio will not mention it', async () => {
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByText(/the bio will not mention/)).toBeInTheDocument();
  });

  it('never disables the Save button for a missing field', async () => {
    serve(EMPTY_PROFILE);
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByRole('button', { name: 'Save facts' })).toBeEnabled();
  });

  it('confirms a save on the page, not only in a toast', async () => {
    renderWithProviders(<AuthorProfile />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save facts' }));
    await waitFor(() =>
      expect(within(screen.getByRole('status')).getByText(/^Saved at /)).toBeInTheDocument(),
    );
  });

  it('shows the reason in place when a save actually fails', async () => {
    renderWithProviders(<AuthorProfile />);
    await screen.findByRole('button', { name: 'Save facts' });
    // Rejecting only the write, so a refetch of the profile cannot consume the failure instead and
    // leave the test asserting against a save that was never attempted.
    mockFetch.mockImplementation(async (_path: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') throw new Error('background is too long');
      return { success: true, data: ALMOST_COMPLETE } as never;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    // Scoped to the save row. A toast carries the same words and disappears; the point of this
    // test is that the reason is also on the page, where it stays.
    await waitFor(() =>
      expect(within(screen.getByRole('status')).getByText('background is too long')).toBeInTheDocument(),
    );
  });
});

describe('not losing what was typed', () => {
  it('flags unsaved changes as soon as a field is edited', async () => {
    renderWithProviders(<AuthorProfile />);
    const lives = await screen.findByDisplayValue('Owings Mills, Maryland');
    fireEvent.change(lives, { target: { value: 'Baltimore, Maryland' } });
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
  });

  it('does not call typing-and-undoing a change', async () => {
    renderWithProviders(<AuthorProfile />);
    const lives = await screen.findByDisplayValue('Owings Mills, Maryland');
    fireEvent.change(lives, { target: { value: 'Baltimore' } });
    await screen.findByText('Unsaved changes');
    fireEvent.change(lives, { target: { value: 'Owings Mills, Maryland' } });
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
  });

  it('clears the flag once the save lands', async () => {
    renderWithProviders(<AuthorProfile />);
    const lives = await screen.findByDisplayValue('Owings Mills, Maryland');
    fireEvent.change(lives, { target: { value: 'Baltimore, Maryland' } });
    await screen.findByText('Unsaved changes');

    serve({ ...ALMOST_COMPLETE, lives: 'Baltimore, Maryland' });
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(screen.getByText(/^Saved at /)).toBeInTheDocument();
  });
});

describe('what is still missing', () => {
  it('does not use a warning colour when all that is left is optional', async () => {
    renderWithProviders(<AuthorProfile />);
    expect(
      await screen.findByText(/You could still add, though the bio reads fine without/),
    ).toBeInTheDocument();
    expect(screen.queryByText('The bio has no way of knowing:')).not.toBeInTheDocument();
  });

  it('does warn when something is missing that the bio actually needs', async () => {
    serve(EMPTY_PROFILE);
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByText('The bio has no way of knowing:')).toBeInTheDocument();
  });

  it('offers to write the bio once there is a real fact to write from', async () => {
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByRole('button', { name: 'Write my bio' })).toBeEnabled();
  });

  it('will not write a bio from a name alone', async () => {
    serve({ ...EMPTY_PROFILE, pen_name: 'Eric L Beser' });
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByRole('button', { name: 'Write my bio' })).toBeDisabled();
    expect(screen.getByText(/a name on its own is not enough/)).toBeInTheDocument();
  });
});

describe('pronouns', () => {
  it('offers the field, and says what happens when it is left blank', async () => {
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByText('Pronouns')).toBeInTheDocument();
    expect(screen.getByText(/uses your surname throughout rather than guessing/)).toBeInTheDocument();
  });

  it('sends them with the rest of the facts', async () => {
    renderWithProviders(<AuthorProfile />);
    const box = await screen.findByPlaceholderText('he/him · she/her · they/them');
    fireEvent.change(box, { target: { value: 'they/them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }));
    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([, o]) => (o as { method?: string })?.method === 'PUT');
      expect(JSON.parse(String((put![1] as { body: string }).body)).pronouns).toBe('they/them');
    });
  });
});

describe('a server older than this client', () => {
  it('renders the form instead of a blank page when a field is missing from the response', async () => {
    // Exactly what a rolling deploy produces for a minute: the client asks for a field the server
    // does not send yet. One undefined string used to take the whole page down on its first trim().
    const { pronouns: _dropped, ...withoutPronouns } = ALMOST_COMPLETE;
    serve(withoutPronouns);
    renderWithProviders(<AuthorProfile />);
    expect(await screen.findByDisplayValue('Eric L Beser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save facts' })).toBeEnabled();
  });
});
