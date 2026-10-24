/**
 * The Sources tab shows its sources straight away. It used to open onto a collapsed "Sources"
 * toggle that had to be clicked a second time before anything appeared.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ProvenancePanel from './ProvenancePanel';

vi.mock('../../contexts/UserContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: 'u1' }, isImpersonating: false }),
}));

describe('ProvenancePanel', () => {
  it('shows the empty state without a second click', async () => {
    renderWithProviders(<ProvenancePanel contentId="c1" />);
    expect(await screen.findByText('No sources tracked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sources/ })).not.toBeInTheDocument();
  });
});
