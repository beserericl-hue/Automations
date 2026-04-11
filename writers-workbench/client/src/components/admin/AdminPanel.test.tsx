import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import AdminPanel from './AdminPanel';

describe('AdminPanel', () => {
  it('renders without crashing', () => {
    renderWithProviders(<AdminPanel />);
    // Non-admin user sees access denied
    expect(screen.getByText('You do not have admin access.')).toBeInTheDocument();
  });
});
