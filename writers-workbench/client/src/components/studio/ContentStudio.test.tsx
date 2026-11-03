import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import ContentStudio from './ContentStudio';
import { apiFetch } from '../../lib/api';
import { parseRanks } from '../../lib/studio';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));
vi.mock('../../lib/studio', async (orig) => ({
  ...(await orig<typeof import('../../lib/studio')>()),
  waitForJob: () => new Promise(() => {}),
}));

const EDITION = { edition_id: 'ai-dev-roundup', name: 'AI Dev Roundup', radar: 'dev', channels: ['li_agile'], cadence: 'weekly' };
const TOPICS = [
  { id: 't1', rank: 1, title: 'Agents in CI', url: 'https://x/1', source: 'HN', item_type: 'article', angle: 'why', score: null, summary: '', also_covered_by: [], week_of: '2026-11-02', post: null },
  { id: 't2', rank: 2, title: 'A talk', url: 'https://youtube.com/watch?v=a', source: 'YT', item_type: 'video', angle: '', score: null, summary: '', also_covered_by: [], week_of: '2026-11-02',
    post: { id: 'p1', display_number: 7, state: 'draft', scheduled_date: null, slot: 'morning', edition_id: 'ai-dev-roundup' } },
  { id: 't3', rank: 3, title: 'Third', url: 'https://x/3', source: 'HN', item_type: 'article', angle: '', score: null, summary: '', also_covered_by: [], week_of: '2026-11-02', post: null },
];
const DRAFT = {
  id: 'p1', display_number: 7, external_id: 'studio-dev', title: 'A talk', body_md: '', linkedin_content: 'Hook\n🔗 Watch: https://youtube.com/watch?v=a',
  seo_title: '', meta_description: '', category: 'VIDEO', include_image: false, image_url: null, channels: ['li_agile'], scheduled_date: null,
  slot: 'morning', scheduled_at: null, post_at: null, state: 'draft', last_error: null, source: 'studio', item_type: 'video', source_url: 'https://youtube.com/watch?v=a',
  radar_topic_id: 't2', studio: { rank: 2, revisions: [] }, deliveries: [],
};

let editions: unknown[] = [EDITION];

function render(path: string) {
  window.history.pushState({}, '', path);
  return renderWithProviders(
    <Routes>
      <Route path="/newsletter/studio" element={<ContentStudio />} />
      <Route path="/newsletter/studio/:editionId" element={<ContentStudio />} />
    </Routes>,
  );
}

beforeEach(() => {
  editions = [EDITION];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/studio/editions') return { data: editions };
    if (path === '/api/studio/ai-dev-roundup') return { data: { edition: EDITION, channels: [{ channel: 'li_agile', kind: 'linkedin', label: 'Agile page', enabled: true }], weeks: ['2026-11-02'], run: null } };
    if (path.startsWith('/api/studio/ai-dev-roundup/slate')) return { data: { radar: 'dev', week_of: '2026-11-02', topics: TOPICS } };
    if (path.startsWith('/api/studio/ai-dev-roundup/posts')) return { data: [DRAFT] };
    if (path === '/api/studio/ai-dev-roundup/generate') return { jobId: 'job-1', creditsCharged: 6 };
    if (path === '/api/studio/ai-dev-roundup/assistant') return { data: { kind: 'data', op: 'queue', message: '', jobId: null, result: { message: '#7 | not scheduled | draft | A talk' }, error: null, creditsCharged: 0 } };
    if (path === '/api/studio/ai-dev-roundup/posts/actions') return { data: { message: 'Approved: #7.' } };
    return { data: {} };
  });
});

describe('parseRanks', () => {
  it('expands ranges, keeps order, drops numbers not on the slate', () => {
    expect(parseRanks('1-3, 8 and 12-13', [1, 2, 3, 4, 8, 12])).toEqual([1, 2, 3, 8, 12]);
    expect(parseRanks('5-3', [3, 4, 5])).toEqual([3, 4, 5]);
    expect(parseRanks('x, 99', [1])).toEqual([]);
  });
});

describe('ContentStudio', () => {
  it('says there is nothing for a user without a radar edition', async () => {
    editions = [];
    render('/newsletter/studio');
    expect(await screen.findByTestId('studio-empty')).toBeInTheDocument();
  });

  it('says not found for an edition that is not the user\'s', async () => {
    render('/newsletter/studio/someone-elses');
    expect(await screen.findByTestId('studio-not-found')).toBeInTheDocument();
  });

  it('shows the slate with what each topic became, selects by range text, and drafts the selection', async () => {
    render('/newsletter/studio/ai-dev-roundup');
    expect(await screen.findByTestId('slate-topic-1')).toHaveTextContent('Agents in CI');
    expect(screen.getByTestId('slate-topic-2-post')).toHaveTextContent('#7 · Draft');
    fireEvent.change(screen.getByTestId('slate-range'), { target: { value: '1, 3' } });
    fireEvent.click(screen.getByTestId('slate-range-apply'));
    fireEvent.click(screen.getByTestId('slate-generate'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/studio/ai-dev-roundup/generate', expect.objectContaining({ method: 'POST' })));
    const call = vi.mocked(apiFetch).mock.calls.find((c) => c[0] === '/api/studio/ai-dev-roundup/generate')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ topic_ids: ['t1', 't3'], week_of: '2026-11-02' });
    expect(await screen.findByTestId('studio-activity')).toHaveTextContent('Drafting 2 topics');
  });

  it('reviews a draft with its LinkedIn count and approves it', async () => {
    render('/newsletter/studio/ai-dev-roundup');
    fireEvent.click(await screen.findByTestId('studio-tab-review'));
    fireEvent.click(await screen.findByTestId('draft-7-open'));
    expect(screen.getByTestId('draft-7-count')).toHaveTextContent(`${DRAFT.linkedin_content.length} / 3000`);
    fireEvent.click(screen.getByTestId('draft-7-approve'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/studio/ai-dev-roundup/posts/actions', expect.objectContaining({ body: JSON.stringify({ ids: ['p1'], action: 'approve' }) })));
  });

  it('sends the assistant a command and shows the answer', async () => {
    render('/newsletter/studio/ai-dev-roundup');
    fireEvent.change(await screen.findByTestId('assistant-input'), { target: { value: 'list my drafts' } });
    fireEvent.click(screen.getByTestId('assistant-send'));
    expect(await screen.findByTestId('assistant-reply')).toHaveTextContent('#7 | not scheduled | draft | A talk');
  });

  it('shows the record of the last slate email (to, week, Postal id) and says nothing is sent before the send step', async () => {
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/studio/ai-dev-roundup/digest/emails') {
        return { data: [{ id: 'e1', to_email: 'eric@example.com', subject: 'S', postal_message_id: 'postal-77', sent_at: '2026-11-03T18:00:00Z', week_of: '2026-11-02' }] };
      }
      if (path === '/api/studio/ai-dev-roundup/issue') return { data: { selection_id: null, items: [], last_issue: null } };
      if (path === '/api/studio/ai-dev-roundup/feeds') return { data: { items: 'https://f/items.xml', digest: 'https://f/digest.xml', enabled: true } };
      return base(path, opts);
    });
    render('/newsletter/studio/ai-dev-roundup');
    fireEvent.click(await screen.findByTestId('studio-tab-issue'));
    const last = await screen.findByTestId('slate-email-last');
    expect(last).toHaveTextContent('week of 2026-11-02 to eric@example.com');
    expect(last).toHaveTextContent('postal-77');
    expect(screen.getByText(/Nothing reaches subscribers until you approve the final/i)).toBeInTheDocument();
  });
});
