import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import PostCalendar, { addDays, mondayOf } from './PostCalendar';
import RadarPanel from './RadarPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));
vi.mock('../../contexts/UserContext', async (orig) => ({
  ...(await orig<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: 'u1' } }),
}));

const monday = mondayOf(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()));

const POSTS = [
  {
    id: 'a', display_number: 12, title: 'Angels want a product', body_md: '# x', linkedin_content: 'li', seo_title: '',
    meta_description: '', category: 'AI & DATA', include_image: true, post_status: 'published',
    channels: ['website', 'li_agile'], scheduled_date: monday, slot: 'morning', state: 'partial', attempts: 1,
    posted_at: null, last_error: 'li_agile: Blotato failed: Account connection has expired (5002)', source: 'trend_batch',
    item_type: 'blog', source_url: null,
    deliveries: [
      { channel: 'website', status: 'published', attempts: 1, public_url: 'https://www.techahir.com/blog/angels', detail: '', updated_at: '' },
      { channel: 'li_agile', status: 'failed', attempts: 1, public_url: null, detail: 'Blotato failed: Account connection has expired (5002)', updated_at: '' },
    ],
  },
  {
    id: 'b', display_number: 13, title: 'Claude Code tips', body_md: '', linkedin_content: 'post', seo_title: '',
    meta_description: '', category: 'ROUNDUP', include_image: false, post_status: 'published', channels: ['li_agile'],
    scheduled_date: addDays(monday, 1), slot: 'afternoon', state: 'posted', attempts: 1, posted_at: null, last_error: null,
    source: 'roundup_batch', item_type: 'article', source_url: null,
    deliveries: [{ channel: 'li_agile', status: 'dry_run', attempts: 1, public_url: null, detail: 'dry run', updated_at: '' }],
  },
];
const CHANNELS = [
  { channel: 'website', kind: 'website', label: 'TechAhir website', enabled: true },
  { channel: 'li_agile', kind: 'linkedin', label: 'Agile Ad Testing page', enabled: true },
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/api/social/calendar')) return { success: true, data: POSTS };
    if (path === '/api/social/channels') return { success: true, data: CHANNELS };
    if (path === '/api/social/radar/trend') {
      return {
        success: true,
        data: {
          radar: 'trend', subscribed: true, week_of: '2026-11-02',
          run: { week_of: '2026-11-02', status: 'ok', error: null, finished_at: null, stats: {} },
          topics: [
            { id: 't1', rank: 1, title: 'Seed rounds want traction', url: 'https://x/1', source: 'TechCrunch', item_type: 'article', angle: 'a', score: 96, summary: '', also_covered_by: [] },
            { id: 't2', rank: 2, title: 'Ship in days', url: 'https://x/2', source: 'YC', item_type: 'article', angle: 'b', score: 90, summary: '', also_covered_by: [] },
          ],
          queued: { t2: { display_number: 9, state: 'pending', scheduled_date: '2026-11-03', slot: 'morning' } },
        },
      };
    }
    return { success: true, jobId: 'job-1' };
  });
});

describe('week maths', () => {
  it('finds the Monday of a week and steps days without time zone drift', () => {
    expect(mondayOf('2026-11-05')).toBe('2026-11-02');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');
  });
});

describe('PostCalendar', () => {
  it('puts each post in its day and slot, flags dry runs, and shows each channel\'s result', async () => {
    renderWithProviders(<PostCalendar />);
    const first = await screen.findByTestId('post-12');
    expect(first).toHaveTextContent('Partly posted');
    expect(screen.getByTestId(`day-${monday}`)).toContainElement(first);
    expect(screen.getByTestId(`day-${addDays(monday, 1)}`)).toContainElement(screen.getByTestId('post-13'));
    expect(screen.getByTestId('dry-run-banner')).toBeInTheDocument();
    fireEvent.click(first);
    const deliveries = await screen.findByTestId('deliveries');
    expect(deliveries).toHaveTextContent('TechAhir website: Posted');
    expect(deliveries).toHaveTextContent('Account connection has expired (5002)');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('RadarPanel', () => {
  it('schedules the selected topics, and a topic already on the calendar cannot be picked again', async () => {
    renderWithProviders(<RadarPanel />);
    const queued = await screen.findByTestId('topic-2');
    expect(queued).toHaveTextContent('On the calendar as #9');
    expect(queued.querySelector('input')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Select all not scheduled' }));
    fireEvent.click(screen.getByTestId('schedule-selected'));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/social/radar/trend/schedule', {
        method: 'POST', body: JSON.stringify({ numbers: [1] }),
      }),
    );
  });
});
