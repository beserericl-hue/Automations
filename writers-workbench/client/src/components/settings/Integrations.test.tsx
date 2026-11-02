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
  blotato: { account_id: '9115', key: { set: true, last4: 'ab12', updated_at: '2026-11-02T10:00:00Z' } },
  linkedin: [{ channel: 'li_agile', label: 'Agile page', page_id: '109837978', account_override: null, enabled: true }],
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
    expect(screen.getByTestId('li-row-li_agile')).toHaveTextContent('company page 109837978');
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
    for (const id of ['blotato-save', 'blotato-test', 'li-add', 'web-add', 'web-test-website', 'li-remove-li_agile']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
  });

  it('warns when the server cannot store secrets', async () => {
    serve({ ...DATA, encryption_ready: false });
    renderWithProviders(<Integrations />);
    expect(await screen.findByTestId('integrations-encryption-warning')).toBeInTheDocument();
  });
});
