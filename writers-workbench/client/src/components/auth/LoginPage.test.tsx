import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import LoginPage from './LoginPage';

describe('LoginPage', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByText('The Writers Workbench')).toBeInTheDocument();
    });
  });

  it('shows email and password fields', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  it('shows sign in button', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });
  });

  it('shows forgot password link', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByText('Forgot password?')).toBeInTheDocument();
    });
  });
});
