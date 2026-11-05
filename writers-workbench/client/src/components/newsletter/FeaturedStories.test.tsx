/**
 * Featured stories on ANY edition: radar posts from every edition and slate topics from every radar can
 * be chosen for the next issue (Eric, 2026-11-05).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import FeaturedStories from './FeaturedStories';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));

const LIBRARY = {
  posts: [
    { id: 'p1', display_number: 7, title: 'Agents in CI', state: 'posted', source_url: 'https://x/1', item_type: 'blog', edition_id: 'ai-mvp', scheduled_date: '2026-11-03', posted_at: '2026-11-03T14:00:00Z' },
    { id: 'p2', display_number: 9, title: 'A roundup link', state: 'approved', source_url: 'https://x/2', item_type: 'article', edition_id: 'ai-dev-roundup', scheduled_date: null, posted_at: null },
  ],
  topics: [{ id: 't1', radar: 'trend', week_of: '2026-11-02', rank: 3, title: 'Angels want product', url: 'https://x/3', item_type: 'article', source: 'TechCrunch' }],
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/studio/library') return { data: LIBRARY };
    if (path === '/api/studio/wasteland-wire/issue' && init?.method === 'PUT') return { data: { selection: { id: 's1', status: 'open' }, items: [], last_issue: null, message: 'Chosen 2 stories for the next issue.' } };
    if (path === '/api/studio/wasteland-wire/issue') return { data: { selection: null, items: [], last_issue: null } };
    return { data: {} };
  });
});

describe('FeaturedStories', () => {
  it('offers every radar post (any edition) and topic, and saves the chosen ones in order', async () => {
    renderWithProviders(<FeaturedStories editionId="wasteland-wire" />);
    expect(await screen.findByTestId('featured-add-post-7')).toBeInTheDocument();
    expect(screen.getByTestId('featured-stories')).toHaveTextContent('ai-mvp'); // where it came from
    fireEvent.click(screen.getByTestId('featured-add-topic-trend-2026-11-02-3'));
    fireEvent.click(screen.getByTestId('featured-add-post-7'));
    expect(screen.getByTestId('featured-item-1')).toHaveTextContent('Angels want product');
    expect(screen.getByTestId('featured-item-2')).toHaveTextContent('Agents in CI');
    expect(screen.getByTestId('featured-add-post-7')).toBeDisabled();
    fireEvent.click(screen.getByTestId('featured-save'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/studio/wasteland-wire/issue', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ items: [{ kind: 'topic', id: 't1' }, { kind: 'post', id: 'p1' }] }),
    })));
    expect(await screen.findByRole('status')).toHaveTextContent('Chosen 2 stories');
  });

  it('filters the library by title', async () => {
    renderWithProviders(<FeaturedStories editionId="wasteland-wire" />);
    await screen.findByTestId('featured-add-post-7');
    fireEvent.change(screen.getByTestId('featured-filter'), { target: { value: 'roundup' } });
    expect(screen.queryByTestId('featured-add-post-7')).toBeNull();
    expect(screen.getByTestId('featured-add-post-9')).toBeInTheDocument();
  });
});
