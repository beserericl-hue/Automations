import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import SocialFromContent from './SocialFromContent';

const apiFetch = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

beforeEach(() => apiFetch.mockReset().mockResolvedValue({ jobId: 'j1' }));

describe('SocialFromContent', () => {
  it('asks for the platforms, then posts this piece to the content social route', async () => {
    renderWithProviders(<SocialFromContent contentId="c1" projectId="p1" userId="u1" />);
    fireEvent.click(screen.getByTestId('social-from-content'));
    fireEvent.click(screen.getByLabelText('Facebook'));
    fireEvent.click(screen.getByLabelText('X'));
    fireEvent.click(screen.getByRole('button', { name: 'Write 2 posts' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/content/c1/social');
    expect(JSON.parse(String(init.body))).toEqual({ platforms: ['linkedin', 'facebook'] });
  });

  it('cannot send with no platform ticked', () => {
    renderWithProviders(<SocialFromContent contentId="c1" userId="u1" />);
    fireEvent.click(screen.getByTestId('social-from-content'));
    fireEvent.click(screen.getByLabelText('X'));
    fireEvent.click(screen.getByLabelText('LinkedIn'));
    expect(screen.getByRole('button', { name: 'Write 0 posts' })).toBeDisabled();
  });
});
