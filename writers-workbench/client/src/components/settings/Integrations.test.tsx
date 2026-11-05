/**
 * Settings → Integrations: secrets are shown masked (set / last4 only), a new key is sent once and
 * the box is cleared, and impersonation locks every control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import Integrations from './Integrations';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const DATA = {
  encryption_ready: true,
  read_only: false,
  blotato: {
    key: { set: true, last4: 'ab12', updated_at: '2026-11-02T10:00:00Z' },
    synced_at: '2026-11-05T10:00:00Z',
    accounts: [
      { target_id: 'linkedin:9115:109837978', platform: 'linkedin', account_id: '9115', account_name: 'Eric Beser', page_id: '109837978', page_name: 'Agile Ad Testing', board_id: null, label: 'LinkedIn · Agile Ad Testing', needs: 'text' },
      { target_id: 'threads:3949', platform: 'threads', account_id: '3949', account_name: 'ericb', page_id: null, page_name: null, board_id: null, label: 'Threads · ericb', needs: 'text' },
      { target_id: 'instagram:22242', platform: 'instagram', account_id: '22242', account_name: 'ericb', page_id: null, page_name: null, board_id: null, label: 'Instagram · ericb', needs: 'image' },
      { target_id: 'youtube:19905', platform: 'youtube', account_id: '19905', account_name: 'Eric Beser', page_id: null, page_name: null, board_id: null, label: 'YouTube · Eric Beser', needs: 'video' },
    ],
  },
  social: [
    { channel: 'li_agile', kind: 'linkedin', label: 'Agile page', enabled: true, account_id: '9115', page_id: '109837978', board_id: null, target_id: 'linkedin:9115:109837978', needs: 'text' },
    { channel: 'li_old', kind: 'linkedin', label: 'Old page', enabled: true, account_id: null, page_id: '1', board_id: null, target_id: null, needs: 'text' },
  ],
  websites: [
    {
      channel: 'website', label: 'TechAhir website', endpoint: 'https://www.techahir.com/api/blog', auth_header: 'Authorization',
      public_base: 'https://www.techahir.com/blog/', author: 'Tech Ahir', enabled: true, token: { set: false, last4: null, updated_at: null },
    },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
});

function serve(data: unknown = DATA) {
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/api/integrations') return { success: true, data } as never;
    return { success: true } as never;
  });
}

describe('Integrations', () => {
  it('shows secret status masked, never a value', async () => {
    serve();
    renderWithProviders(<Integrations />);
    expect(await screen.findByTestId('blotato-key-status')).toHaveTextContent('Set · ends ••••ab12');
    expect(screen.getByTestId('web-token-status-website')).toHaveTextContent('Not set');
    expect(screen.getByTestId('blotato-api-key')).toHaveValue('');
    expect(screen.getByTestId('blotato-api-key')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('target-linkedin:9115:109837978')).toHaveTextContent('page 109837978');
    expect(screen.queryByLabelText(/account id/i)).toBeNull(); // nothing to type: the ids are read from the key
  });

  it('lists every place on the key with a switch, on for the ones that are channels', async () => {
    serve();
    renderWithProviders(<Integrations />);
    expect(await screen.findByTestId('target-switch-linkedin:9115:109837978')).toBeChecked();
    expect(screen.getByTestId('target-switch-threads:3949')).not.toBeChecked();
    expect(screen.getByTestId('target-instagram:22242')).toHaveTextContent('needs an image');
    expect(screen.getByTestId('target-switch-youtube:19905')).toBeDisabled();
    expect(screen.getByTestId('target-youtube:19905')).toHaveTextContent('video only');
    expect(screen.getByTestId('social-row-li_old')).toHaveTextContent('Old page'); // a hand-made channel, still listed
  });

  it('switching a place on asks the server for a channel, nothing typed', async () => {
    serve();
    renderWithProviders(<Integrations />);
    fireEvent.click(await screen.findByTestId('target-switch-threads:3949'));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/integrations/blotato/targets', {
        method: 'POST',
        body: JSON.stringify({ target_id: 'threads:3949', enabled: true }),
      }),
    );
  });

  it('sends a new key once and clears the box', async () => {
    serve();
    renderWithProviders(<Integrations />);
    fireEvent.change(await screen.findByTestId('blotato-api-key'), { target: { value: 'new-blotato-key-123456' } });
    fireEvent.click(screen.getByTestId('blotato-save'));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/integrations/blotato', {
        method: 'PUT',
        body: JSON.stringify({ api_key: 'new-blotato-key-123456' }),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('blotato-api-key')).toHaveValue(''));
  });

  it('locks every control while impersonating', async () => {
    serve({ ...DATA, read_only: true });
    renderWithProviders(<Integrations />);
    expect(await screen.findByTestId('integrations-read-only')).toBeInTheDocument();
    for (const id of ['blotato-save', 'blotato-test', 'web-add', 'web-test-website', 'target-switch-threads:3949', 'social-remove-li_old']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
  });

  it('warns when the server cannot store secrets', async () => {
    serve({ ...DATA, encryption_ready: false });
    renderWithProviders(<Integrations />);
    expect(await screen.findByTestId('integrations-encryption-warning')).toBeInTheDocument();
  });
});
