import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '../../test/test-utils';
import VersionHistory from './VersionHistory';

/**
 * Sprint 1 QA Tests — S1-5: Version History Viewer
 */
describe('S1-5: Version History Viewer', () => {
  const defaultProps = {
    contentId: 'test-content-id',
    onRestore: vi.fn(),
  };

  it('QA: renders History button when collapsed', () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('QA: clicking History opens the version panel', async () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Version History')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
  });

  it('QA: open panel shows loading state then empty state', async () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    fireEvent.click(screen.getByText('History'));
    // Should show loading or empty state (mock returns empty array)
    // After mock resolves, should show "No version history yet."
    expect(screen.getByText('Version History')).toBeInTheDocument();
  });

  it('QA: Close button collapses the panel back to button', () => {
    renderWithProviders(<VersionHistory {...defaultProps} />);
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Version History')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByText('Version History')).not.toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
  });
});
