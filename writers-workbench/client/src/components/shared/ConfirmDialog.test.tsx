import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog';

/**
 * Sprint 1 QA Tests — S1-6: ConfirmDialog component
 */
describe('S1-6: ConfirmDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Delete Item',
    message: 'Are you sure you want to delete this?',
  };

  it('QA: renders title and message when open', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
  });

  it('QA: does not render when closed', () => {
    render(<ConfirmDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Delete Item')).not.toBeInTheDocument();
  });

  it('QA: confirm button triggers onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} confirmLabel="Delete" />);
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('QA: cancel button triggers onClose', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('QA: Escape key triggers onClose', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('QA: displays cascade info when provided', () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        cascadeInfo={['5 version history entries will be deleted', '3 story bible entries will be deleted']}
      />
    );
    expect(screen.getByText('This will also affect:')).toBeInTheDocument();
    expect(screen.getByText('5 version history entries will be deleted')).toBeInTheDocument();
    expect(screen.getByText('3 story bible entries will be deleted')).toBeInTheDocument();
  });

  it('QA: does not show cascade section when no cascade info', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.queryByText('This will also affect:')).not.toBeInTheDocument();
  });

  it('QA: has role="dialog" and aria-modal for accessibility', () => {
    render(<ConfirmDialog {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('QA: shows custom confirm and cancel labels', () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="Yes, Delete"
        cancelLabel="No, Keep It"
      />
    );
    expect(screen.getByText('Yes, Delete')).toBeInTheDocument();
    expect(screen.getByText('No, Keep It')).toBeInTheDocument();
  });

  it('QA: shows "Processing..." when loading', () => {
    render(<ConfirmDialog {...defaultProps} loading={true} confirmLabel="Delete" />);
    expect(screen.getByText('Processing...')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('QA: danger variant applies red styling to confirm button', () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" confirmLabel="Delete" />);
    const confirmBtn = screen.getByText('Delete');
    expect(confirmBtn.className).toContain('bg-red-600');
  });

  it('QA: warning variant applies yellow styling', () => {
    render(<ConfirmDialog {...defaultProps} variant="warning" confirmLabel="Confirm" />);
    const confirmBtn = screen.getByText('Confirm');
    expect(confirmBtn.className).toContain('bg-yellow-600');
  });

  it('QA: backdrop click triggers onClose', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog {...defaultProps} onClose={onClose} />);
    // The backdrop is the first fixed overlay div
    const backdrops = document.querySelectorAll('.fixed.inset-0');
    // Click the backdrop (first overlay)
    fireEvent.click(backdrops[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('QA: uses custom modal instead of window.confirm', () => {
    // This test verifies the ConfirmDialog is a React component rendering to DOM,
    // NOT a browser native dialog
    render(<ConfirmDialog {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    // Custom modal has specific Tailwind classes, not a native <dialog> element
    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('z-50');
  });
});
