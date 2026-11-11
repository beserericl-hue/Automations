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

const ELEVEN_VOICES = [
  { id: 'Kb1hixP8KFa4kdSpc4yT', name: 'Eric Beser', category: 'professional', yours: true, labels: {} },
  { id: 'premade00001', name: 'Adam', category: 'premade', yours: false, labels: {} },
];
let eleven: Record<string, any> = { connected: false, voices: [] };
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
    single_file: {
      status: 'none', error: null, bytes: null, duration_s: null, chapters: null, quality: 'compact', filename: 'The-Ossuary.m4b',
      stale: false, can_build: false, default_quality: 'compact',
      qualities: [
        { id: 'compact', label: 'Compact', detail: 'AAC mono 48 kbps · about 22 MB an hour', mb_per_hour: 22 },
        { id: 'high', label: 'Higher quality', detail: 'AAC mono 64 kbps · about 30 MB an hour', mb_per_hour: 30 },
        { id: 'small', label: 'Smallest', detail: 'AAC mono 32 kbps · about 15 MB an hour', mb_per_hour: 15 },
      ],
    },
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
  eleven = { connected: false, voices: [] };
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (p, o) => {
    const path = String(p);
    const method = (o as { method?: string } | undefined)?.method ?? 'GET';
    if (path === '/api/audiobook/options') return { success: true, data: OPTIONS } as never;
    if (path === '/api/audiobook/elevenlabs/voices') return { success: true, data: eleven } as never;
    if (path === '/api/integrations/elevenlabs' && method === 'PUT') {
      eleven = { connected: true, voices: ELEVEN_VOICES };
      return { success: true, data: { ok: true, voices: 2 } } as never;
    }
    if (path === '/api/integrations/elevenlabs/key' && method === 'DELETE') {
      eleven = { connected: false, voices: [] };
      return { success: true } as never;
    }
    if (path.includes('/names')) return { success: true, data: { names: [{ word: 'Siobhan', count: 12 }, { word: 'Mara', count: 40 }] } } as never;
    if (path.startsWith('/api/audiobook/project/') && method === 'GET') return { success: true, data: state } as never;
    if (path.endsWith('/export/link')) return { success: true, data: { url: 'https://s/sign/The-Ossuary.m4b?token=t&download=The-Ossuary.m4b', filename: 'The-Ossuary.m4b', expires_at: '2099-01-08T00:00:00Z' } } as never;
    if (path.endsWith('/export') && method === 'POST') return { success: true, data: { queued: true } } as never;
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

  it('ElevenLabs: connect the key once, pick your own voice clone, save, and hear it', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    fireEvent.click(await screen.findByTestId('audiobook-provider-elevenlabs'));
    // not connected: asks for the key, with the voice list locked
    const box = await screen.findByTestId('audiobook-eleven-connect');
    expect(box).toHaveTextContent('saved encrypted');
    expect(screen.getByTestId('audiobook-voice')).toBeDisabled();
    expect(screen.getByTestId('audiobook-eleven-connect-btn')).toBeDisabled(); // nothing typed
    fireEvent.change(screen.getByTestId('audiobook-eleven-key'), { target: { value: 'sk_test_0123456789abcdef' } });
    fireEvent.click(screen.getByTestId('audiobook-eleven-connect-btn'));
    await waitFor(() => expect(bodyOf('/api/integrations/elevenlabs', 'PUT')).toEqual({ api_key: 'sk_test_0123456789abcdef' }));
    // connected: the box is gone (the key field is emptied), the voices are the author's, their clone first
    await waitFor(() => expect(screen.queryByTestId('audiobook-eleven-connect')).toBeNull());
    const select = screen.getByTestId('audiobook-voice') as HTMLSelectElement;
    expect(select).toBeEnabled();
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a voice…', 'Eric Beser — your voice', 'Adam']);
    fireEvent.change(select, { target: { value: 'Kb1hixP8KFa4kdSpc4yT' } });
    // the delivery note does not reach ElevenLabs
    expect(screen.getByTestId('audiobook-custom-style')).toBeDisabled();
    fireEvent.click(screen.getByTestId('audiobook-save'));
    await waitFor(() => expect(bodyOf('/settings', 'PUT')).toMatchObject({ provider: 'elevenlabs', voice: 'Kb1hixP8KFa4kdSpc4yT' }));
    fireEvent.click(screen.getByTestId('audiobook-preview'));
    await waitFor(() => expect(bodyOf('/preview')).toMatchObject({ provider: 'elevenlabs', voice: 'Kb1hixP8KFa4kdSpc4yT' }));
  });

  it('ElevenLabs: a key that ElevenLabs no longer accepts asks for a new one', async () => {
    eleven = { connected: false, rejected: true, voices: [] };
    state = book({ settings: { provider: 'elevenlabs', voice: 'Kb1hixP8KFa4kdSpc4yT', style: 'fiction', custom_style: '', credits: true, pronunciations: [] } });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('audiobook-eleven-connect')).toHaveTextContent('no longer accepts your saved key');

  });

  it('ElevenLabs: says it costs no Workbench credits and names what it does use', async () => {
    eleven = { connected: true, voices: ELEVEN_VOICES };
    state = book({
      settings: { provider: 'elevenlabs', voice: 'Kb1hixP8KFa4kdSpc4yT', style: 'fiction', custom_style: '', credits: true, pronunciations: [] },
      cost: { own_account: true, credits_per_unit: 0, unit_words: 1000, to_build_credits: 0, total_credits: 0 },
    });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('audiobook-price')).toHaveTextContent('no Workbench credits');
    expect(screen.getByTestId('audiobook-price')).toHaveTextContent('characters from your ElevenLabs plan');
    expect(screen.getByTestId('audiobook-build')).toHaveTextContent('Build the audiobook');
    expect(screen.getByTestId('audiobook-build')).not.toHaveTextContent('credits');
    fireEvent.click(await screen.findByTestId('audiobook-eleven-disconnect'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/integrations/elevenlabs/key', { method: 'DELETE' }));
  });

  const allBuilt = {
    items: [item('opening', 0, 'Opening credits', ready('o')), item('chapter', 1, 'Chapter 1. The Door', ready('c1')), item('chapter', 2, 'Chapter 2. Rain', ready('c2')), item('closing', 0, 'Closing credits', ready('z'))],
    summary: { total: 4, ready: 4, building: 0, failed: 0, stale: 0, missing: 0, duration_s: 7200, size_bytes: 72_000_000, out_of_spec: 0 },
    cost: { credits_per_unit: 8, unit_words: 1000, to_build_credits: 0, total_credits: 24 },
  };
  const sf = (over: Record<string, unknown>) => ({ ...book().single_file, ...over });

  it('single file: not offered until every recording is built', async () => {
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const box = await screen.findByTestId('audiobook-single-file');
    expect(box).toHaveTextContent('One file for your listening app');
    expect(box).toHaveTextContent('reloading the page never loses it');
    expect(within(box).getByTestId('file-make')).toBeDisabled();
    expect(box).toHaveTextContent('Build every recording first');
  });

  it('single file: shows what each size will be for THIS book, defaults to compact, and sends the one chosen', async () => {
    state = book({ ...allBuilt, single_file: sf({ can_build: true }) });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const box = await screen.findByTestId('audiobook-single-file');
    // 2 hours of audio: 22 / 30 / 15 MB an hour
    expect(box).toHaveTextContent('≈ 44 MB for this book');
    expect(box).toHaveTextContent('≈ 60 MB for this book');
    expect(box).toHaveTextContent('≈ 30 MB for this book');
    expect(within(box).getByTestId('file-quality-compact')).toBeChecked();
    fireEvent.click(within(box).getByTestId('file-quality-small'));
    fireEvent.click(within(box).getByTestId('file-make'));
    await waitFor(() => expect(bodyOf('/export')).toEqual({ volume: 1, quality: 'small' }));
  });

  it('single file: while it is being made the button waits; when ready it shows size, length, chapters, and gives the link', async () => {
    state = book({ ...allBuilt, single_file: sf({ can_build: true, status: 'building' }) });
    const first = renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const box = await screen.findByTestId('audiobook-single-file');
    expect(box).toHaveTextContent('Making the file…');
    expect(within(box).getByTestId('file-make')).toBeDisabled();
    first.unmount();

    state = book({ ...allBuilt, single_file: sf({ can_build: true, status: 'ready', bytes: 12_300_000, duration_s: 7200, chapters: 4 }) });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    const ready2 = await screen.findByTestId('file-facts');
    expect(ready2).toHaveTextContent('The-Ossuary.m4b · 11.7 MB · 2:00:00 · 4 chapters');
    expect(screen.queryByTestId('file-stale')).toBeNull();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    fireEvent.click(screen.getByTestId('file-copy-link'));
    const shown = await screen.findByLabelText('Link to the audiobook file');
    expect((shown as HTMLInputElement).value).toBe('https://s/sign/The-Ossuary.m4b?token=t&download=The-Ossuary.m4b');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://s/sign/The-Ossuary.m4b?token=t&download=The-Ossuary.m4b');
    expect(screen.getByTestId('file-link')).toHaveTextContent('Anyone with this link can download the file until');
  });

  it('single file: a file made from recordings that have since changed says so before it is imported', async () => {
    state = book({ ...allBuilt, single_file: sf({ can_build: true, status: 'ready', bytes: 1_000_000, duration_s: 60, chapters: 4, stale: true }) });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('file-stale')).toHaveTextContent('Make the file again before you import it');
    expect(screen.getByTestId('audiobook-single-file')).toHaveTextContent('Out of date');
  });

  it('single file: a failure says why, in words that name what to change', async () => {
    state = book({ ...allBuilt, single_file: sf({ can_build: true, status: 'failed', error: 'the audiobook file is 400 MB, more than your storage accepts in one file (Supabase\'s \'Upload file size limit\' defaults to 50 MB)' }) });
    renderWithProviders(<AudiobookPanel projectId="p1" volumeCount={1} />);
    expect(await screen.findByTestId('file-error')).toHaveTextContent('Upload file size limit');
    expect(screen.getByTestId('file-make')).toBeEnabled(); // and it can be tried again
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
