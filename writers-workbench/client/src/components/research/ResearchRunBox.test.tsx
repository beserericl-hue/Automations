import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import ResearchRunBox from './ResearchRunBox';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn(async () => ({ jobId: 'j1' })) }));

describe('ResearchRunBox', () => {
  it('starts research on the typed topic for the project, and shows it running', async () => {
    renderWithProviders(<ResearchRunBox userId="u1" projectId="p1" invalidate={[['project-research', 'p1']]} />);
    fireEvent.change(screen.getByLabelText('Research topic'), { target: { value: 'Piscataway burial practice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Research this' }));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/research/run', {
        method: 'POST',
        body: JSON.stringify({ topic: 'Piscataway burial practice', project_id: 'p1' }),
      }),
    );
    expect(await screen.findByRole('button', { name: /Researching/ })).toBeDisabled();
  });
});
