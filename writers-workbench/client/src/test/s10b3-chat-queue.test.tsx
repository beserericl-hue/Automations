/**
 * S10b-3 — ChatDrawer async dispatch UI.
 *
 * Renders the drawer, stubs fetch so /api/chat/proxy returns an async
 * acknowledgement, and asserts that:
 *   1. The drawer shows a "Queued" badge on the assistant message.
 *   2. A `chat-job-status` window event flips the badge to Processing,
 *      then Complete, via the SSE forwarder flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders, screen, fireEvent, waitFor } from './test-utils';
import ChatDrawer from '../components/chat/ChatDrawer';

vi.mock('../contexts/UserContext', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useUser: () => ({ profile: { user_id: '+14105551234', display_name: 'Test User' } }),
  };
});

// The global test setup (setup.ts) already mocks ../config/supabase with
// a chain-capable stub + the auth methods AuthProvider needs. We only
// have to override getSession so the fetch call carries a bearer token.
vi.mock('../config/supabase', async () => {
  const mod = (await vi.importActual('../config/supabase')) as { supabase: { auth: Record<string, unknown> } };
  (mod.supabase.auth as Record<string, unknown>).getSession = () =>
    Promise.resolve({ data: { session: { access_token: 'fake-token' } } });
  return mod;
});

const originalFetch = globalThis.fetch;

// jsdom in this vitest config doesn't expose a working localStorage — stub
// one so ChatDrawer's setItem/getItem calls don't throw.
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
}

beforeEach(() => {
  installLocalStorageStub();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockAsyncProxyResponse() {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        mode: 'async',
        jobId: 'bull-42',
        status: 'queued',
        classification: { tier: 'heavy', queue: 'heavy-ops', jobType: 'write_chapter' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
}

describe('S10b-3: ChatDrawer async queue dispatch', () => {
  it('shows "Queued" badge after async response', async () => {
    mockAsyncProxyResponse();
    renderWithProviders(<ChatDrawer open={true} onClose={() => {}} />);

    const textarea = screen.getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Write chapter 3 of Dust' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Queued')).toBeTruthy());
    expect(screen.getByText('write_chapter')).toBeTruthy();
  });

  it('flips Queued → Processing → Complete on job-status events', async () => {
    mockAsyncProxyResponse();
    renderWithProviders(<ChatDrawer open={true} onClose={() => {}} />);

    const textarea = screen.getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Write chapter 3' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Queued')).toBeTruthy());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat-job-status', { detail: { jobId: 'bull-42', status: 'active' } }),
      );
    });
    await waitFor(() => expect(screen.getByText('Processing')).toBeTruthy());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat-job-status', { detail: { jobId: 'bull-42', status: 'completed' } }),
      );
    });
    await waitFor(() => expect(screen.getByText('Complete')).toBeTruthy());
  });

  it('renders sync response body inline (no badge)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          mode: 'sync',
          classification: { tier: 'sync', queue: 'sync-ops', jobType: 'list_content' },
          data: { output: 'Here are your projects: Dust, Hollow' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    renderWithProviders(<ChatDrawer open={true} onClose={() => {}} />);

    const textarea = screen.getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'list my projects' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/Dust, Hollow/)).toBeTruthy());
    expect(screen.queryByText('Queued')).toBeNull();
  });
});
