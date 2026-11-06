/**
 * Radars are per account: the Radars page sets one up for THIS user — on/off, the edition it feeds, the
 * channels, the slate email and the brand voice (Eric, 2026-11-05).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import RadarPanel from './RadarPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));
vi.mock('../../contexts/UserContext', async (orig) => ({ ...(await orig<typeof import('../../contexts/UserContext')>()), useUser: () => ({ profile: { user_id: 'u1' } }) }));
vi.mock('../../hooks/useEngineJobQueue', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useEngineJobQueue')>()),
  useEngineJobQueue: () => ({ trackJob: vi.fn(), stateOf: () => 'idle' }),
}));

const RADARS = {
  radars: [
    { radar: 'trend', subscribed: false, enabled: false, edition_id: null, channels: [], slate_email: true, brand: {}, last_run: null },
    { radar: 'dev', subscribed: true, enabled: true, edition_id: 'ai-dev-roundup', channels: ['li_agile'], slate_email: true, brand: { name: 'TechAhir' }, last_run: { week_of: '2026-11-02', status: 'ok' } },
  ],
  editions: [{ id: 'my-letter', name: 'My letter' }, { id: 'ai-dev-roundup', name: 'AI Dev Roundup' }],
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/social/radars') return { success: true, data: RADARS };
    if (path === '/api/studio/editions') return { data: [{ edition_id: 'ai-mvp', name: 'The MVP Brief', radar: 'trend', channels: [], cadence: null }, { edition_id: 'ai-dev-roundup', name: 'AI Dev Roundup', radar: 'dev', channels: [], cadence: null }] };
    if (path === '/api/social/channels') return { success: true, data: [{ channel: 'website', kind: 'website', label: 'My blog', enabled: true }, { channel: 'threads_me', kind: 'threads', label: 'Threads · me', enabled: true }] };
    if (path.startsWith('/api/social/radar/trend') && !path.includes('/run')) return { success: true, data: { radar: 'trend', subscribed: false, week_of: null, run: null, topics: [], queued: {} } };
    return { success: true, data: {} };
  });
});

describe('RadarPanel setup', () => {
  it('a radar not yet set up opens its setup; saving switches it on for this account with edition, channels and brand', async () => {
    renderWithProviders(<RadarPanel />);
    expect(await screen.findByTestId('radar-setup-trend-state')).toHaveTextContent('not set up');
    expect(await screen.findByTestId('radar-setup-trend-enabled')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('radar-setup-trend-enabled'));
    fireEvent.change(screen.getByTestId('radar-setup-trend-edition'), { target: { value: 'my-letter' } });
    fireEvent.click(await screen.findByTestId('radar-setup-trend-channel-threads_me'));
    fireEvent.change(screen.getByTestId('radar-setup-trend-brand-name'), { target: { value: 'Kent Smith Studio' } });
    fireEvent.change(screen.getByTestId('radar-setup-trend-brand-cta_url'), { target: { value: 'https://kentsmith.studio/call' } });
    fireEvent.click(screen.getByTestId('radar-setup-trend-save'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/social/radar/trend', expect.objectContaining({ method: 'PUT' })));
    const call = vi.mocked(apiFetch).mock.calls.find((c) => c[0] === '/api/social/radar/trend' && (c[1] as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      enabled: true, edition_id: 'my-letter', channels: ['threads_me'], slate_email: true, brand: { name: 'Kent Smith Studio', cta_url: 'https://kentsmith.studio/call' },
    });
    expect(await screen.findByText('Saved. This radar runs weekly for your account.')).toBeInTheDocument();
  });

  it('the page no longer names one customer: the blurbs are about the account’s own brand', async () => {
    renderWithProviders(<RadarPanel />);
    await screen.findByTestId('radar-panel');
    expect(screen.getByTestId('radar-panel')).not.toHaveTextContent('TechAhir');
  });

  it('has the command line, command help, review and send-to-scheduler on the Radars page itself, per radar', async () => {
    renderWithProviders(<RadarPanel />);
    expect(await screen.findByTestId('studio-assistant')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('assistant-commands-toggle'));
    expect(screen.getByTestId('assistant-commands')).toHaveTextContent('schedule all approved');
    expect(screen.getByTestId('studio-tab-review')).toBeInTheDocument();
    expect(screen.getByTestId('studio-tab-history')).toBeInTheDocument();
    expect(screen.getByTestId('content-studio')).toHaveTextContent('Trend Radar');
    // switching to the Dev radar shows the Dev radar's edition, not the Trend one
    fireEvent.click(screen.getByRole('tab', { name: /dev/i }));
    await waitFor(() => expect(screen.getByTestId('content-studio')).toHaveTextContent('Dev Radar'));
  });
});
