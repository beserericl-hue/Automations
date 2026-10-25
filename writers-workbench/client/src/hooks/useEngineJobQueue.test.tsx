/**
 * A queued engine job outlives the panel that started it.
 *
 * Found in use: "Rewrite to fix Q/A" was queued, the author switched to the Review tab and back, and
 * the Q/A panel had remounted with no memory of the job. The button looked idle, and nothing
 * refetched the chapter or its versions when the rewrite finished, so the saved version never showed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEngineJobQueue } from './useEngineJobQueue';

function Probe({ scope, start }: { scope: string; start?: boolean }) {
  const q = useEngineJobQueue('u1', scope);
  return (
    <div>
      <span data-testid="state">{q.stateOf('qa-fix') ?? 'idle'}</span>
      {start ? (
        <button onClick={() => q.trackJob('qa-fix', 'job-1', [['content-detail', scope], ['content-versions', scope]])}>start</button>
      ) : null}
    </div>
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function withClient(ui: React.ReactElement, client = new QueryClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

describe('engine jobs outlive the panel that started them', () => {
  it('a remounted panel still shows the job as queued', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'running' }))) as typeof fetch;
    const first = withClient(<Probe scope="c1" start />);
    await act(async () => screen.getByText('start').click());
    expect(screen.getByTestId('state')).toHaveTextContent('queued');

    first.unmount(); // the author switches tabs
    withClient(<Probe scope="c1" />);
    expect(screen.getByTestId('state')).toHaveTextContent('queued');
  });

  it('is scoped: the same key on another chapter is a different job', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'running' }))) as typeof fetch;
    withClient(<Probe scope="c1" start />);
    await act(async () => screen.getByText('start').click());
    const other = withClient(<Probe scope="c2" />);
    expect(other.getAllByTestId('state').at(-1)).toHaveTextContent('idle');
  });

  it('refreshes the chapter and its versions when the job completes, even after a remount', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'running' }))) as typeof fetch;
    const first = withClient(<Probe scope="c1" start />);
    await act(async () => screen.getByText('start').click());
    first.unmount();

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'complete' }))) as typeof fetch;
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    withClient(<Probe scope="c1" />, client);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('idle'));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['content-detail', 'c1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['content-versions', 'c1'] });
  });
});
