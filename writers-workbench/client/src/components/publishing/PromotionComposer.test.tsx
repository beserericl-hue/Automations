/**
 * Writing social and blog posts about a book.
 *
 * Both already worked in the engine and neither had a way in: the Social tab listed results and
 * told you to use the chat, and the blog writer had no screen at all. What is asserted here is the
 * request that goes out — a composer that collects a platform and a topic and then sends neither is
 * the same dead end with more buttons on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import PromotionComposer from './PromotionComposer';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);
const ABOUT = 'Four ossuaries. A thousand people. No names.';

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ jobId: 'job-1' } as never);
});

function sentTo(suffix: string) {
  const call = mockFetch.mock.calls.find(([p]) => String(p).endsWith(suffix));
  expect(call, `no request to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
}

function render(defaultAbout?: string) {
  renderWithProviders(
    <PromotionComposer
      projectId="p1"
      projectTitle="The Ossuary"
      userId="u1"
      defaultAbout={defaultAbout}
    />,
  );
}

describe('social posts', () => {
  it('sends the chosen platforms', async () => {
    render(ABOUT);
    fireEvent.click(screen.getByRole('button', { name: 'Facebook' }));
    fireEvent.click(screen.getByRole('button', { name: /^Write 3 posts$/ }));
    await waitFor(() => expect(sentTo('/social').platforms).toEqual(['twitter', 'linkedin', 'facebook']));
  });

  it('deselects a platform that was on, and counts what is left', async () => {
    render(ABOUT);
    fireEvent.click(screen.getByRole('button', { name: 'X / Twitter' }));
    fireEvent.click(screen.getByRole('button', { name: /^Write 1 post$/ }));
    await waitFor(() => expect(sentTo('/social').platforms).toEqual(['linkedin']));
  });

  it('will not write with no platform selected', async () => {
    render(ABOUT);
    fireEvent.click(screen.getByRole('button', { name: 'X / Twitter' }));
    fireEvent.click(screen.getByRole('button', { name: 'LinkedIn' }));
    expect(screen.getByRole('button', { name: /^Write 0 posts$/ })).toBeDisabled();
  });

  it("falls back to the book's own copy when no angle is given", async () => {
    render(ABOUT);
    fireEvent.click(screen.getByRole('button', { name: /^Write 2 posts$/ }));
    // `about` absent, so the server uses the hook and back cover and the post promises what the
    // listing promises.
    await waitFor(() => expect(sentTo('/social')).not.toHaveProperty('about'));
  });

  it('sends an angle when one is typed', async () => {
    render(ABOUT);
    fireEvent.change(screen.getByPlaceholderText(ABOUT.slice(0, 180)), {
      target: { value: 'Announcing the paperback on the 3rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Write 2 posts$/ }));
    await waitFor(() =>
      expect(sentTo('/social').about).toBe('Announcing the paperback on the 3rd'),
    );
  });

  it('says why it cannot proceed when there is no copy and no angle', () => {
    render(undefined);
    expect(screen.getByText(/a post written from a title alone is filler/i)).toBeInTheDocument();
  });
});

describe('blog posts', () => {
  it('refuses a topic too short to write from', () => {
    render(ABOUT);
    expect(screen.getByRole('button', { name: 'Write the blog post' })).toBeDisabled();
  });

  it('offers starting points drawn from the book, and uses one when clicked', async () => {
    render(ABOUT);
    fireEvent.click(screen.getByRole('button', { name: 'The research behind The Ossuary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write the blog post' }));
    await waitFor(() => expect(sentTo('/blog').topic).toBe('The research behind The Ossuary'));
  });

  it('sends keywords and length with the topic', async () => {
    render(ABOUT);
    fireEvent.change(screen.getByPlaceholderText('The research behind The Ossuary'), {
      target: { value: 'What the record gets wrong about the Piscataway' },
    });
    fireEvent.change(screen.getByPlaceholderText(/piscataway history/), {
      target: { value: 'nagpra, repatriation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write the blog post' }));
    await waitFor(() => {
      const body = sentTo('/blog');
      expect(body.topic).toBe('What the record gets wrong about the Piscataway');
      expect(body.keywords).toBe('nagpra, repatriation');
      expect(body.target_length).toBe(1500);
    });
  });

  it('clears the topic once the job is queued, so it is not sent twice', async () => {
    render(ABOUT);
    const box = screen.getByPlaceholderText('The research behind The Ossuary');
    fireEvent.change(box, { target: { value: 'Why I wrote this book at all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write the blog post' }));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });
});
