import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import VersionHistory from './VersionHistory';

/**
 * Sprint 1 QA Tests — S1-5: Version History Viewer
 *
 * It is shown inside the Versions tab, which is its open/close, so it renders open: no "History"
 * button to click first and no Close of its own.
 */
describe('S1-5: Version History Viewer', () => {
  const defaultProps = {
    contentId: 'test-content-id',
    onRestore: vi.fn(),
  };

  it('QA: renders the version panel straight away', () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    expect(screen.getByText('Version History')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('QA: shows the empty state when there are no versions', async () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    expect(await screen.findByText(/No version history yet/i)).toBeInTheDocument();
  });
});
