/**
 * A queued Fix Drift outlives the page that started it.
 *
 * Found in use: Fix drift was queued on a chapter, the author looked at another chapter and came
 * back, and the button read "Fix drift" again while the repair was still running on the engine —
 * the job had lived in the panel's state and went when the panel unmounted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChapterRepair } from './useChapterRepair';
import { resetEngineJobs } from './useEngineJobQueue';

vi.mock('../contexts/UserContext', () => ({
  useUser: () => ({ profile: { user_id: 'u1' } }),
}));

function Probe({ contentId }: { contentId: string }) {
  const r = useChapterRepair(contentId, [['project-chapters', 'p1']]);
  return (
    <div>
      <span data-testid="state">{r.state}</span>
      <button onClick={() => void r.queue()}>fix</button>
    </div>
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineJobs();
});

function withClient(ui: React.ReactElement, client = new QueryClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

/** The repair POST answers with a job id; the status poll answers with `status`. */
function engine(status: string) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/repair')
      ? new Response(JSON.stringify({ success: true, jobId: 'job-9' }), { status: 202 })
      : new Response(JSON.stringify({ status })),
  ) as typeof fetch;
}

describe('Fix drift outlives the page that queued it', () => {
  it('still shows the repair as queued after leaving the chapter and coming back', async () => {
    engine('running');
    const first = withClient(<Probe contentId="ch1" />);
    await act(async () => screen.getByText('fix').click());
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('queued'));

    first.unmount(); // the author opens another chapter
    withClient(<Probe contentId="ch1" />);
    expect(screen.getByTestId('state')).toHaveTextContent('queued');
  });

  it('does not show another chapter as being fixed', async () => {
    engine('running');
    withClient(<Probe contentId="ch1" />);
    await act(async () => screen.getAllByText('fix')[0].click());
    const other = withClient(<Probe contentId="ch2" />);
    expect(other.getAllByTestId('state').at(-1)).toHaveTextContent('idle');
  });

  it('refreshes the chapter page when the repair finishes, even if it was queued elsewhere', async () => {
    engine('running');
    const first = withClient(<Probe contentId="ch1" />);
    await act(async () => screen.getByText('fix').click());
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('queued'));
    first.unmount();

    engine('complete');
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    withClient(<Probe contentId="ch1" />, client);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('idle'));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['content-detail', 'ch1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-chapters', 'p1'] });
  });
});
