import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import Dashboard from './Dashboard';

describe('Dashboard', () => {
  it('renders without crashing', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/Welcome back/)).toBeInTheDocument();
  });

  it('shows stat cards', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Drafts')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('shows recent activity section', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
  });
});
