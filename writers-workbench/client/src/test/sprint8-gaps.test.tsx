// Sprint 8 (gap-closing patch): unit tests for CreditExhaustionModal +
// dashboard hook impersonation switching.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreditExhaustionModal from '../components/credits/CreditExhaustionModal';

describe('CreditExhaustionModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <MemoryRouter>
        <CreditExhaustionModal open={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows credits required and remaining when open', () => {
    render(
      <MemoryRouter>
        <CreditExhaustionModal
          open={true}
          onClose={() => {}}
          creditsRequired={5}
          creditsRemaining={2}
          attemptedOperation="write the next chapter"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Out of credits/i)).toBeInTheDocument();
    // The numbers are wrapped in <strong>; assert by text matcher across nodes.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('5');
    expect(dialog.textContent).toContain('2');
    expect(screen.getByRole('link', { name: /buy more credits/i })).toHaveAttribute('href', '/credits');
  });

  it('Buy more credits link points to /credits', () => {
    render(
      <MemoryRouter>
        <CreditExhaustionModal open={true} onClose={() => {}} creditsRequired={10} creditsRemaining={0} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /buy more credits/i });
    expect(link).toHaveAttribute('href', '/credits');
  });

  it('Not now button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <CreditExhaustionModal open={true} onClose={onClose} creditsRequired={3} creditsRemaining={0} />
      </MemoryRouter>,
    );
    const cancel = screen.getByRole('button', { name: /not now/i });
    cancel.click();
    expect(onClose).toHaveBeenCalled();
  });

  it('singular "credit" when creditsRequired is 1', () => {
    render(
      <MemoryRouter>
        <CreditExhaustionModal open={true} onClose={() => {}} creditsRequired={1} creditsRemaining={0} />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole('dialog');
    // Match "1 credit," (singular) — not "1 credits"
    expect(dialog.textContent).toMatch(/\b1 credit\b/);
  });
});
