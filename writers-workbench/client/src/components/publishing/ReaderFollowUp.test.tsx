/**
 * Buy link and reader email: nothing goes to the list before the author has seen a test, and the
 * real send asks once more.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import ReaderFollowUp from './ReaderFollowUp';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const posts = (suffix: string) =>
  mockFetch.mock.calls
    .filter(([p, o]) => String(p).endsWith(suffix) && ['POST', 'PUT'].includes(String((o as { method?: string })?.method)))
    .map(([, o]) => JSON.parse(String((o as { body: string }).body)));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (_p, o) => {
    const body = JSON.parse(String((o as { body?: string })?.body ?? '{}'));
    if (body.test) return { success: true, data: { test: true, to: 'me@example.com', ok: true } } as never;
    return { success: true, data: { recipients: 2, sent: 2, failed: 0 } } as never;
  });
});

const render = () =>
  renderWithProviders(
    <ReaderFollowUp projectId="p1" published subscribed={2} buy={null} mailings={[{ id: 'm1', subject: 'Earlier', recipients: 3, sent: 3, failed: 0, created_at: '2026-10-20T00:00:00Z' }]} queryKey={['landing-page', 'p1']} />,
  );

describe('ReaderFollowUp', () => {
  it('saves a buy link with its label', async () => {
    render();
    fireEvent.change(screen.getByLabelText('Buy link'), { target: { value: 'https://shop.example.com/o' } });
    fireEvent.change(screen.getByLabelText('Button label'), { target: { value: 'Get the book' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save buy link' }));
    await waitFor(() => expect(posts('/buy-link')).toEqual([{ url: 'https://shop.example.com/o', label: 'Get the book' }]));
  });

  it('will not send to the list until a test has gone to the author, and then asks once more', async () => {
    render();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'It is out' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'The book is out.' } });
    expect(screen.getByRole('button', { name: 'Send to 2 people' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to 2 people' })).toBeEnabled());
    expect(posts('/mailings')).toEqual([{ subject: 'It is out', body: 'The book is out.', test: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 people' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send to 2' }));
    await waitFor(() => expect(posts('/mailings')[1]).toEqual({ subject: 'It is out', body: 'The book is out.', test: false }));
  });

  it('editing the message after a test locks the send again', async () => {
    render();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to 2 people' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'b, changed' } });
    expect(screen.getByRole('button', { name: 'Send to 2 people' })).toBeDisabled();
  });

  it('lists what was sent before', () => {
    render();
    expect(screen.getByTestId('mailings')).toHaveTextContent('Earlier');
    expect(screen.getByTestId('mailings')).toHaveTextContent('3 of 3 sent');
  });
});
