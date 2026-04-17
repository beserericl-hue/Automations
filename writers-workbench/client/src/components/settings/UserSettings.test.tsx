import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import UserSettings from './UserSettings';

describe('UserSettings', () => {
  it('renders without crashing (no infinite loop)', () => {
    renderWithProviders(<UserSettings />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows profile section', () => {
    renderWithProviders(<UserSettings />);
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });

  it('shows email delivery section', () => {
    renderWithProviders(<UserSettings />);
    expect(screen.getByText('Email Delivery')).toBeInTheDocument();
  });

  it('shows password change section', () => {
    renderWithProviders(<UserSettings />);
    expect(screen.getByText('Change Password')).toBeInTheDocument();
  });

  it('shows save button', () => {
    renderWithProviders(<UserSettings />);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });
});
