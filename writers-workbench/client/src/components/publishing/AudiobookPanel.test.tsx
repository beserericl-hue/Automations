/**
 * The audiobook screen: choose the narrator, hear it, build, see each chapter as its own recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent, within } from '../../test/test-utils';
import AudiobookPanel, { clock } from './AudiobookPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const OPTIONS = {
  voices: [
    { id: 'marin', label: 'Marin', note: 'Recommended' },
    { id: 'cedar', label: 'Cedar', note: 'Recommended' },
    { id: 'onyx', label: 'Onyx' },
  ],
  styles: [
    { id: 'fiction', label: 'Storyteller', description: 'Warm, engaged and expressive.' },
    { id: 'thriller', label: 'Tense', description: 'Low and controlled.' },
  ],
  max_custom_style: 600,
  credits_per_unit: 8,
  unit_words: 1000,
};

const item = (kind: string, n: number, title: string, over: Record<string, unknown> = {}) => ({
  id: null, kind, chapter_number: n, title, words: kind === 'chapter' ? 1500 : 12, status: 'none', error: null, stale: false,
  duration_s: null, size_bytes: null, rms_db: null, peak_db: null, spec_ok: null, url: null, download_url: null,
  filename: `${title}.mp3`, ...over,
});
const ready = (id: string) => ({ id, status: 'ready', duration_s: 754, size_bytes: 18_100_000, rms_db: -20.4, peak_db: -3.5, spec_ok: true, url: `https://s/${id}.mp3?token=t`, download_url: `https://s/${id}.mp3?token=t&download=x` });

let state: Record<string, any>;
function book(over: Record<string, any> = {}) {
  return {
    volume: 1, volumes: 1, title: 'The Ossuary', author: 'Eric Beser', buildable: true,
    settings: { voice: 'marin', style: 'fiction', custom_style: '', credits: true },
    items: [item('opening', 0, 'Opening credits'), item('chapter', 1, 'Chapter 1. The Door'), item('chapter', 2, 'Chapter 2. Rain'), item('closing', 0, 'Closing credits')],
    sample: { id: null, status: 'none', error: null, duration_s: null, spec_ok: null, url: null, download_url: null, can_build: false },
    summary: { total: 4, ready: 0, building: 0, failed: 0, stale: 0, missing: 4, duration_s: 0, size_bytes: 0, out_of_spec: 0 },
    cost: { credits_per_unit: 8, unit_words: 1000, to_build_credits: 24, total_credits: 24 },
    cover: { available: true, url: null },
    ...over,
  };
}
const bodyOf = (suffix: string, method = 'POST') => {
  const call = mockFetch.mock.calls.filter(([p, o]) => String(p).endsWith(suffix) && ((o as { method?: string })?.method ?? 'GET') === method).pop();
  expect(call, `no ${method} to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
};

beforeEach(() => {
  state = book();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (p, o) => {
    const path = String(p);
    const method = (o as { method?: string } | undefined)?.method ?? 'GET';
    if (path === '/api/audiobook/options') return { success: true, data: OPTIONS } as never;
    if (path.includes('/names')) return { success: true, data: { names: [{ word: 'Siobhan', count: 12 }, { word: 'Mara', count: 40 }] } } as never;
    if (path.startsWith('/api/audiobook/project/') && method === 'GET') return { success: true, data: state } as never;
    if (path.endsWith('/preview')) return { success: true, data: { audio_b64: 'bXAz', content_type: 'audio/mpeg' } } as never;
    if (path.endsWith('/build')) return { success: true, data: { queued: 4, skipped_in_progress: 0, credits_charged: 24 } } as never;
    return { success: true, data: {} } as never;
  });
  // jsdom has no media playback.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

describe('clock', () => {
  it('writes lengths the way a player does', () => {
    expect(clock(125)).toBe('2:05');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(null)).toBe('—');
  });
});

describe('AudiobookPanel', () => {
  it('says the narrator is a synthetic voice and what that means for Audible’s ACX route', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const notice = await screen.findByTestId('audiobook-notice');
    expect(notice).toHaveTextContent('synthetic (A.I.) voice');
    expect(notice).toHaveTextContent('ACX');
  });

  it('lists every recording as not built, with the price to build it all', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const list = await screen.findByTestId('audiobook-recordings');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getAllByText('Not built')).toHaveLength(4);
    expect(screen.getByTestId('audiobook-build')).toHaveTextContent('Build the audiobook · 24 credits');
    expect(screen.getByTestId('audiobook-summary')).toHaveTextContent('0 of 4 recordings ready');
  });

  it('building sends the book and shows what it charged', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.click(await screen.findByTestId('audiobook-build'));
    await waitFor(() => expect(bodyOf('/build')).toEqual({ volume: 1 }));
    expect(await screen.findByText('Narrating 4 recordings · 24 credits')).toBeInTheDocument();
  });

  it('each finished chapter is its own recording: a player, a download and its measured length', async () => {
    state = book({
      items: [item('opening', 0, 'Opening credits', ready('o')), item('chapter', 1, 'Chapter 1. The Door', ready('c1')), item('chapter', 2, 'Chapter 2. Rain', { id: 'c2', status: 'building' }), item('closing', 0, 'Closing credits')],
      summary: { total: 4, ready: 2, building: 1, failed: 0, stale: 0, missing: 1, duration_s: 1508, size_bytes: 36_200_000, out_of_spec: 0 },
      cost: { credits_per_unit: 8, unit_words: 1000, to_build_credits: 2, total_credits: 24 },
    });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const ch1 = await screen.findByTestId('recording-chapter-1');
    expect(within(ch1).getByText('Ready')).toBeInTheDocument();
    expect(ch1).toHaveTextContent('12:34');
    expect(within(ch1).getByRole('link', { name: 'Download' })).toHaveAttribute('href', 'https://s/c1.mp3?token=t&download=x');
    expect(screen.getByTestId('player-chapter-1')).toHaveAttribute('src', 'https://s/c1.mp3?token=t');
    expect(within(screen.getByTestId('recording-chapter-2')).getByText('Narrating…')).toBeInTheDocument();
    expect(screen.getByTestId('audiobook-summary')).toHaveTextContent('2 of 4 recordings ready · 25:08');
    expect(screen.getByTestId('audiobook-summary')).toHaveTextContent('1 narrating');
  });

  it('a chapter edited since it was recorded says so and is what the build button offers', async () => {
    state = book({
      items: [item('opening', 0, 'Opening credits', ready('o')), item('chapter', 1, 'Chapter 1. The Door', { ...ready('c1'), stale: true }), item('chapter', 2, 'Chapter 2. Rain', ready('c2')), item('closing', 0, 'Closing credits', ready('z'))],
      summary: { total: 4, ready: 3, building: 0, failed: 0, stale: 1, missing: 0, duration_s: 3000, size_bytes: 72_000_000, out_of_spec: 0 },
      cost: { credits_per_unit: 8, unit_words: 1000, to_build_credits: 16, total_credits: 24 },
    });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(within(await screen.findByTestId('recording-chapter-1')).getByText('Changed since recorded')).toBeInTheDocument();
    expect(screen.getByTestId('audiobook-build')).toHaveTextContent('Build 1 recording · 16 credits');
  });

  it('a failed recording shows why, and "Try again" rebuilds just that one', async () => {
    state = book({
      items: [item('opening', 0, 'Opening credits', ready('o')), item('chapter', 1, 'Chapter 1. The Door', { id: 'c1', status: 'failed', error: 'speech provider error: 429' }), item('chapter', 2, 'Chapter 2. Rain', ready('c2')), item('closing', 0, 'Closing credits', ready('z'))],
      summary: { total: 4, ready: 3, building: 0, failed: 1, stale: 0, missing: 0, duration_s: 1500, size_bytes: 3, out_of_spec: 0 },
    });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const row = await screen.findByTestId('recording-chapter-1');
    expect(row).toHaveTextContent('speech provider error: 429');
    fireEvent.click(within(row).getByText('Try again'));
    await waitFor(() => expect(bodyOf('/build')).toEqual({ volume: 1, item_ids: ['c1'] }));
  });

  it('changing the voice must be saved before building; saving sends the whole narrator', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.change(await screen.findByTestId('audiobook-voice'), { target: { value: 'cedar' } });
    fireEvent.click(screen.getByTestId('audiobook-style-thriller'));
    fireEvent.change(screen.getByTestId('audiobook-custom-style'), { target: { value: 'a touch slower' } });
    fireEvent.click(screen.getByTestId('audiobook-credits'));
    expect(screen.getByTestId('audiobook-build')).toBeDisabled();
    fireEvent.click(screen.getByTestId('audiobook-save'));
    await waitFor(() =>
      expect(bodyOf('/settings', 'PUT')).toEqual({ volume: 1, voice: 'cedar', style: 'thriller', custom_style: 'a touch slower', credits: false }),
    );
  });

  it('a changed style offers save and re-narrate next to the choices, with the price; it saves first, then builds', async () => {
    state = book({
      items: [item('opening', 0, 'Opening credits', ready('o')), item('chapter', 1, 'Chapter 1. The Door', ready('c1')), item('chapter', 2, 'Chapter 2. Rain', ready('c2')), item('closing', 0, 'Closing credits', ready('z'))],
      summary: { total: 4, ready: 4, building: 0, failed: 0, stale: 0, missing: 0, duration_s: 3000, size_bytes: 72_000_000, out_of_spec: 0 },
      cost: { credits_per_unit: 8, unit_words: 1000, to_build_credits: 0, total_credits: 24 },
    });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('audiobook-build')).toBeDisabled(); // everything is built
    expect(screen.queryByTestId('audiobook-unsaved')).toBeNull();
    fireEvent.click(screen.getByTestId('audiobook-style-thriller'));
    const bar = screen.getByTestId('audiobook-unsaved');
    expect(within(bar).getByText('Save narrator')).toBeInTheDocument();
    fireEvent.click(within(bar).getByTestId('audiobook-save-renarrate'));
    await waitFor(() => expect(bodyOf('/build')).toEqual({ volume: 1 }));
    expect(bodyOf('/settings', 'PUT')).toMatchObject({ volume: 1, style: 'thriller' });
    const order = mockFetch.mock.calls.map(([p]) => String(p)).filter((p) => p.endsWith('/settings') || p.endsWith('/build'));
    expect(order).toEqual(['/api/audiobook/project/p1/settings', '/api/audiobook/project/p1/build']);
  });

  it('before anything is built, a changed narrator only offers Save (nothing to re-narrate)', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.click(await screen.findByTestId('audiobook-style-thriller'));
    expect(screen.getByTestId('audiobook-save')).toBeInTheDocument();
    expect(screen.queryByTestId('audiobook-save-renarrate')).toBeNull();
  });

  it('pronunciation guide: add a suggested name, say how it sounds, hear it, and save it with the narrator', async () => {
    state = book({ settings: { voice: 'marin', style: 'fiction', custom_style: '', credits: true, pronunciations: [{ word: 'Mara', say: 'Mah-rah' }] } });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const guide = await screen.findByTestId('audiobook-guide');
    expect(screen.getByTestId('guide-word-0')).toHaveValue('Mara');
    expect(screen.getByTestId('guide-say-0')).toHaveValue('Mah-rah');
    // Names already in the guide are not offered again; others are, with how often they appear.
    expect(within(guide).queryByTestId('guide-suggest-Mara')).toBeNull();
    fireEvent.click(await within(guide).findByTestId('guide-suggest-Siobhan'));
    fireEvent.change(screen.getByTestId('guide-say-1'), { target: { value: 'Shivawn' } });
    fireEvent.click(screen.getByTestId('guide-hear-1'));
    await waitFor(() => expect(bodyOf('/preview')).toMatchObject({ say: 'Siobhan' }));
    expect(bodyOf('/preview').pronunciations).toEqual([{ word: 'Mara', say: 'Mah-rah' }, { word: 'Siobhan', say: 'Shivawn' }]);
    fireEvent.click(screen.getByTestId('audiobook-save'));
    await waitFor(() =>
      expect(bodyOf('/settings', 'PUT').pronunciations).toEqual([{ word: 'Mara', say: 'Mah-rah' }, { word: 'Siobhan', say: 'Shivawn' }]),
    );
  });

  it('a guide line can be removed, which makes the narrator unsaved', async () => {
    state = book({ settings: { voice: 'marin', style: 'fiction', custom_style: '', credits: true, pronunciations: [{ word: 'Mara', say: 'Mah-rah' }] } });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.click(await screen.findByTestId('guide-remove-0'));
    expect(screen.queryByTestId('guide-row-0')).toBeNull();
    expect(screen.getByTestId('audiobook-unsaved')).toBeInTheDocument();
  });

  it('"Hear it on my book" reads with the voice and style on screen and plays the answer', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.change(await screen.findByTestId('audiobook-voice'), { target: { value: 'onyx' } });
    fireEvent.click(screen.getByTestId('audiobook-preview'));
    await waitFor(() => expect(bodyOf('/preview')).toMatchObject({ volume: 1, voice: 'onyx', style: 'fiction' }));
    await waitFor(() => expect(screen.getByTestId('audiobook-preview-audio')).toHaveAttribute('src', 'data:audio/mpeg;base64,bXAz'));
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('the retail sample can only be cut once the first chapter is done', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('audiobook-make-sample')).toBeDisabled();
    expect(screen.getByText('Available once the first chapter is narrated.')).toBeInTheDocument();
  });

  it('shows the square cover once made, with a JPEG download', async () => {
    state = book({ cover: { available: true, url: 'https://s/cover.jpg?token=t' } });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('audiobook-cover')).toHaveAttribute('src', 'https://s/cover.jpg?token=t');
    expect(screen.getByTestId('audiobook-cover-download').getAttribute('href')).toContain('&download=');
  });

  it('a book with no chapter text is told to write some first', async () => {
    state = book({ buildable: false, items: [] });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByText(/no chapter text yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('audiobook-build')).toBeNull();
  });

  it('a series asks which book, and reads that book', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={3} />);
    fireEvent.change(await screen.findByTestId('audiobook-volume'), { target: { value: '2' } });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/audiobook/project/p1?volume=2'));
  });
});
