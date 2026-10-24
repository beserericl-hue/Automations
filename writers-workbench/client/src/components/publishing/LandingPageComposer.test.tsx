/**
 * The landing-page form.
 *
 * Asserted: what goes out (the sample URL, and archival photos only when ticked), what comes back
 * is shown (the script, the facts with their sources, what the sample did that the page will not),
 * and that a project missing its copy cannot generate at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import LandingPageComposer from './LandingPageComposer';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

const PHOTO = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Billy Tayac',
  license: 'CC BY 2.0',
  url: 'https://x/p.jpg',
  credit: 'Photo: Billy Tayac. by Jay Baker. CC BY 2.0',
};

const SCRIPT = {
  id: 's1',
  created_at: '2026-10-24T12:00:00Z',
  sample_url: 'https://offer.michaelreit.com/',
  plan: [
    { kind: 'hero', cta: true },
    { kind: 'proof', cta: true },
    { kind: 'offer', cta: false },
  ],
  skipped: ['reader reviews: none exist; the proof slot carries sourced history instead'],
  warnings: [],
  prompt: 'Build a one-page sales landing page for THE OSSUARY',
  preview_html: '<html><body>preview</body></html>',
  facts_audit: [
    {
      text: 'Alice and Henry Ferguson excavated the site between 1935 and 1940.',
      quote: 'Alice and Henry Ferguson excavated it between 1935 and 1940.',
      report_id: 'r1',
      report_topic: 'The Ossuary — Chapter 3 research',
    },
  ],
  rejected_facts: [{ text: 'x', reasons: ['1453 is not in the quote'] }],
};

function state(over: Record<string, unknown> = {}, current: unknown = null) {
  return {
    success: true,
    data: {
      current,
      history: [],
      inputs: {
        missing: [],
        author_photo_url: 'https://x/author.png',
        cover_url: 'https://x/cover.png',
        volumes: 3,
        research_reports: 201,
        reference_photos: [PHOTO],
        ...over,
      },
    },
  };
}

function bodyOf(suffix: string, method = 'POST') {
  const call = mockFetch.mock.calls.find(
    ([p, o]) => String(p).endsWith(suffix) && (o as { method?: string } | undefined)?.method === method,
  );
  expect(call, `no ${method} to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('generating the script', () => {
  it('sends the sample URL and no archival photo unless one is ticked', async () => {
    mockFetch.mockImplementation(async (_p, o) => ((o as { method?: string })?.method === 'POST' ? { success: true, data: SCRIPT } : state()) as never);
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    fireEvent.change(await screen.findByLabelText(/Sample page URL/), { target: { value: 'https://offer.michaelreit.com/?utm_source=ig' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate the script' }));
    await waitFor(() =>
      expect(bodyOf('/api/landing-page/project/p1')).toEqual({
        sample_url: 'https://offer.michaelreit.com/?utm_source=ig',
        reference_photo_ids: [],
      }),
    );
  });

  it('includes an archival photo only when ticked', async () => {
    mockFetch.mockImplementation(async (_p, o) => ((o as { method?: string })?.method === 'POST' ? { success: true, data: SCRIPT } : state()) as never);
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate the script' }));
    await waitFor(() => expect(bodyOf('/api/landing-page/project/p1').reference_photo_ids).toEqual([PHOTO.id]));
  });

  it('cannot generate while the project is missing its copy, and says what is missing', async () => {
    mockFetch.mockResolvedValue(state({ missing: ['an approved bio (Settings, Author Profile)'] }) as never);
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    expect(await screen.findByText('an approved bio (Settings, Author Profile)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate the script' })).toBeDisabled();
  });

  it('points to Author Profile when there is no author photo', async () => {
    mockFetch.mockResolvedValue(state({ author_photo_url: null }) as never);
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    expect(await screen.findByRole('link', { name: 'Add one in Author Profile' })).toHaveAttribute('href', '/settings/author');
  });
});

describe('a new script', () => {
  it('replaces the old one on screen as soon as it is saved, before any refetch', async () => {
    const fresh = { ...SCRIPT, id: 's2', prompt: 'THE NEW SCRIPT' };
    let gets = 0;
    mockFetch.mockImplementation(async (_p, o) => {
      if ((o as { method?: string } | undefined)?.method === 'POST') return { success: true, data: fresh } as never;
      gets++;
      // Every GET after the first hangs, as a slow refetch would.
      return (gets === 1 ? state({}, SCRIPT) : new Promise(() => {})) as never;
    });
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    expect(await screen.findByLabelText('Landing page script')).toHaveValue(SCRIPT.prompt);
    fireEvent.click(screen.getByRole('button', { name: 'Generate a new script' }));
    await waitFor(() => expect(screen.getByLabelText('Landing page script')).toHaveValue('THE NEW SCRIPT'));
    expect(screen.getByText('Earlier scripts (1)')).toBeInTheDocument();
  });
});

describe('the saved script', () => {
  it('shows the script, the sections, the facts with their sources, and what was left out', async () => {
    mockFetch.mockResolvedValue(state({}, SCRIPT) as never);
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    expect(await screen.findByLabelText('Landing page script')).toHaveValue(SCRIPT.prompt);
    expect(screen.getByText('1. Hero · button')).toBeInTheDocument();
    expect(screen.getByText('3. Pre-order form')).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.skipped[0])).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.facts_audit[0].report_topic)).toBeInTheDocument();
    expect(screen.getByText(/1 proposed fact failed verification/)).toBeInTheDocument();
    expect(screen.getByTitle('Landing page preview')).toHaveAttribute('sandbox', '');
  });

  it('checks the published page and shows what changed', async () => {
    const checked = {
      ...SCRIPT,
      last_check: {
        url: 'https://book.example.com/',
        checked_at: '2026-10-24T13:00:00Z',
        result: {
          ok: false,
          facts: { verbatim_blocks: '11/12' },
          findings: [{ severity: 'error', code: 'copy_changed', message: 'blurb paragraph 2 is missing or reworded' }],
        },
      },
    };
    let checkedYet = false;
    mockFetch.mockImplementation(async (p, o) => {
      if (String(p).endsWith('/check')) {
        checkedYet = true;
        return { success: true, data: checked.last_check.result } as never;
      }
      return (o as { method?: string } | undefined)?.method ? ({} as never) : (state({}, checkedYet ? checked : SCRIPT) as never);
    });
    renderWithProviders(<LandingPageComposer projectId="p1" />);
    fireEvent.change(await screen.findByLabelText('Check the page GHL published'), { target: { value: 'https://book.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(bodyOf('/check')).toEqual({ url: 'https://book.example.com/' }));
    expect(await screen.findByText('blurb paragraph 2 is missing or reworded')).toBeInTheDocument();
    expect(screen.getByTestId('landing-check-result')).toHaveTextContent('11/12 passages unchanged');
  });
});
